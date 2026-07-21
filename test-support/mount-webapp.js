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

// Plain (non-module) inline <script> tags - e.g. the embedded-mode
// detection script in <head> that runs before first paint. Module scripts
// are excluded (handled separately by extractModuleScript/import()).
function extractPlainScripts(html) {
  const scripts = []
  const re = /<script(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(html))) {
    scripts.push(m[1])
  }
  return scripts
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

  // jsdom doesn't implement real media playback - HTMLMediaElement.play()
  // throws "Not implemented" and returns undefined rather than a Promise,
  // which would break the webapp's own .then()/.catch() chain around it.
  // Stub both methods and expose call counts so tests can assert on
  // play/pause behavior (e.g. "the siren started/stopped") without a real
  // audio backend.
  dom.window.__audioCalls = { play: 0, pause: 0 }
  dom.window.HTMLMediaElement.prototype.play = function () {
    dom.window.__audioCalls.play++
    this.paused = false
    return Promise.resolve()
  }
  dom.window.HTMLMediaElement.prototype.pause = function () {
    dom.window.__audioCalls.pause++
    this.paused = true
  }

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

  // Plain <head> scripts (e.g. the embedded-mode attribute setter) run
  // before the module script, matching real document load order. Run via
  // `new Function` bound explicitly to window/document rather than
  // dom.window.eval(), which doesn't expose them as in-scope globals
  // without jsdom's `runScripts` option enabled.
  for (const plainScript of extractPlainScripts(html)) {
    new Function('window', 'document', plainScript)(dom.window, dom.window.document)
  }

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

module.exports = { mountWebapp, PUBLIC_DIR, INDEX_HTML }
