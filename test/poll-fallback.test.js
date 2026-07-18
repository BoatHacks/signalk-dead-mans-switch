const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

const PATH = 'notifications.security.deadmansswitch'
const POLL_INTERVAL_MS = 2000

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

test('a change that never reaches the delta bus is still caught by the next poll', (t) => {
  // Simulates exactly the real-world gap this fallback exists for: the
  // server's stored value changes (e.g. via SignalK's v2 Notifications
  // API acknowledge action, or a delta from a non-preferred source that
  // gets filtered out of the delta chain) without ever notifying our
  // streambundle subscription.
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  app._setPathValueWithoutBusEvent(PATH, {
    state: 'alert',
    method: [],
    status: { acknowledged: true },
  })

  // Nothing should have changed yet - the poll hasn't ticked.
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  t.mock.timers.tick(POLL_INTERVAL_MS)

  assert.equal(app.lastValueFor(PATH).state, 'normal')
  assert.equal(app.lastValueFor(PATH).message, 'armed')
})

test('the poll is a no-op when nothing has changed since the last reconciliation', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  const countBefore = app._messages.length

  t.mock.timers.tick(POLL_INTERVAL_MS) // poll ticks, but nothing external changed
  t.mock.timers.tick(POLL_INTERVAL_MS)
  t.mock.timers.tick(POLL_INTERVAL_MS)

  assert.equal(app._messages.length, countBefore, 'no spurious re-publishes from polling our own settled state')
  assert.equal(app.lastValueFor(PATH).state, 'alert', 'still alert - the poll must not have reset the escalation timer')
})

test('the poll does not reset an in-progress escalation timer (regression: naive re-reconciliation would loop the timer forever)', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert (30s ackWindow)
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  // Let several poll cycles pass without ever changing the external value -
  // if polling incorrectly re-ran full reconciliation every tick, the
  // escalation would never actually elapse because each poll would
  // re-trigger escalateTo() and restart the 30s window.
  t.mock.timers.tick(POLL_INTERVAL_MS)
  t.mock.timers.tick(POLL_INTERVAL_MS)
  t.mock.timers.tick(POLL_INTERVAL_MS)
  t.mock.timers.tick(POLL_INTERVAL_MS)
  // Total elapsed since "alert": 4 * 2000ms = 8000ms, still under 30s.
  assert.equal(app.lastValueFor(PATH).state, 'alert')

  t.mock.timers.tick(30_000 - 8_000) // finish out the real ackWindowSeconds
  assert.equal(app.lastValueFor(PATH).state, 'warn', 'the real escalation timer must still fire on schedule')
})

test('an explicit external null (clear) picked up by the poll is treated as an acknowledgement', (t) => {
  const { app } = setup(t)
  t.mock.timers.tick(60_000) // -> alert
  app._setPathValueWithoutBusEvent(PATH, null)
  t.mock.timers.tick(POLL_INTERVAL_MS)

  assert.equal(app.lastValueFor(PATH).message, 'armed')
})

test('poll is skipped entirely while disarmed', (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  router.call('post', '/disarm', {})
  const countBefore = app._messages.length

  app._setPathValueWithoutBusEvent(PATH, { state: 'emergency', method: ['visual', 'sound'] })
  t.mock.timers.tick(POLL_INTERVAL_MS)

  assert.equal(app._messages.length, countBefore, 'no reaction while disarmed')
  assert.equal(app.lastValueFor(PATH).message, 'disarmed')
})

test('poll timer is cleared on stop (no lingering interval)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1 })
  plugin.stop()

  const countBefore = app._messages.length
  app._setPathValueWithoutBusEvent(PATH, { state: 'alert', method: [] })
  t.mock.timers.tick(POLL_INTERVAL_MS * 5)

  assert.equal(app._messages.length, countBefore, 'no poll activity after stop')
})

test('polling is skipped gracefully if the host does not provide app.getSelfPath', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  delete app.getSelfPath
  const plugin = buildPlugin(app)
  assert.doesNotThrow(() => plugin.start({ checkIntervalMinutes: 1 }))
  t.after(() => plugin.stop())
  t.mock.timers.tick(POLL_INTERVAL_MS * 3) // should not throw even with time passing
})
