const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

const PATH = 'notifications.security.deadmansswitch'
const DEFAULT_OPTS = { checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10 }

test('persists state to a JSON file under app.getDataDirPath() whenever the stage changes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start(DEFAULT_OPTS)
  t.after(() => plugin.stop())

  const filePath = path.join(app._dataDirPath, 'state.json')
  let persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(persisted.state, 'armed')
  assert.ok(persisted.deadlineAt > Date.now())

  t.mock.timers.tick(60_000) // -> alert
  persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(persisted.state, 'alert')
})

test('a fresh restart with no persisted file just arms normally', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start(DEFAULT_OPTS)
  t.after(() => plugin.stop())

  assert.equal(app.lastValueFor(PATH).message, 'armed')
})

test('restarting mid-escalation with time left resumes the same stage with the remaining window, not a fresh one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dms-restart-test-'))

  // First "run": escalate to warn (20s window), let 8s of it pass, then stop.
  const app1 = makeFakeApp({ dataDir })
  const plugin1 = buildPlugin(app1)
  plugin1.start(DEFAULT_OPTS)
  t.mock.timers.tick(60_000) // -> alert
  t.mock.timers.tick(30_000) // -> warn (20s window starts)
  t.mock.timers.tick(8_000) // 8s of the 20s window elapse
  assert.equal(app1.lastValueFor(PATH).state, 'warn')
  plugin1.stop()

  // "Restart": a brand new plugin instance, same data directory.
  const app2 = makeFakeApp({ dataDir })
  const plugin2 = buildPlugin(app2)
  plugin2.start(DEFAULT_OPTS)
  t.after(() => plugin2.stop())

  const router = makeFakeRouter()
  plugin2.registerWithRouter(router)
  let res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'warn', 'should resume the same stage, not restart from armed')
  assert.equal(res.body.secondsRemaining, 12, 'should resume with the remaining ~12s, not a fresh 20s window')

  // And the remaining window still actually elapses on schedule.
  t.mock.timers.tick(12_000)
  res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'alarm', 'the resumed window must still escalate on schedule')
})

test('restarting after the persisted deadline already passed escalates one stage forward immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dms-restart-test-'))

  const app1 = makeFakeApp({ dataDir })
  const plugin1 = buildPlugin(app1)
  plugin1.start(DEFAULT_OPTS)
  t.mock.timers.tick(60_000) // -> alert (30s ackWindow)
  assert.equal(app1.lastValueFor(PATH).state, 'alert')
  plugin1.stop()

  // Simulate a long downtime: manually rewrite the persisted deadline to
  // the past, as if far more time had elapsed than the window allowed.
  const filePath = path.join(dataDir, 'state.json')
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  persisted.deadlineAt = Date.now() - 5000
  fs.writeFileSync(filePath, JSON.stringify(persisted))

  const app2 = makeFakeApp({ dataDir })
  const plugin2 = buildPlugin(app2)
  plugin2.start(DEFAULT_OPTS)
  t.after(() => plugin2.stop())

  assert.equal(app2.lastValueFor(PATH).state, 'warn', 'should escalate one stage forward, not stay at alert or jump further')
})

test('restarting after a persisted armed interval already elapsed raises the first prompt immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dms-restart-test-'))

  const app1 = makeFakeApp({ dataDir })
  const plugin1 = buildPlugin(app1)
  plugin1.start(DEFAULT_OPTS)
  assert.equal(app1.lastValueFor(PATH).message, 'armed')
  plugin1.stop()

  const filePath = path.join(dataDir, 'state.json')
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  persisted.deadlineAt = Date.now() - 1000
  fs.writeFileSync(filePath, JSON.stringify(persisted))

  const app2 = makeFakeApp({ dataDir })
  const plugin2 = buildPlugin(app2)
  plugin2.start(DEFAULT_OPTS)
  t.after(() => plugin2.stop())

  assert.equal(app2.lastValueFor(PATH).state, 'alert')
})

test('restarting with a persisted "emergency" state restores it directly (terminal, no deadline to resume)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dms-restart-test-'))

  const app1 = makeFakeApp({ dataDir })
  const plugin1 = buildPlugin(app1)
  plugin1.start(DEFAULT_OPTS)
  t.mock.timers.tick(60_000)
  t.mock.timers.tick(30_000)
  t.mock.timers.tick(20_000)
  t.mock.timers.tick(10_000)
  assert.equal(app1.lastValueFor(PATH).state, 'emergency')
  plugin1.stop()

  const app2 = makeFakeApp({ dataDir })
  const plugin2 = buildPlugin(app2)
  plugin2.start(DEFAULT_OPTS)
  t.after(() => plugin2.stop())

  const router = makeFakeRouter()
  plugin2.registerWithRouter(router)
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.state, 'emergency')
  assert.equal(res.body.secondsRemaining, null)
})

test('restarting after an explicit disarm stays disarmed, does not resume a stale escalation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dms-restart-test-'))

  const app1 = makeFakeApp({ dataDir })
  const plugin1 = buildPlugin(app1)
  plugin1.start(DEFAULT_OPTS)
  t.mock.timers.tick(60_000) // -> alert
  const router1 = makeFakeRouter()
  plugin1.registerWithRouter(router1)
  router1.call('post', '/disarm', {})
  plugin1.stop()

  const app2 = makeFakeApp({ dataDir })
  const plugin2 = buildPlugin(app2)
  plugin2.start(DEFAULT_OPTS) // enabled: true by default in config, but persisted state was disarmed
  t.after(() => plugin2.stop())

  // Config still says enabled - a fresh arm happens (persistence doesn't
  // override the enabled/disabled decision, only which stage to resume
  // within it), but there must be no trace of the old "alert" escalation.
  assert.equal(app2.lastValueFor(PATH).message, 'armed')
})

test('gracefully does nothing if the host does not provide app.getDataDirPath', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  delete app.getDataDirPath
  const plugin = buildPlugin(app)
  assert.doesNotThrow(() => plugin.start(DEFAULT_OPTS))
  t.after(() => plugin.stop())
  assert.equal(app.lastValueFor(PATH).message, 'armed')
})

test('a corrupt persisted file is ignored, falling back to a fresh arm', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dms-restart-test-'))
  fs.writeFileSync(path.join(dataDir, 'state.json'), 'not valid json {{{')

  const app = makeFakeApp({ dataDir })
  const plugin = buildPlugin(app)
  assert.doesNotThrow(() => plugin.start(DEFAULT_OPTS))
  t.after(() => plugin.stop())
  assert.equal(app.lastValueFor(PATH).message, 'armed')
})
