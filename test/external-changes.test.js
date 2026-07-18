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

const PATH = 'notifications.security.deadmansswitch'

test('subscribes to the notification path on start', (t) => {
  const { app } = setup(t)
  assert.equal(app._busSubscriberCount(PATH), 1)
})

test('unsubscribes on stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10 })
  assert.equal(app._busSubscriberCount(PATH), 1)
  plugin.stop()
  assert.equal(app._busSubscriberCount(PATH), 0)
})

test('an external write of a stage value snaps our state machine to that stage', (t) => {
  const { app } = setup(t)
  // Currently just "armed" - some other plugin pushes us straight to "alarm".
  app._emitExternalDelta(PATH, { state: 'alarm', message: 'external alarm' })
  assert.equal(app.lastValueFor(PATH).state, 'alarm')
})

test('GET /status reflects the externally-forced stage immediately (no polling delay)', (t) => {
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  app._emitExternalDelta(PATH, { state: 'warn' })
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'warn')
})

test('an externally-forced stage starts a fresh timer for that stage window', (t) => {
  const { app } = setup(t)
  app._emitExternalDelta(PATH, { state: 'warn' }) // warnWindowSeconds=20
  const countBefore = app._messages.length

  t.mock.timers.tick(19_000)
  assert.equal(app._messages.length, countBefore, 'should not have escalated yet')

  t.mock.timers.tick(1_000)
  assert.equal(app.lastValueFor(PATH).state, 'alarm', 'should escalate to alarm after the fresh 20s window')
})

test('external clear while armed/escalated is treated as an acknowledgement', (t) => {
  const { app } = setup(t)
  app._emitExternalDelta(PATH, { state: 'alert' })
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  app._emitExternalDelta(PATH, null)
  const value = app.lastValueFor(PATH)
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'armed', 'should reset to the resting armed notification, same as an ack')
})

test('external write of a non-stage state (e.g. "normal") is treated as an acknowledgement', (t) => {
  const { app } = setup(t)
  app._emitExternalDelta(PATH, { state: 'alarm' })
  assert.equal(app.lastValueFor(PATH).state, 'alarm')

  app._emitExternalDelta(PATH, { state: 'normal' })
  const value = app.lastValueFor(PATH)
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'armed', 'unrecognized/normal state should reset like an ack')
})

test('external changes are ignored entirely while disarmed', (t) => {
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  router.call('post', '/disarm', {})
  const countBefore = app._messages.length

  app._emitExternalDelta(PATH, { state: 'emergency' })

  assert.equal(app._messages.length, countBefore, 'no messages should be sent while disarmed')
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'disarmed', 'should remain disarmed, unaffected by the external write')
})

test('a delta we published ourselves is ignored (no self-triggered loop)', (t) => {
  const { app } = setup(t)
  const countBefore = app._messages.length

  // Simulates the server echoing our own handleMessage() call back through
  // the subscription, as it would over a real delta bus.
  app._emitExternalDelta(PATH, { state: 'emergency' }, 'signalk-dead-mans-switch')

  assert.equal(app._messages.length, countBefore, 'a self-sourced delta must not be reprocessed')
  const value = app.lastValueFor(PATH)
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'armed', 'should be unchanged (still just the resting armed notification)')
})

test('self-echo is caught by the reentrancy guard even when the source string does not match plugin.id', (t) => {
  // A real server's self-echo $source might not exactly match our
  // plugin.id assumption - this proves the synchronous reentrancy guard
  // (isPublishingOwnChange) catches our own writes regardless, as a
  // second line of defense independent of the source-string check.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { makeFakeApp } = require('../test-support/fake-app')
  const app = makeFakeApp({ echoSource: 'totally-different-source-string' })
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10 })
  t.after(() => plugin.stop())

  // Escalate normally, then acknowledge. If the mismatched-source echo of
  // our own clearNotification() call were misread as an external ack (or
  // worse, caused reentrant arm()/escalateTo() calls), the sequence of
  // published values or the final state would come out wrong.
  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  const res = router.call('post', '/ack', {})

  assert.equal(res.body.ok, true)
  assert.equal(res.body.state, 'armed', 'acknowledging must land on "armed", never "disarmed"')
  assert.equal(res.body.secondsRemaining, 60, 'timer must be the full configured interval, not partially consumed by reentrant calls')
  const value = app.lastValueFor(PATH)
  assert.equal(value.state, 'normal')
  assert.equal(value.message, 'armed')
})

