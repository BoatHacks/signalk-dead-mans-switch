// Watch dead man's switch.
//
// Once armed, the plugin waits `checkIntervalMinutes`, then raises a
// notification at SignalK state "alert" asking "are you still there?".
// If nobody acknowledges within `ackWindowSeconds`, the notification
// escalates to "warn", then (after `warnWindowSeconds`) to "alarm", then
// (after `alarmWindowSeconds`) to "emergency" - which is terminal and sits
// there until acknowledged. An acknowledgement at ANY stage clears the
// notification and restarts the check-in interval from zero. There is
// deliberately no "escalate past emergency" step - emergency is the top
// of the SignalK notification state scale, and anything past that
// (calling for help, sounding a horn, etc.) is left to other plugins
// subscribed to this notification path, not built into this one.
//
// The escalation stage names double as the SignalK notification `state`
// values (alert/warn/alarm/emergency are all valid states), which keeps
// the mapping trivial and lets any standard SignalK alarm-display webapp
// pick this notification up with no special-casing.

const STAGES = ['alert', 'warn', 'alarm', 'emergency']

const openapi = require('./openApi.json')

const STAGE_MESSAGE = {
  alert: 'Dead man\u2019s switch: are you still there? Acknowledge to reset the timer.',
  warn: 'Dead man\u2019s switch: still no acknowledgement. Escalating.',
  alarm: 'Dead man\u2019s switch: no response for a while now. Escalating further.',
  emergency: 'Dead man\u2019s switch: watch incapacitated! No acknowledgement received.',
}

