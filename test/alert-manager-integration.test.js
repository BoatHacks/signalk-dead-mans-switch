const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

const DEFAULT_OPTS = { checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10 }

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp({ withAlertManager: true })
  const plugin = buildPlugin(app)
  plugin.start({ ...DEFAULT_OPTS, ...opts })
  t.after(() => plugin.stop())
  return { app, plugin }
}

// Give the fire-and-forget alert-manager promises a tick to settle before
// asserting on their recorded calls.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('does nothing at all when app.alertManager is not present', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp() // no withAlertManager
  const plugin = buildPlugin(app)
  assert.doesNotThrow(() => plugin.start(DEFAULT_OPTS))
  t.after(() => plugin.stop())
  t.mock.timers.tick(60_000) // -> alert, would call raiseAlert if it existed
  await settle()
  assert.equal(app.alertManager, undefined)
})

test('raises a "warning"-priority alert-manager alert on entering "alert"', async (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  await settle()

  assert.equal(app._alertManagerCalls.raiseAlert.length, 1)
  const call = app._alertManagerCalls.raiseAlert[0]
  assert.equal(call.priority, 'warning')
  assert.equal(call.path, 'security.deadmansswitch')
  assert.equal(call.latching, true)
})

test('"warn" also maps to "warning" priority (both are the "please respond" tier)', async (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  t.mock.timers.tick(30_000) // -> warn
  await settle()

  const calls = app._alertManagerCalls.raiseAlert
  assert.equal(calls[calls.length - 1].priority, 'warning')
})

test('"alarm" and "emergency" map to their matching alert-manager priorities', async (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(20_000) // -> alarm
  await settle()
  let calls = app._alertManagerCalls.raiseAlert
  assert.equal(calls[calls.length - 1].priority, 'alarm')

  t.mock.timers.tick(10_000) // -> emergency
  await settle()
  calls = app._alertManagerCalls.raiseAlert
  assert.equal(calls[calls.length - 1].priority, 'emergency')
})

test('acknowledges and clears the alert-manager alert when the switch is acknowledged', async (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  t.mock.timers.tick(60_000) // -> alert
  await settle()
  assert.equal(app._alertManagerCalls.raiseAlert.length, 1)
  const alertId = 'fake-alert-1'

  router.call('post', '/ack', {})
  await settle()

  assert.deepEqual(app._alertManagerCalls.acknowledgeAlert, [alertId])
  assert.deepEqual(app._alertManagerCalls.clearCondition, [alertId])
})

test('also resolves the alert-manager alert on disarm', async (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  t.mock.timers.tick(60_000) // -> alert
  await settle()

  router.call('post', '/disarm', {})
  await settle()

  assert.equal(app._alertManagerCalls.acknowledgeAlert.length, 1)
  assert.equal(app._alertManagerCalls.clearCondition.length, 1)
})

test('does not call acknowledge/clearCondition on ack if no alert-manager alert was ever raised (already armed)', async (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  router.call('post', '/ack', {}) // already armed - no-op reset, no alert was raised
  await settle()

  assert.equal(app._alertManagerCalls.acknowledgeAlert.length, 0)
  assert.equal(app._alertManagerCalls.clearCondition.length, 0)
})

test('does not throw if raiseAlert rejects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp({ withAlertManager: true })
  app.alertManager.raiseAlert = () => Promise.reject(new Error('boom'))
  const plugin = buildPlugin(app)
  plugin.start(DEFAULT_OPTS)
  t.after(() => plugin.stop())

  assert.doesNotThrow(() => t.mock.timers.tick(60_000))
  await settle()
})

test('uses the configured notificationPath (minus the "notifications." prefix) as the alert path', async (t) => {
  const { app } = setup(t, { notificationPath: 'navigation.watchAlive' })
  t.mock.timers.tick(60_000)
  await settle()

  assert.equal(app._alertManagerCalls.raiseAlert[0].path, 'navigation.watchAlive')
})
