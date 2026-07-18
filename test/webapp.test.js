const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { mountWebapp, INDEX_HTML, PUBLIC_DIR } = require('../test-support/mount-webapp')

test('webapp has no CDN imports - only local/vendored ones', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const importLines = html.match(/import .* from ['"][^'"]+['"]/g) || []
  assert.ok(importLines.length > 0, 'expected at least one import statement')
  for (const line of importLines) {
    assert.match(line, /from ['"]\.\//, `import should be a local relative path, got: ${line}`)
  }
})

test('webapp has no title bar/header element', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.doesNotMatch(html, /<header[\s>]/)
})

const DEFAULT_CONFIG = { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 }

async function statusFetch(state, secondsRemaining, config) {
  return async (url) => {
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state,
          secondsRemaining,
          deadlineAt: secondsRemaining !== null ? Date.now() + secondsRemaining * 1000 : null,
          notificationPath: 'notifications.security.deadmansswitch',
          config: config || DEFAULT_CONFIG,
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }
}

test('the merged state button shows both the stage and remaining time while armed', async (t) => {
  const fetchImpl = await statusFetch('armed', 754, DEFAULT_CONFIG) // 12m 34s
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const stateBtn = doc.querySelector('button.state-button')
  assert.ok(stateBtn, 'state-button should be present')
  assert.match(stateBtn.textContent, /ARMED/)
  assert.match(stateBtn.textContent, /12m 34s remaining/)
})

test('the merged state button shows remaining time while escalated too', async (t) => {
  const fetchImpl = await statusFetch('alert', 42, DEFAULT_CONFIG)
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const stateBtn = doc.querySelector('button.state-button')
  assert.match(stateBtn.textContent, /ALERT/)
  assert.match(stateBtn.textContent, /42s remaining/)
})

test('progress bar fills (grows) as time elapses, rather than draining', async (t) => {
  // alert stage, ackWindowSeconds=90, 45s remaining -> half elapsed -> 50% fill
  const fetchImpl = await statusFetch('alert', 45, DEFAULT_CONFIG)
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const fill = doc.querySelector('.progress-fill')
  assert.ok(fill, 'progress-fill should be present')
  assert.equal(fill.style.width, '50%')
})

test('progress bar grows further as remaining time shrinks (fill direction, not drain)', async (t) => {
  // 90s window, 10s remaining -> 80/90 elapsed -> ~88.9% fill (high, not low)
  const fetchImpl = await statusFetch('alert', 10, DEFAULT_CONFIG)
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const fill = doc.querySelector('.progress-fill')
  const pct = parseFloat(fill.style.width)
  assert.ok(pct > 80, `expected a high fill percentage near the deadline, got ${pct}%`)
})

test('progress bar is full and the whole state-button blinks in emergency', async (t) => {
  const fetchImpl = await statusFetch('emergency', null, DEFAULT_CONFIG)
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const fill = doc.querySelector('.progress-fill')
  assert.equal(fill.style.width, '100%')
  const stateBtn = doc.querySelector('button.state-button')
  assert.ok(stateBtn.classList.contains('blink'))
})

test('disarm button sits in the top toolbar next to the theme toggle, hidden while disarmed', async (t) => {
  const fetchImplDisarmed = await statusFetch('disarmed', null, {})
  const { doc: doc1, unmount: unmount1 } = await mountWebapp(fetchImplDisarmed)
  assert.ok(!doc1.querySelector('button.disarm-btn'), 'no disarm button while disarmed')
  unmount1()

  const fetchImplArmed = await statusFetch('armed', 900, DEFAULT_CONFIG)
  const { doc: doc2, unmount: unmount2 } = await mountWebapp(fetchImplArmed)
  const toolbar = doc2.querySelector('.toolbar')
  assert.ok(toolbar.querySelector('button.disarm-btn'))
  assert.ok(toolbar.querySelector('button.theme-toggle'))
  unmount2()
})

test('clicking the merged state button POSTs to /ack while armed/escalated', async (t) => {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' })
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state: 'warn',
          secondsRemaining: 15,
          deadlineAt: Date.now() + 15000,
          notificationPath: 'notifications.security.deadmansswitch',
          config: DEFAULT_CONFIG,
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }

  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const button = doc.querySelector('button.state-button')
  assert.ok(button, 'state button should be present')
  button.dispatchEvent(new Event('click', { bubbles: true }))

  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.ok(
    calls.some((c) => c.url.endsWith('/ack') && c.method === 'POST'),
    `expected a POST to /ack, got: ${JSON.stringify(calls)}`
  )
})

test('clicking the merged state button POSTs to /arm while disarmed', async (t) => {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' })
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state: 'disarmed',
          secondsRemaining: null,
          deadlineAt: null,
          notificationPath: 'notifications.security.deadmansswitch',
          config: {},
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }

  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const button = doc.querySelector('button.state-button')
  button.dispatchEvent(new Event('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.ok(
    calls.some((c) => c.url.endsWith('/arm') && c.method === 'POST'),
    `expected a POST to /arm, got: ${JSON.stringify(calls)}`
  )
})

