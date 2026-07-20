const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10, ...opts })
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.after(() => plugin.stop())
  return { app, plugin, router }
}

test('GET /status reflects armed state with a countdown', (t) => {
  const { router } = setup(t)
  const res = router.call('get', '/status', undefined)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.body.state, 'armed')
  assert.equal(res.body.secondsRemaining, 60)
})

test('GET /status config.playSounds defaults to true when unset', (t) => {
  const { router } = setup(t)
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.config.playSounds, true)
})

test('GET /status config.playSounds reflects the configured value', (t) => {
  const { router } = setup(t, { playSounds: false })
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.config.playSounds, false)
})

test('GET /status reflects escalated stage and shrinking countdown', (t) => {
  const { router } = setup(t)
  t.mock.timers.tick(60_000) // -> alert, 30s window
  t.mock.timers.tick(10_000)
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'alert')
  assert.equal(res.body.secondsRemaining, 20)
})

test('GET /status has no countdown once emergency is reached', (t) => {
  const { router } = setup(t)
  t.mock.timers.tick(60_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(20_000)
  t.mock.timers.tick(10_000)
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'emergency')
  assert.equal(res.body.secondsRemaining, null)
})

test('POST /ack while disarmed is a no-op', (t) => {
  const { router } = setup(t)
  router.call('post', '/disarm', {})
  const res = router.call('post', '/ack', {})
  assert.equal(res.body.ok, false)
  assert.equal(res.body.state, 'disarmed')
})

test('POST /arm re-arms and returns the fresh countdown', (t) => {
  const { router } = setup(t)
  router.call('post', '/disarm', {})
  const res = router.call('post', '/arm', {})
  assert.equal(res.body.state, 'armed')
  assert.equal(res.body.secondsRemaining, 60)
})

test('getOpenApi() documents exactly the routes registerWithRouter exposes', (t) => {
  const { plugin } = setup(t)
  const spec = plugin.getOpenApi()
  assert.equal(spec.openapi, '3.0.3')
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/ack', '/arm', '/disarm', '/status'])
  assert.equal(spec.paths['/status'].get !== undefined, true)
  assert.equal(spec.paths['/ack'].post !== undefined, true)
  assert.equal(spec.paths['/arm'].post !== undefined, true)
  assert.equal(spec.paths['/disarm'].post !== undefined, true)
  // The API is mounted under /plugins/<id>, not at the SignalK API root -
  // per SignalK's documented convention, that means a `servers` entry is
  // required or the docs would present the wrong base path.
  assert.equal(spec.servers[0].url, '/plugins/signalk-dead-mans-switch')
})