test('acknowledging from any stage always results in "armed" with a full-length timer, never "disarmed"', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')

  for (const stage of ['alert', 'warn', 'alarm', 'emergency']) {
    const app = makeFakeApp()
    const plugin = buildPlugin(app)
    plugin.start({ checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10 })
    const router = makeFakeRouter()
    plugin.registerWithRouter(router)

    const stageIndex = plugin.__test__.STAGES.indexOf(stage)
    const windows = [30_000, 20_000, 10_000]
    t.mock.timers.tick(60_000) // -> alert
    for (let i = 0; i < stageIndex; i++) {
      t.mock.timers.tick(windows[i])
    }
    assert.equal(app.lastValueFor(PATH).state, stage)

    const res = router.call('post', '/ack', {})
    assert.equal(res.body.state, 'armed', `ack from ${stage} must result in "armed"`)
    assert.equal(res.body.secondsRemaining, 60, `ack from ${stage} must reset to the full configured interval`)
    plugin.stop()
  }
})

// SignalK's v2 Notifications API acknowledge action
// (POST /signalk/v2/api/notifications/{id}/acknowledge) - what clients
// like Freeboard's "Acknowledge" button actually call - does NOT clear
// the notification or change its state. Per spec it strips "sound" from
// the `method` array (and ONLY "sound" when state is "emergency" -
// "visual" stays). These tests simulate exactly that shape of delta.

test('a v2-API acknowledge (method loses "sound", state unchanged) is treated as an acknowledgement', (t) => {
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  // Same state, but "sound" has been stripped from method - this is what
  // a real server does in response to a v2 acknowledge request, NOT a
  // cleared value and NOT a state change.
  app._emitExternalDelta(PATH, { state: 'alert', method: ['visual'], message: 'Are you there?' })

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'armed', 'must reset all the way to armed, not just refresh the alert timer')
  assert.equal(res.body.secondsRemaining, 60)
})

test('a v2-API acknowledge from "emergency" (only "sound" removed, "visual" stays) is still treated as an acknowledgement', (t) => {
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  t.mock.timers.tick(60_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(20_000)
  t.mock.timers.tick(10_000)
  assert.equal(app.lastValueFor(PATH).state, 'emergency')

  // Per spec, emergency acknowledgement only strips "sound", leaving
  // "visual" in place - this must still count as an acknowledgement.
  app._emitExternalDelta(PATH, { state: 'emergency', method: ['visual'], message: 'Watch incapacitated!' })

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'armed')
})

test('a delta with "sound" still present in method is NOT treated as an acknowledgement (still matched as a stage write)', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  app._emitExternalDelta(PATH, { state: 'warn', method: ['visual', 'sound'] })
  assert.equal(app.lastValueFor(PATH).state, 'warn', 'sound still present - should be read as an external stage write, not an ack')
})

test('real-world captured payload: Freeboard acknowledging a "warn" notification resets to armed', (t) => {
  // Exact payload captured from a live SignalK server's notification value
  // after clicking "Acknowledge" in Freeboard on a warn-stage notification.
  // Note method is fully empty here (both visual AND sound stripped, not
  // just sound as the emergency-specific spec note might suggest) - our
  // detection (method no longer including "sound") still catches this.
  // Also note: the server's own `status.canSilence` came back `true` here
  // despite this plugin publishing `canSilence: false` in the raw value -
  // the v2 API computes `status.*` independently from `state`, ignoring
  // whatever the plugin puts in the value, so that field can flag intent
  // but can't actually force Freeboard's UI to hide a Silence option.
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.mock.timers.tick(60_000) // -> alert
  t.mock.timers.tick(30_000) // -> warn
  assert.equal(app.lastValueFor(PATH).state, 'warn')

  app._emitExternalDelta(PATH, {
    state: 'warn',
    message: 'Dead man\u2019s switch: still no acknowledgement. Escalating.',
    method: [],
    timestamp: '2026-07-18T17:42:02.185Z',
    canSilence: false,
    id: '6ccfa911-453f-4eb9-87dd-5af4d2f8393a',
  })

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'armed')
  assert.equal(res.body.secondsRemaining, 60)
})