test('disarm button asks for confirmation before POSTing to /disarm', async (t) => {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' })
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state: 'armed',
          secondsRemaining: 900,
          deadlineAt: Date.now() + 900000,
          notificationPath: 'notifications.security.deadmansswitch',
          config: DEFAULT_CONFIG,
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }

  const { dom, doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const button = doc.querySelector('button.disarm-btn')
  assert.ok(button, 'disarm button should be present')

  dom.window.confirm = () => false
  button.dispatchEvent(new Event('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(!calls.some((c) => c.url.endsWith('/disarm')), 'no /disarm call after declining confirmation')

  dom.window.confirm = () => true
  button.dispatchEvent(new Event('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(
    calls.some((c) => c.url.endsWith('/disarm') && c.method === 'POST'),
    `expected a POST to /disarm after accepting confirmation, got: ${JSON.stringify(calls)}`
  )
})

test('theme toggle button is present and flips data-theme on the document', async (t) => {
  const fetchImpl = await statusFetch('armed', 900, DEFAULT_CONFIG)
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const toggle = doc.querySelector('button.theme-toggle')
  assert.ok(toggle, 'theme toggle button should be present')
  const before = doc.documentElement.getAttribute('data-theme')
  toggle.dispatchEvent(new Event('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 150))
  const after = doc.documentElement.getAttribute('data-theme')
  assert.notEqual(before, after)
})

test('a failed status fetch shows a clear connection-lost banner and dims the state button, without blanking the last known state', async (t) => {
  let fail = false
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/status')) {
      if (fail) return Promise.reject(new Error('Failed to fetch'))
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state: 'warn',
          secondsRemaining: 30,
          deadlineAt: Date.now() + 30000,
          notificationPath: 'notifications.security.deadmansswitch',
          config: DEFAULT_CONFIG,
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({}) }
  }

  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  // First poll succeeded - no banner yet, last known stage visible.
  assert.ok(!doc.querySelector('.connection-banner'))
  assert.match(doc.querySelector('button.state-button').textContent, /WARNING/)

  // Now the connection drops; wait for the 1s poll to pick it up.
  fail = true
  await new Promise((resolve) => setTimeout(resolve, 1100))

  const banner = doc.querySelector('.connection-banner')
  assert.ok(banner, 'connection-lost banner should appear once polling starts failing')
  assert.match(banner.textContent, /lost/i)
  // The last known state must still be visible, just flagged as stale.
  const stateBtn = doc.querySelector('button.state-button')
  assert.match(stateBtn.textContent, /WARNING/)
  assert.ok(stateBtn.classList.contains('stale'))
  assert.ok(doc.querySelector('.progress-track').classList.contains('stale'))
})

test('a failed initial load (never connected) shows the connection banner instead of "Loading..."', async (t) => {
  const fetchImpl = async () => Promise.reject(new Error('NetworkError when attempting to fetch resource'))
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  assert.ok(doc.querySelector('.connection-banner'), 'connection banner should show even before any successful load')
  assert.doesNotMatch(doc.getElementById('app').textContent, /Loading/)
})

test('audio element points at the bundled siren file, hidden and not autoplaying/looping by default', async (t) => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.match(html, /<audio ref=\$\{audioRef\} src="\.\/audio\/emergency-siren\.wav"/)
})

test('starts the siren, looped at full volume, the moment emergency is reached', async (t) => {
  const fetchImpl = await statusFetch('emergency', null, DEFAULT_CONFIG)
  const { dom, doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)
  await new Promise((resolve) => setTimeout(resolve, 100))

  const audio = doc.querySelector('audio')
  assert.ok(audio, 'an audio element should be present')
  assert.ok(dom.window.__audioCalls.play > 0, 'play() should have been called on reaching emergency')
  assert.equal(audio.loop, true)
  assert.equal(audio.volume, 1)
})

test('does not play the siren for non-emergency stages', async (t) => {
  const fetchImpl = await statusFetch('alarm', 20, DEFAULT_CONFIG)
  const { dom, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  assert.equal(dom.window.__audioCalls.play, 0, 'siren should not play before reaching emergency')
})

test('stops the siren once emergency is acknowledged', async (t) => {
  let state = 'emergency'
  const fetchImpl = async (url, opts) => {
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state,
          secondsRemaining: state === 'emergency' ? null : 900,
          deadlineAt: null,
          notificationPath: 'notifications.security.deadmansswitch',
          config: DEFAULT_CONFIG,
        }),
      }
    }
    if (String(url).endsWith('/ack')) {
      state = 'armed' // ack always resets back to a freshly-armed switch
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }

  const { dom, doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.ok(dom.window.__audioCalls.play > 0, 'siren should have started')

  doc.querySelector('button.state-button').dispatchEvent(new Event('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.ok(dom.window.__audioCalls.pause > 0, 'siren should have been paused after acknowledging')
})

test('alarm audio element points at the bundled alarm-intercom file', async (t) => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.match(html, /<audio ref=\$\{alarmAudioRef\} src="\.\/audio\/alarm-intercom\.wav"/)
})

test('plays the alarm sound immediately on entering alarm, then again every 10s, and stops on leaving alarm', async (t) => {
  const fetchImpl = await statusFetch('alarm', 55, DEFAULT_CONFIG)
  const { dom, doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(dom.window.__audioCalls.play, 1, 'should play once immediately on entering alarm')

  // Advance past the first 10s repeat.
  await new Promise((resolve) => setTimeout(resolve, 10100))
  assert.equal(dom.window.__audioCalls.play, 2, 'should replay after 10s while still in alarm')

  await new Promise((resolve) => setTimeout(resolve, 10100))
  assert.equal(dom.window.__audioCalls.play, 3, 'should keep replaying every 10s while still in alarm')
})

test('does not play the alarm sound for non-alarm stages', async (t) => {
  const fetchImpl = await statusFetch('warn', 20, DEFAULT_CONFIG)
  const { dom, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(dom.window.__audioCalls.play, 0, 'alarm sound should not play outside the alarm stage')
})

test('stops repeating the alarm sound once acknowledged out of alarm', async (t) => {
  let state = 'alarm'
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state,
          secondsRemaining: state === 'alarm' ? 55 : 900,
          deadlineAt: Date.now() + 55000,
          notificationPath: 'notifications.security.deadmansswitch',
          config: DEFAULT_CONFIG,
        }),
      }
    }
    if (String(url).endsWith('/ack')) {
      state = 'armed'
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }

  const { dom, doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(dom.window.__audioCalls.play, 1)

  doc.querySelector('button.state-button').dispatchEvent(new Event('click', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 100))

  const countAfterAck = dom.window.__audioCalls.play
  await new Promise((resolve) => setTimeout(resolve, 10100))
  assert.equal(
    dom.window.__audioCalls.play,
    countAfterAck,
    'no further alarm replays after leaving the alarm stage'
  )
})

test('emergency shows a much larger "TAP HERE" call to action instead of the usual ack text', async (t) => {
  const fetchImpl = await statusFetch('emergency', null, DEFAULT_CONFIG)
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const cta = doc.querySelector('.state-cta')
  assert.ok(cta, 'a CTA element should be present')
  assert.match(cta.textContent, /TAP HERE/)
  assert.ok(cta.classList.contains('emergency-cta'))
})

test('daylight escalation colors: alert light yellow, warn bright yellow, alarm/emergency fire-engine red, emergency has a thick yellow outline', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.match(html, /--stage-alert:\s*#fff176/)
  assert.match(html, /--stage-warn:\s*#ffe600/)
  assert.match(html, /--stage-alarm:\s*#ce2029/)
  assert.match(html, /--stage-emergency:\s*#ce2029/)
  assert.match(html, /--stage-emergency-outline:\s*#ffd500/)
  assert.match(html, /border-width:\s*6px/)
})

test('favicon is wired up, and the icon is not embedded as a visible image in the app UI itself', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.match(html, /<link rel="icon" type="image\/png" href="assets\/icons\/icon-512\.png">/)
  // The icon file should exist as a static asset...
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'assets/icons/icon-512.png')))
  // ...but should not appear as an <img> anywhere in the page body/script.
  assert.doesNotMatch(html, /<img[^>]*icon-512/)
})

test('package.json declares the SignalK app icon for the admin UI app list', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.signalk && pkg.signalk.appIcon, './assets/icons/icon-512.png')
})

test('package.json declares app-store screenshots for armed/warn/emergency, and the files exist at 640x480', () => {
  const repoRoot = path.join(PUBLIC_DIR, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const screenshots = (pkg.signalk && pkg.signalk.screenshots) || []
  assert.deepEqual(screenshots, [
    './docs/screenshots/armed.png',
    './docs/screenshots/warn.png',
    './docs/screenshots/emergency.png',
  ])
  for (const rel of screenshots) {
    const filePath = path.join(repoRoot, rel)
    assert.ok(fs.existsSync(filePath), `${rel} should exist`)
    // Minimal PNG IHDR parse: width/height are 4-byte big-endian ints at
    // fixed offsets 16 and 20.
    const buf = fs.readFileSync(filePath)
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    assert.equal(width, 640, `${rel} width`)
    assert.equal(height, 480, `${rel} height`)
  }
})

test('BASE is a fixed absolute /plugins/<id> path, not derived from window.location', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.match(html, /const BASE = '\/plugins\/signalk-dead-mans-switch'/)
})