module.exports = function (app) {
  const plugin = {
    id: 'signalk-dead-mans-switch',
    name: "Dead Man's Switch",
    description:
      "Periodic 'you still there?' check-in that escalates through alert/warn/alarm/emergency notification states until acknowledged",
  }

  let options = {}
  let notificationPath = null

  // 'disarmed' | 'armed' | one of STAGES
  let state = 'disarmed'
  // Epoch ms the current timer (check-in wait, or escalation wait) will
  // fire at - exposed via /status so the webapp can render a countdown
  // without the server having to push anything.
  let deadlineAt = null
  let timer = null

  function config(key, fallback) {
    const v = options[key]
    return v === undefined || v === null || v === '' ? fallback : v
  }

  function intervalMs() {
    return config('checkIntervalMinutes', 15) * 60 * 1000
  }

  function stageWindowMs(stageIndex) {
    const seconds = [
      config('ackWindowSeconds', 90),
      config('warnWindowSeconds', 60),
      config('alarmWindowSeconds', 60),
    ][stageIndex]
    return seconds * 1000
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function statusMessage() {
    if (state === 'disarmed') return 'Disarmed'
    if (state === 'armed') return 'Armed, watching'
    return `Escalated: ${state}`
  }

  function publishNotification(stage) {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: notificationPath,
              value: {
                state: stage,
                message: STAGE_MESSAGE[stage],
                method: ['visual', 'sound'],
                timestamp: new Date().toISOString(),
              },
            },
          ],
        },
      ],
    })
  }

  function clearNotification() {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: notificationPath, value: null }] }],
    })
  }

  // Arms the switch: clears any live notification, drops back to plain
  // "armed" (no stage), and starts the check-in interval countdown.
  function arm() {
    clearTimer()
    clearNotification()
    state = 'armed'
    deadlineAt = Date.now() + intervalMs()
    timer = setTimeout(raisePrompt, intervalMs())
    app.setPluginStatus(statusMessage())
  }

  // Fires once the check-in interval elapses: raises the first escalation
  // stage ("alert") and starts its own timeout.
  function raisePrompt() {
    escalateTo(0)
  }

  function escalateTo(stageIndex) {
    const stage = STAGES[stageIndex]
    state = stage
    publishNotification(stage)
    app.setPluginStatus(statusMessage())

    clearTimer()
    if (stageIndex >= STAGES.length - 1) {
      // Emergency is terminal - no further auto-escalation, no deadline.
      deadlineAt = null
      return
    }
    deadlineAt = Date.now() + stageWindowMs(stageIndex)
    timer = setTimeout(() => escalateTo(stageIndex + 1), stageWindowMs(stageIndex))
  }

  // Acknowledges the switch, from any stage (or even while merely armed -
  // a no-op reset in that case). Always resets to a freshly-armed timer.
  function ack() {
    if (state === 'disarmed') return false
    arm()
    return true
  }

  function disarm() {
    clearTimer()
    clearNotification()
    state = 'disarmed'
    deadlineAt = null
    app.setPluginStatus(statusMessage())
  }

  function secondsRemaining() {
    if (!deadlineAt) return null
    return Math.max(0, Math.round((deadlineAt - Date.now()) / 1000))
  }

  // ---- Reacting to external changes on the notification path ---------------
  //
  // Something other than this plugin (another plugin, a webapp PUTting the
  // notification directly, a hardware device publishing straight to
  // SignalK) may write to notificationPath. When that happens, this
  // switch's own state - and therefore what the REST API and companion
  // webapp report - would otherwise drift out of sync with the actual
  // notification, silently, until the next scheduled timer fires. Instead,
  // we subscribe to the path ourselves and reconcile immediately:
  //   - a stage value (alert/warn/alarm/emergency) written externally
  //     snaps our state machine to that stage, exactly as if we'd
  //     escalated to it ourselves, with a freshly-started window
  //   - the notification being cleared, or set to any non-stage value,
  //     while we're currently armed/escalated is treated as an external
  //     acknowledgement - same effect as our own /ack
  //   - while disarmed, external changes are ignored entirely - a
  //     disarmed switch isn't managing this path, so what happens on it
  //     is none of our business until re-armed
  // Deltas WE published (via publishNotification/clearNotification above)
  // come back through this same subscription like any other - they are
  // recognized by $source being our own plugin.id and ignored, so we
  // don't re-process our own writes or create a feedback loop.
  let unsubscribeExternal = null

  function isOwnDelta(delta) {
    return delta && (delta.$source === plugin.id || (delta.source && delta.source.label === plugin.id))
  }

  function handleExternalNotificationChange(delta) {
    if (isOwnDelta(delta)) return
    if (state === 'disarmed') return

    const externalState = delta && delta.value && delta.value.state
    const stageIndex = STAGES.indexOf(externalState)

    if (stageIndex !== -1) {
      escalateTo(stageIndex)
    } else {
      // Cleared, or set to some state we don't recognize as one of our
      // stages (e.g. "normal") - treat either as an acknowledgement.
      arm()
    }
  }

  plugin.start = function (opts) {
    options = opts || {}
    notificationPath = `notifications.${config('notificationPath', 'security.deadmansswitch')}`
    if (app.streambundle && typeof app.streambundle.getSelfBus === 'function') {
      unsubscribeExternal = app.streambundle.getSelfBus(notificationPath).onValue(handleExternalNotificationChange)
    }
    if (config('enabled', true)) {
      arm()
    } else {
      state = 'disarmed'
      app.setPluginStatus(statusMessage())
    }
  }

  plugin.stop = function () {
    clearTimer()
    timer = null
    if (unsubscribeExternal) {
      unsubscribeExternal()
      unsubscribeExternal = null
    }
  }

  plugin.schema = {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Armed on plugin start',
        default: true,
      },
      checkIntervalMinutes: {
        type: 'number',
        title: 'Check-in interval (minutes)',
        description: 'How long the switch waits, once armed or acknowledged, before asking "are you still there?"',
        default: 15,
      },
      ackWindowSeconds: {
        type: 'number',
        title: 'Alert window (seconds)',
        description: 'Time to acknowledge before escalating from alert to warn',
        default: 90,
      },
      warnWindowSeconds: {
        type: 'number',
        title: 'Warn window (seconds)',
        description: 'Time to acknowledge before escalating from warn to alarm',
        default: 60,
      },
      alarmWindowSeconds: {
        type: 'number',
        title: 'Alarm window (seconds)',
        description: 'Time to acknowledge before escalating from alarm to emergency (terminal - no further auto-escalation)',
        default: 60,
      },
      notificationPath: {
        type: 'string',
        title: 'Notification sub-path',
        description: 'Appended after "notifications." - e.g. "security.deadmansswitch"',
        default: 'security.deadmansswitch',
      },
    },
  }

  // If a plugin provides an API, SignalK's convention is to implement
  // getOpenApi() returning the parsed openApi.json - this surfaces the
  // definition in the server's Admin UI under Documentation -> OpenAPI.
  plugin.getOpenApi = () => openapi

  // ---- REST API for the ack webapp (and any hardware ack button) -----------

  plugin.registerWithRouter = function (router) {
    // Every response here reflects live, fast-changing state (countdown,
    // current stage) - never let a client or intermediary cache a GET and
    // serve it back stale.
    if (typeof router.use === 'function') {
      router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store')
        next()
      })
    }

    router.get('/status', (req, res) => {
      res.json({
        state,
        secondsRemaining: secondsRemaining(),
        deadlineAt,
        notificationPath,
        config: {
          checkIntervalMinutes: config('checkIntervalMinutes', 15),
          ackWindowSeconds: config('ackWindowSeconds', 90),
          warnWindowSeconds: config('warnWindowSeconds', 60),
          alarmWindowSeconds: config('alarmWindowSeconds', 60),
        },
      })
    })

    router.post('/ack', (req, res) => {
      const acked = ack()
      res.json({ ok: acked, state, secondsRemaining: secondsRemaining() })
    })

    router.post('/disarm', (req, res) => {
      disarm()
      res.json({ ok: true, state })
    })

    router.post('/arm', (req, res) => {
      arm()
      res.json({ ok: true, state, secondsRemaining: secondsRemaining() })
    })
  }

  // Exposed for tests only - not part of the plugin API SignalK server calls.
  plugin.__test__ = { STAGES, STAGE_MESSAGE }

  return plugin
}
