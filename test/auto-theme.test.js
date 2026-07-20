const test = require('node:test')
const assert = require('node:assert/strict')
const { makeFakeApp, makeFakeRouter } = require('../test-support/fake-app')
const buildPlugin = require('../index.js')

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1, ackWindowSeconds: 30, warnWindowSeconds: 20, alarmWindowSeconds: 10, ...opts })
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.after(() => plugin.stop())
  return { app, plugin, router }
}

test('themeRecommendation is null when autoTheme is off, regardless of environment data', (t) => {
  const { app, router } = setup(t, { autoTheme: false })
  app._setPathValueWithoutBusEvent('environment.sun', 'night')
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, null)
  assert.equal(res.body.config.autoTheme, false)
})

test('environment.sun "day" recommends light', (t) => {
  const { app, router } = setup(t, { autoTheme: true })
  app._setPathValueWithoutBusEvent('environment.sun', 'day')
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, 'light')
  assert.equal(res.body.config.autoTheme, true)
})

for (const phase of ['dawn', 'sunrise', 'sunset', 'dusk', 'night']) {
  test(`environment.sun "${phase}" recommends dark`, (t) => {
    const { app, router } = setup(t, { autoTheme: true })
    app._setPathValueWithoutBusEvent('environment.sun', phase)
    const res = router.call('get', '/status', undefined)
    assert.equal(res.body.themeRecommendation, 'dark')
  })
}

test('environment.sun takes priority over environment.mode when both are present', (t) => {
  const { app, router } = setup(t, { autoTheme: true })
  app._setPathValueWithoutBusEvent('environment.sun', 'day')
  app._setPathValueWithoutBusEvent('environment.mode', 'night') // contradicts sun - sun should win
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, 'light')
})

test('falls back to environment.mode when environment.sun is unavailable', (t) => {
  const { app, router } = setup(t, { autoTheme: true })
  app._setPathValueWithoutBusEvent('environment.mode', 'night')
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, 'dark')
})

test('environment.mode is case-insensitive', (t) => {
  const { app, router } = setup(t, { autoTheme: true })
  app._setPathValueWithoutBusEvent('environment.mode', 'Day')
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, 'light')
})

test('unrecognized environment.sun value falls through to environment.mode', (t) => {
  const { app, router } = setup(t, { autoTheme: true })
  app._setPathValueWithoutBusEvent('environment.sun', 'some-unexpected-value')
  app._setPathValueWithoutBusEvent('environment.mode', 'day')
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, 'light')
})

test('themeRecommendation is null when autoTheme is on but neither path has a usable value', (t) => {
  const { router } = setup(t, { autoTheme: true })
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, null)
})

test('handles a wrapped tree-node shape ({value, timestamp, $source}) from getSelfPath, not just a bare string', (t) => {
  const { app, router } = setup(t, { autoTheme: true })
  app._setPathValueWithoutBusEvent('environment.sun', { value: 'night', timestamp: '2026-01-01T00:00:00Z', $source: 'some-plugin' })
  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, 'dark')
})

test('does not throw if the host does not provide app.getSelfPath', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const app = makeFakeApp()
  delete app.getSelfPath
  const plugin = buildPlugin(app)
  plugin.start({ checkIntervalMinutes: 1, autoTheme: true })
  const router = makeFakeRouter()
  plugin.registerWithRouter(router)
  t.after(() => plugin.stop())

  const res = router.call('get', '/status', undefined)
  assert.equal(res.body.themeRecommendation, null)
})
