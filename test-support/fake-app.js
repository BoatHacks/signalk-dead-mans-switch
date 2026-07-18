// Minimal fake of the SignalK `app` object passed into a plugin's module
// function, plus a fake Express-like router for registerWithRouter tests.
// Only the surface this plugin actually touches is implemented.

function makeFakeApp() {
  const messages = []
  const statuses = []
  return {
    handleMessage(pluginId, delta) {
      messages.push({ pluginId, delta })
    },
    setPluginStatus(msg) {
      statuses.push(msg)
    },
    _messages: messages,
    _statuses: statuses,
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
