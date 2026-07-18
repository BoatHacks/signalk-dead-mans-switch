// Minimal fake of the SignalK `app` object passed into a plugin's module
// function, plus a fake Express-like router for registerWithRouter tests.
// Only the surface this plugin actually touches is implemented.

function makeFakeApp({ echoSource } = {}) {
  const messages = []
  const statuses = []
  const debugCalls = []
  const busSubscribers = {} // path -> [callback, ...]
  const pathValues = {} // path -> current value, for getSelfPath()
  return {
    // A real SignalK server may redeliver a plugin's own handleMessage()
    // write back through the same delta bus its subscriptions use,
    // synchronously, before this call even returns - that's the scenario
    // that matters most for self-echo bugs, so the fake reproduces it by
    // default rather than only offering an opt-in simulation. `echoSource`
    // lets a test deliberately mismatch the source string the real server
    // would use, to prove a defense doesn't rely on that string matching.
    handleMessage(pluginId, delta) {
      messages.push({ pluginId, delta })
      const source = echoSource !== undefined ? echoSource : pluginId
      ;(delta.updates || []).forEach((update) => {
        ;(update.values || []).forEach(({ path, value }) => {
          pathValues[path] = value
          const echoDelta = { path, value, $source: source, source: { label: source } }
          ;(busSubscribers[path] || []).forEach((cb) => cb(echoDelta))
        })
      })
    },
    setPluginStatus(msg) {
      statuses.push(msg)
    },
    // Stand-in for SignalK's standard per-plugin debug facility - always
    // records calls (the fake has no namespace-gating concept; tests
    // assert on _debugCalls directly rather than on visible output).
    debug(...args) {
      debugCalls.push(args)
    },
    // Reads the current value at a path directly - what the plugin's poll
    // fallback uses. Returns undefined if nothing has ever been set,
    // matching "path not populated yet".
    getSelfPath(path) {
      return pathValues[path]
    },
    streambundle: {
      getSelfBus(path) {
        return {
          onValue(cb) {
            busSubscribers[path] = busSubscribers[path] || []
            busSubscribers[path].push(cb)
            return () => {
              busSubscribers[path] = (busSubscribers[path] || []).filter((fn) => fn !== cb)
            }
          },
        }
      },
    },
    // Test helper: simulate a delta arriving on `path` from some source
    // other than this plugin (e.g. another plugin, or a device writing to
    // SignalK directly). `source` defaults to a generic external plugin id
    // so tests don't accidentally look self-originated.
    _emitExternalDelta(path, value, source = 'some-other-plugin') {
      pathValues[path] = value
      const delta = { path, value, $source: source, source: { label: source } }
      ;(busSubscribers[path] || []).forEach((cb) => cb(delta))
    },
    // Test helper simulating the exact real-world gap the poll fallback
    // exists for: the server's stored value at `path` changes, but for
    // whatever reason (non-preferred source filtering, a v2 API action
    // that doesn't re-emit a delta, etc.) no delta bus subscriber is ever
    // notified. Only getSelfPath() (and therefore the poll) will see it.
    _setPathValueWithoutBusEvent(path, value) {
      pathValues[path] = value
    },
    _busSubscriberCount(path) {
      return (busSubscribers[path] || []).length
    },
    _messages: messages,
    _statuses: statuses,
    _debugCalls: debugCalls,
    // Convenience: the last value published/cleared for a given path, or
    // undefined if nothing was ever sent for it.
    lastValueFor(path) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const values = messages[i].delta.updates[0].values
        const match = values.find((v) => v.path === path)
        if (match) return match.value
      }
      return undefined
    },
  }
}

function makeFakeRouter() {
  const routes = { get: {}, post: {} }
  const middlewares = []
  return {
    use(fn) {
      middlewares.push(fn)
    },
    get(path, handler) {
      routes.get[path] = handler
    },
    post(path, handler) {
      routes.post[path] = handler
    },
    // Test helper: simulate a request through registered middleware + a
    // route handler, returning a fake res object you can inspect.
    call(method, path, body) {
      const req = { body }
      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        set(k, v) {
          this.headers[k] = v
        },
        json(payload) {
          this.body = payload
          return this
        },
        status(code) {
          this.statusCode = code
          return this
        },
      }
      let i = 0
      const runNext = () => {
        if (i < middlewares.length) {
          const mw = middlewares[i++]
          mw(req, res, runNext)
        } else {
          const handler = routes[method][path]
          if (!handler) throw new Error(`no route registered for ${method} ${path}`)
          handler(req, res)
        }
      }
      runNext()
      return res
    },
  }
}

module.exports = { makeFakeApp, makeFakeRouter }
