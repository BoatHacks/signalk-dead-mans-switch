const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

const PATH = 'notifications.security.deadmansswitch'

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10, ...opts })
  t.after(() => plugin.stop())
  return { app, plugin }
}

test('registers a PUT handler on the notification path', (t) => {
  const { app } = setup(t)
  assert.equal(app._putHandlerCount(PATH), 1)
})

test('a PUT with a stage value escalates, exactly like an external delta', (t) => {
  const { app } = setup(t)
  const result = app._callPutHandler(PATH, { state: 'alarm', method: ['visual', 'sound'] })

  assert.deepEqual(result, { state: 'COMPLETED', statusCode: 200 })
  assert.equal(app.lastValueFor(PATH).state, 'alarm')
})

test('a PUT with status.acknowledged: true acknowledges, exactly like an external delta', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  const result = app._callPutHandler(PATH, { state: 'alert', method: [], status: { acknowledged: true } })

  assert.deepEqual(result, { state: 'COMPLETED', statusCode: 200 })
  assert.equal(app.lastValueFor(PATH).message, 'armed')
})

test('a PUT with no value at all (or a cleared one) acknowledges, same fallback as an external delta', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  const result = app._callPutHandler(PATH, null)

  assert.deepEqual(result, { state: 'COMPLETED', statusCode: 200 })
  assert.equal(app.lastValueFor(PATH).message, 'armed')
})

test('a PUT while disarmed is a no-op but still reports COMPLETED (not an error)', (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  router.call('post', '/disarm', {})
  const countBefore = app._messages.length

  const result = app._callPutHandler(PATH, { state: 'emergency' })

  assert.deepEqual(result, { state: 'COMPLETED', statusCode: 200 })
  assert.equal(app._messages.length, countBefore, 'no reaction while disarmed')
})

test('does not throw if the host does not provide app.registerPutHandler', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  delete app.registerPutHandler
  const plugin = buildPlugin(app)
  assert.doesNotThrow(() => plugin.start({ checkIntervalMinutes: 1 }))
  t.after(() => plugin.stop())
})
