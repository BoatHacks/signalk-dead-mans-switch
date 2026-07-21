const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

const PROPERTY_VALUE_API_NAME = 'signalk-dead-mans-switch-api'

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10, ...opts })
  t.after(() => plugin.stop())
  return { app, plugin }
}

test('announces an API via emitPropertyValue on start, namespaced with the plugin id', (t) => {
  const { app } = setup(t)
  const api = app._lastPropertyValue(PROPERTY_VALUE_API_NAME)
  assert.ok(api, 'expected something to have been emitted')
  assert.equal(typeof api.ack, 'function')
  assert.equal(typeof api.arm, 'function')
  assert.equal(typeof api.disarm, 'function')
  assert.equal(typeof api.getStatus, 'function')
})

test('api.getStatus() matches live state, not a stale snapshot from emit time', (t) => {
  const { app } = setup(t)
  const api = app._lastPropertyValue(PROPERTY_VALUE_API_NAME)
  assert.equal(api.getStatus().state, 'armed')

  t.mock.timers.tick(60_000) // -> alert
  assert.equal(api.getStatus().state, 'alert', 'getStatus must read current state, not what it was when emitted')
})

test('api.ack() acknowledges exactly like POST /ack, including the false-while-disarmed case', (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  const api = app._lastPropertyValue(PROPERTY_VALUE_API_NAME)

  t.mock.timers.tick(60_000) // -> alert
  assert.equal(api.ack(), true)
  assert.equal(api.getStatus().state, 'armed')

  router.call('post', '/disarm', {})
  assert.equal(api.ack(), false, 'no-op while disarmed, same as REST')
})

test('api.arm() and api.disarm() work like their REST counterparts', (t) => {
  const { app } = setup(t)
  const api = app._lastPropertyValue(PROPERTY_VALUE_API_NAME)

  assert.equal(api.disarm(), true)
  assert.equal(api.getStatus().state, 'disarmed')

  assert.equal(api.arm(), true)
  assert.equal(api.getStatus().state, 'armed')
})

test('api calls accept an optional reason string for debug logging, without requiring one', (t) => {
  const { app } = setup(t)
  const api = app._lastPropertyValue(PROPERTY_VALUE_API_NAME)
  app._debugCalls.length = 0

  api.disarm('test-plugin requested a hold')

  const lines = app._debugCalls.map((call) => call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  assert.ok(
    lines.some((l) => l.includes('test-plugin requested a hold')),
    `expected the custom reason to appear in a debug log line, got: ${JSON.stringify(lines)}`
  )
})

test('does not throw if the host does not provide app.emitPropertyValue', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  delete app.emitPropertyValue
  const plugin = buildPlugin(app)
  assert.doesNotThrow(() => plugin.start({ checkIntervalMinutes: 1 }))
  t.after(() => plugin.stop())
})
