const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start({
    checkIntervalMinutes: 1,
    ackWindowSeconds: 30,
    warnWindowSeconds: 20,
    alarmWindowSeconds: 10,
    ...opts,
  })
  t.after(() => plugin.stop())
  return { app, plugin }
}

test('arms on start and publishes a resting "armed" notification, not an escalation', (t) => {
  const { app } = setup(t)
  const value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'armed')
})

test('raises "alert" once the check-in interval elapses', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000)
  const value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'alert')
})

test('published notifications always have status.canSilence: false - silencing alone must never count as a check-in, and no top-level canSilence field (not a valid SignalK notification field)', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000)
  const value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.status.canSilence, false)
  assert.equal(value.status.canAcknowledge, true)
  assert.equal('canSilence' in value, false)
})

test('escalates alert -> warn -> alarm -> emergency if never acknowledged', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // interval elapses -> alert
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alert')

  t.mock.timers.tick(30_000) // ackWindowSeconds elapses -> warn
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'warn')

  t.mock.timers.tick(20_000) // warnWindowSeconds elapses -> alarm
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alarm')

  t.mock.timers.tick(10_000) // alarmWindowSeconds elapses -> emergency
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'emergency')
})

test('emergency is terminal - no further escalation without an ack', (t) => {
  const { app } = setup(t)
  // Ticked sequentially (not as one combined jump) so each stage's own
  // setTimeout - scheduled during the previous tick's callback - is picked
  // up by mock timers, which don't cascade across a single large tick.
  t.mock.timers.tick(60_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(20_000)
  t.mock.timers.tick(10_000) // drive all the way to emergency
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'emergency')
  const countBefore = app._messages.length
  t.mock.timers.tick(10 * 60_000) // wait a long time
  assert.equal(app._messages.length, countBefore, 'no additional messages should be sent')
})

test('ack from "alert" resets to a resting "armed" notification and restarts the interval', (t) => {
  const { app, plugin } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alert')

  const acked = plugin.registerWithRouter
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  const res = router.call('post', '/ack', {})
  assert.equal(res.body.ok, true)
  let value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'armed')

  // Restarted interval: nothing new for just under a minute, then alert again.
  t.mock.timers.tick(59_000)
  value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.message, 'armed')
  t.mock.timers.tick(1_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alert')
})

test('ack from "emergency" resets to a resting "armed" notification rather than staying stuck', (t) => {
  const { app, plugin } = setup(t)
  t.mock.timers.tick(60_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(20_000)
  t.mock.timers.tick(10_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'emergency')

  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  router.call('post', '/ack', {})
  const value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'armed')
})

test('disarm stops escalation entirely until re-armed, publishing a resting "disarmed" notification', (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  router.call('post', '/disarm', {})
  let value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'disarmed')

  t.mock.timers.tick(10 * 60_000)
  value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.message, 'disarmed')

  router.call('post', '/arm', {})
  value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.message, 'armed')
  t.mock.timers.tick(60_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alert')
})

test('honors a custom notificationPath', (t) => {
  const { app } = setup(t, { notificationPath: 'navigation.watchAlive' })
  t.mock.timers.tick(60_000)
  assert.equal(app.lastValueFor('notifications.navigation.watchAlive').state, 'alert')
})

test('respects enabled: false on start (does not arm), and publishes a resting "disarmed" notification', (t) => {
  const { app } = setup(t, { enabled: false })
  t.mock.timers.tick(10 * 60_000)
  const value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'disarmed')
  assert.equal(app._statuses[app._statuses.length - 1], 'Disarmed')
})

test('a stale escalated notification left over from before a restart is replaced with a resting "disarmed" one when starting disabled', (t) => {
  // Simulates the actual scenario the fix targets: the plugin was mid-
  // escalation when the server restarted, and now starts up disabled
  // (e.g. reconfigured, or the config was already set that way) - the
  // leftover escalated notification must not be left hanging around
  // forever for a switch that is no longer managing it.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  app.handleMessage('some-other-source', {
    updates: [{ values: [{ path: 'notifications.security.deadmansswitch', value: { state: 'alarm' } }] }],
  })
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alarm')

  const plugin = buildPlugin(app)
  plugin.start({ enabled: false })
  t.after(() => plugin.stop())

  const value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'disarmed')
})
