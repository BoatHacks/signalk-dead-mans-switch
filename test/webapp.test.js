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

test('webapp renders the current stage and countdown from /status', async (t) => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({
          state: 'alert',
          secondsRemaining: 42,
          deadlineAt: Date.now() + 42000,
          notificationPath: 'notifications.security.deadmansswitch',
          config: {},
        }),
      }
    }
    return { ok: true, status: 200, url, json: async () => ({}) }
  }

  const { doc, unmount } = await mountWebapp(fetchImpl)
  t.after(unmount)

  const text = doc.getElementById('app').textContent
  assert.match(text, /Alert/)
  assert.match(text, /42s/)
  assert.ok(calls.some((u) => String(u).endsWith('/status')))
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
          config: {},
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

test('BASE is a fixed absolute /plugins/<id> path, not derived from window.location', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  assert.match(html, /const BASE = '\/plugins\/signalk-dead-mans-switch'/)
})
