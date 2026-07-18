const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

// Renders a captured app.debug(...args) call the same way console.log
// would join it, for substring assertions.
function render(call) {
  return call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

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

test('debug output goes through app.debug(), not a plugin-specific config option', (t) => {
  // Debug logging is switched via SignalK's standard per-plugin facility
  // (server admin UI / DEBUG env), not a checkbox in this plugin's own
  // schema - so there is no "debug" property in plugin.schema at all,
  // and app.debug() is called unconditionally (the real server's
  // namespace gating decides whether anything is actually printed).
  const buildPluginFresh = require('../index.js')
  const app = makeFakeApp()
  const plugin = buildPluginFresh(app)
  assert.equal('debug' in (plugin.schema.properties || {}), false, 'plugin.schema should not define its own debug option')
})

test('app.debug() is called for state transitions, with the reason included', (t) => {
  const { app } = setup(t)
  app._debugCalls.length = 0 // clear startup noise
  t.mock.timers.tick(60_000) // armed -> alert

  const lines = app._debugCalls.map(render)
  assert.ok(
    lines.some((l) => l.includes('STATE') && l.includes('armed -> alert')),
    `expected a state-transition debug call, got: ${JSON.stringify(lines)}`
  )
})

test('app.debug() captures outgoing notifications (OUTPUT)', (t) => {
  const { app } = setup(t)
  app._debugCalls.length = 0
  t.mock.timers.tick(60_000) // -> alert

  const lines = app._debugCalls.map(render)
  assert.ok(
    lines.some((l) => l.includes('OUTPUT notification') && l.includes('"state":"alert"')),
    `expected an OUTPUT notification debug call for alert, got: ${JSON.stringify(lines)}`
  )
})

test('app.debug() captures REST inputs and outputs', (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  app._debugCalls.length = 0

  router.call('post', '/ack', {})

  const lines = app._debugCalls.map(render)
  assert.ok(lines.some((l) => l.includes('INPUT REST POST /ack')), `expected an input debug call, got: ${JSON.stringify(lines)}`)
  assert.ok(lines.some((l) => l.includes('OUTPUT REST POST /ack')), `expected an output debug call, got: ${JSON.stringify(lines)}`)
})

test('app.debug() captures received external deltas (INPUT), including ones treated as an acknowledgement', (t) => {
  const { app } = setup(t)
  app._debugCalls.length = 0

  app._emitExternalDelta(PATH, { state: 'alarm', method: ['visual', 'sound'] })

  const lines = app._debugCalls.map(render)
  assert.ok(
    lines.some((l) => l.includes('INPUT external delta')),
    `expected an external-delta input debug call, got: ${JSON.stringify(lines)}`
  )
  assert.ok(
    lines.some((l) => l.includes('STATE armed -> alarm') && l.includes('external stage write')),
    `expected the resulting state transition to be logged with its reason, got: ${JSON.stringify(lines)}`
  )
})

test('app.debug() notes when an external delta is ignored (disarmed)', (t) => {
  const { app, plugin } = setup(t)
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  router.call('post', '/disarm', {})

  app._debugCalls.length = 0
  app._emitExternalDelta(PATH, { state: 'emergency' })

  const lines = app._debugCalls.map(render)
  assert.ok(
    lines.some((l) => l.includes('ignored') && l.includes('disarmed')),
    `expected a debug call noting the delta was ignored while disarmed, got: ${JSON.stringify(lines)}`
  )
})

test('does not throw if app.debug is not provided by the host (older server or minimal test double)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const app = makeFakeApp()
  delete app.debug
  const plugin = buildPlugin(app)
  assert.doesNotThrow(() => plugin.start({ checkIntervalMinutes: 1 }))
  t.after(() => plugin.stop())
})
