const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { mountWebapp, INDEX_HTML } = require('../test-support/mount-webapp')

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
          config: config || { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 },
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }
}

test('webapp renders the current state as a disabled state-button', async (t) => {
  const fetchImpl = await statusFetch('alert', 42, { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 })
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const stateBtn = doc.querySelector('button.state-button')
  assert.ok(stateBtn, 'state-button should be present')
  assert.match(stateBtn.textContent, /Alert/)
  assert.equal(stateBtn.disabled, true)
})

test('progress bar fill reflects remaining fraction of the current stage window', async (t) => {
  // alert stage, ackWindowSeconds=90, 45s remaining -> 50% fill
  const fetchImpl = await statusFetch('alert', 45, { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 })
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const fill = doc.querySelector('.progress-fill')
  assert.ok(fill, 'progress-fill should be present')
  assert.equal(fill.style.width, '50%')
})

test('progress bar is full and state-button blinks its outline in emergency', async (t) => {
  const fetchImpl = await statusFetch('emergency', null, { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 })
  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const fill = doc.querySelector('.progress-fill')
  assert.equal(fill.style.width, '100%')
  const stateBtn = doc.querySelector('button.state-button')
  assert.ok(stateBtn.classList.contains('blink-outline'))
})

test('disarm button sits next to the ack button, hidden while disarmed', async (t) => {
  const fetchImplDisarmed = await statusFetch('disarmed', null, {})
  const { doc: doc1, unmount: unmount1 } = await mountWebapp(fetchImplDisarmed)
  assert.equal(doc1.querySelector('button.disarm-btn'), undefined || doc1.querySelector('button.disarm-btn'))
  assert.ok(!doc1.querySelector('button.disarm-btn'), 'no disarm button while disarmed')
  unmount1()

  const fetchImplArmed = await statusFetch('armed', 900, { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 })
  const { doc: doc2, unmount: unmount2 } = await mountWebapp(fetchImplArmed)
  const row = doc2.querySelector('.action-row')
  assert.ok(row.querySelector('button.ack'))
  assert.ok(row.querySelector('button.disarm-btn'))
  unmount2()
})

test('clicking the ack button POSTs to /ack', async (t) => {
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
          config: { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 },
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({ ok: true }) }
  }

  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const button = doc.querySelector('button.ack')
  assert.ok(button, 'ack button should be present')
  button.dispatchEvent(new Event('click', { bubbles: true }))

  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.ok(
    calls.some((c) => c.url.endsWith('/ack') && c.method === 'POST'),
    `expected a POST to /ack, got: ${JSON.stringify(calls)}`
  )
})

test('theme toggle button is present and flips data-theme on the document', async (t) => {
  const fetchImpl = await statusFetch('armed', 900, { checkIntervalMinutes: 15, ackWindowSeconds: 90, warnWindowSeconds: 60, alarmWindowSeconds: 60 })
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

test('BASE is a fixed absolute /plugins/<id> path, not derived from window.location', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.match(html, /const BASE = '\/plugins\/signalk-dead-mans-switch'/)
})
