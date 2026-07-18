const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
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

test('arms on start and does not raise an escalation notification immediately', (t) => {
  // arm() clears any stale notification as a matter of course (idempotent
  // whether or not one existed), so the "no value yet" case reads as null,
  // not undefined - but crucially it must not be an alert/warn/etc. state.
  const { app } = setup(t)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch'), null)
})

test('raises "alert" once the check-in interval elapses', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000)
  const value = app.lastValueFor('notifications.security.deadmansswitch')
  assert.equal(value.state, 'alert')
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

test('ack from "alert" clears the notification and restarts the interval', (t) => {
  const { app, plugin } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alert')

  const acked = plugin.registerWithRouter
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  const res = router.call('post', '/ack', {})
  assert.equal(res.body.ok, true)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch'), null)

  // Restarted interval: nothing new for just under a minute, then alert again.
  t.mock.timers.tick(59_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch'), null)
  t.mock.timers.tick(1_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alert')
})

test('ack from "emergency" clears and re-arms rather than staying stuck', (t) => {
  const { app, plugin } = setup(t)
  t.mock.timers.tick(60_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(20_000)
  t.mock.timers.tick(10_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'emergency')

  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  router.call('post', '/ack', {})
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch'), null)
})

test('disarm stops escalation entirely until re-armed', (t) => {
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  router.call('post', '/disarm', {})
  t.mock.timers.tick(10 * 60_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch'), null)

  router.call('post', '/arm', {})
  t.mock.timers.tick(60_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch').state, 'alert')
})

test('honors a custom notificationPath', (t) => {
  const { app } = setup(t, { notificationPath: 'navigation.watchAlive' })
  t.mock.timers.tick(60_000)
  assert.equal(app.lastValueFor('notifications.navigation.watchAlive').state, 'alert')
})

test('respects enabled: false on start (does not arm)', (t) => {
  const { app } = setup(t, { enabled: false })
  t.mock.timers.tick(10 * 60_000)
  assert.equal(app.lastValueFor('notifications.security.deadmansswitch'), undefined)
  assert.equal(app._statuses[app._statuses.length - 1], 'Disarmed')
})