test('real-world captured payload: Freeboard acknowledging an "alert" notification resets to armed', (t) => {
  // Second real capture, confirming the same behavior at the "alert"
  // stage (the first ever prompt) as well as "warn" above. Also confirms
  // again that the server's status.canSilence stays true regardless of
  // this plugin's own canSilence: false in the raw value - see the note
  // on the "warn" case above.
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  app._emitExternalDelta(PATH, {
    state: 'alert',
    message: 'Dead man\u2019s switch: are you still there? Acknowledge to reset the timer.',
    method: [],
    timestamp: '2026-07-18T17:54:01.342Z',
    canSilence: false,
    id: 'bcfb9657-31b5-4bf8-9ed2-35673121c7dd',
  })

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'armed')
  assert.equal(res.body.secondsRemaining, 60)
})

test('status.acknowledged: true is trusted directly as an acknowledgement, even if method still contained "sound"', (t) => {
  // Direct, most-authoritative signal a v2-API-capable server can give -
  // must be trusted on its own, not only as a tiebreaker alongside method.
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  app._emitExternalDelta(PATH, {
    state: 'alert',
    method: ['visual', 'sound'], // deliberately NOT stripped
    status: { silenced: false, acknowledged: true, canSilence: true, canAcknowledge: true, canClear: false },
  })

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'armed', 'status.acknowledged: true must be trusted regardless of method')
  assert.equal(res.body.secondsRemaining, 60)
})

test('real-world captured payload: status.acknowledged becomes true on a "warn" notification (same id, escalated from alert) and resets to armed', (t) => {
  // Exact payload sequence captured live: the plugin issued an "alert"
  // (id 2e604278-...), it auto-escalated to "warn" (same id - the
  // server's Notification Manager tracks one id per logical notification
  // across state transitions), and Freeboard's Acknowledge was clicked
  // while it was at "warn". status.canSilence is still true here too
  // (server-computed, unaffected by this plugin's status.canSilence: false
  // - see the note in escalation.test.js) but status.acknowledged is the
  // signal that actually matters, and it's true.
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.mock.timers.tick(60_000) // -> alert
  t.mock.timers.tick(30_000) // -> warn
  assert.equal(app.lastValueFor(PATH).state, 'warn')

  app._emitExternalDelta(PATH, {
    state: 'warn',
    message: 'Dead man\u2019s switch: still no acknowledgement. Escalating.',
    method: [],
    timestamp: '2026-07-18T18:32:11.248Z',
    status: { silenced: false, acknowledged: true, canSilence: true, canAcknowledge: true, canClear: false },
    id: '2e604278-df2c-4860-a5e2-493a4b5d7f85',
  })

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'armed')
  assert.equal(res.body.secondsRemaining, 60)
})

test('real-world captured payload: full auto-escalation to emergency, then acknowledged in Freeboard (method loses only "sound", "visual" stays)', (t) => {
  // Full lifecycle captured live: normal auto-escalation with no manual
  // intervention (alert -> warn -> alarm -> emergency, same notification
  // id throughout), then Freeboard's Acknowledge clicked at "emergency".
  // Confirms the emergency-specific spec behavior with real data: only
  // "sound" is stripped from method (unlike other stages, which lose
  // both) - "visual" stays - and status.acknowledged: true is present.
  const { app, plugin } = setup(t)
  const { makeFakeRouter } = require('../test-support/fake-app')
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.mock.timers.tick(60_000) // -> alert
  t.mock.timers.tick(30_000) // -> warn
  t.mock.timers.tick(20_000) // -> alarm
  t.mock.timers.tick(10_000) // -> emergency
  assert.equal(app.lastValueFor(PATH).state, 'emergency')

  app._emitExternalDelta(PATH, {
    state: 'emergency',
    message: 'Dead man\u2019s switch: watch incapacitated! No acknowledgement received.',
    method: ['visual'],
    timestamp: '2026-07-18T19:04:24.160Z',
    status: { silenced: false, acknowledged: true, canSilence: true, canAcknowledge: true, canClear: false },
    id: 'cf60f229-f080-494a-8941-3a1f740006cf',
  })

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'armed')
  assert.equal(res.body.secondsRemaining, 60)
})
