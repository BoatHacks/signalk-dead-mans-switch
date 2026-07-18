const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html')

function extractModuleScript(html) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/)
  if (!match) throw new Error('Could not find <script type="module"> in index.html')
  return match[1]
}

// Mounts the webapp's real script in a jsdom document, with fetch() routed
// through the caller-supplied fetchImpl. jsdom can't resolve a relative
// `import` inside an inline <script type="module"> against a fake
// http://localhost URL (there's no real server to fetch it from), so
// instead of relying on jsdom's own module loader, the script body is
// written to a real temp .mjs file next to the vendored dependency it
// imports and loaded with Node's own `import()` - a real ES module
// resolving a real relative path on disk. Always call unmount() in a
// `finally`/`t.after()` to restore patched globals and remove the temp file.
async function mountWebapp(fetchImpl, { url = 'http://localhost/plugins/signalk-dead-mans-switch/' } = {}) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const script = extractModuleScript(html)

  const tmpScriptPath = path.join(PUBLIC_DIR, `.webapp-test-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(tmpScriptPath, script)

  const dom = new JSDOM('<!DOCTYPE html><div id="app"></div>', { url })

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    setInterval: globalThis.setInterval,
    Event: globalThis.Event,
  }
  const capturedIntervals = []

  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame
  globalThis.Event = dom.window.Event
  globalThis.setInterval = (...args) => {
    const id = previous.setInterval(...args)
    capturedIntervals.push(id)
    return id
  }
  globalThis.fetch = fetchImpl

  try {
    await import(`file://${tmpScriptPath}?t=${Date.now()}`)
    // Preact/htm's render + the app's first effect (initial fetch) both
    // resolve as microtasks/short timeouts - give them a tick.
    await new Promise((resolve) => setTimeout(resolve, 150))
  } finally {
    fs.rmSync(tmpScriptPath, { force: true })
  }

  const doc = dom.window.document

  function unmount() {
    capturedIntervals.forEach(clearInterval)
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.fetch = previous.fetch
    globalThis.requestAnimationFrame = previous.requestAnimationFrame
    globalThis.setInterval = previous.setInterval
    globalThis.Event = previous.Event
  }

  return { dom, doc, unmount }
}

module.exports = { mountWebapp, PUBLIC_DIR, INDEX_HTML, extractModuleScript }
