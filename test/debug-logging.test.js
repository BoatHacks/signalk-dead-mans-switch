const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

// Captures console.log calls for the duration of the test via node:test's
// built-in method mocking (auto-restored after the test), and returns the
// captured lines as an array of strings (args joined with a space, objects
// JSON-stringified) so assertions can just look for substrings.
function captureConsoleLog(t) {
  const calls = []
  t.mock.method(console, 'log', (...args) => {
    calls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  })
  return calls
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

test('debug logging is silent by default (debug unset)', (t) => {
  const calls = captureConsoleLog(t)
  setup(t)
  t.mock.timers.tick(60_000) // -> alert, would log plenty if enabled
  assert.equal(calls.length, 0, 'no console.log output should occur with debug unset')
})

test('debug: false explicitly is also silent', (t) => {
  const calls = captureConsoleLog(t)
  setup(t, { debug: false })
  t.mock.timers.tick(60_000)
  assert.equal(calls.length, 0)
})

test('debug: true logs state transitions', (t) => {
  const calls = captureConsoleLog(t)
  setup(t, { debug: true })
  t.mock.timers.tick(60_000) // armed -> alert

  assert.ok(calls.length > 0, 'expected some debug output')
  assert.ok(
    calls.some((l) => l.includes('STATE') && l.includes('armed -> alert')),
    `expected a state-transition log line, got: ${JSON.stringify(calls)}`
  )
})

test('debug logging is prefixed with the plugin id', (t) => {
  const calls = captureConsoleLog(t)
  setup(t, { debug: true })
  assert.ok(calls.length > 0)
  assert.ok(
    calls.every((l) => l.startsWith('[signalk-dead-mans-switch]')),
    `expected every line prefixed with the plugin id, got: ${JSON.stringify(calls.slice(0, 3))}`
  )
})

test('debug logging captures outgoing notifications (OUTPUT)', (t) => {
  const calls = captureConsoleLog(t)
  setup(t, { debug: true })
  t.mock.timers.tick(60_000) // -> alert

  assert.ok(
    calls.some((l) => l.includes('OUTPUT notification') && l.includes('"state":"alert"')),
    `expected an OUTPUT notification log line for alert, got: ${JSON.stringify(calls)}`
  )
})

test('debug logging captures REST inputs and outputs', (t) => {
  const { plugin } = setup(t, { debug: true })
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)

  const calls = captureConsoleLog(t) // start capturing only after registration noise
  router.call('post', '/ack', {})

  assert.ok(calls.some((l) => l.includes('INPUT REST POST /ack')), `expected an input log, got: ${JSON.stringify(calls)}`)
  assert.ok(calls.some((l) => l.includes('OUTPUT REST POST /ack')), `expected an output log, got: ${JSON.stringify(calls)}`)
})

test('debug logging captures received external deltas (INPUT), including ones treated as an acknowledgement', (t) => {
  const { app } = setup(t, { debug: true })

  const calls = captureConsoleLog(t) // start capturing only after startup noise
  app._emitExternalDelta(PATH, { state: 'alarm', method: ['visual', 'sound'] })

  assert.ok(
    calls.some((l) => l.includes('INPUT external delta')),
    `expected an external-delta input log, got: ${JSON.stringify(calls)}`
  )
  assert.ok(
    calls.some((l) => l.includes('STATE armed -> alarm') && l.includes('external stage write')),
    `expected the resulting state transition to be logged with its reason, got: ${JSON.stringify(calls)}`
  )
})

test('debug logging notes when an external delta is ignored (own echo or disarmed)', (t) => {
  const { app, plugin } = setup(t, { debug: true })
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  router.call('post', '/disarm', {})

  const calls = captureConsoleLog(t)
  app._emitExternalDelta(PATH, { state: 'emergency' })

  assert.ok(
    calls.some((l) => l.includes('ignored') && l.includes('disarmed')),
    `expected a log noting the delta was ignored while disarmed, got: ${JSON.stringify(calls)}`
  )
})
