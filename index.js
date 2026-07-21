// Watch dead man's switch.
//
// Once armed, the plugin waits `checkIntervalMinutes`, then raises a
// notification at SignalK state "alert" asking "are you still there?".
// If nobody acknowledges within `ackWindowSeconds`, the notification
// escalates to "warn", then (after `warnWindowSeconds`) to "alarm", then
// (after `alarmWindowSeconds`) to "emergency" - which is terminal and sits
// there until acknowledged. An acknowledgement at ANY stage resets to a
// resting notification (state "normal", message "armed") and restarts
// the check-in interval from zero. There is deliberately no "escalate
// past emergency" step - emergency is the top of the SignalK notification
// state scale, and anything past that (calling for help, sounding a horn,
// etc.) is left to other plugins subscribed to this notification path,
// not built into this one.
//
// The notification at notificationPath is never cleared - armed and
// disarmed both keep a resting notification present (message "armed" or
// "disarmed" respectively) so anything watching the path can always tell
// which of those two very different states it's actually in, rather than
// an absent value being ambiguous between them (and indistinguishable
// from the plugin never having run at all).
//
// The escalation stage names double as the SignalK notification `state`
// values (alert/warn/alarm/emergency are all valid states), which keeps
// the mapping trivial and lets any standard SignalK alarm-display webapp
// pick this notification up with no special-casing.
//
// External changes on the notification path (another plugin, a client's
// own PUT, or SignalK's v2 Notifications API acknowledge/silence/clear
// actions) are watched two ways: an app.subscriptionmanager.subscribe()
// delta subscription with sourcePolicy: 'all' (instant when it works),
// and a periodic app.getSelfPath() poll (a fallback for a real-world gap
// no subscription mechanism can close - the v2 API's actions may update
// a notification's `status` without re-emitting a normal delta at all).
// sourcePolicy: 'all' matters specifically because app.streambundle
// (which this used before) only ever sees deltas from a path's
// "preferred" source - deltas from any other source are filtered out of
// the delta chain before streambundle subscribers ever see them, which
// is likely why some real servers never fired the old subscription for
// genuine external acknowledgements at all.  Both mechanisms funnel
// through the same reconciliation logic below.

const STAGES = ['alert', 'warn', 'alarm', 'emergency']

// PropertyValues name this plugin's callable API is announced under (see
// buildExternalApi() below) - namespaced with the plugin id to avoid
// colliding with another plugin's arbitrary property names.
const PROPERTY_VALUE_API_NAME = 'signalk-dead-mans-switch-api'

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

  // Routed through SignalK's standard per-plugin debug facility
  // (app.debug()), which is what every other plugin uses - so it's
  // switchable the standard way: via the server admin UI's "Enable
  // debug logging" toggle for this plugin's ID / the DEBUG env var, not
  // a bespoke config option here. app.debug() already no-ops when the
  // plugin's namespace isn't enabled, so this can be called
  // unconditionally.
  function debugLog(...args) {
    if (typeof app.debug === 'function') app.debug(...args)
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

  // Guards against a subtle reentrancy hazard: app.handleMessage() may (on
  // a real server) redeliver our own delta back through this same
  // subscription bus synchronously, before the call that triggered it has
  // even returned. isOwnDelta() below is the primary defense, but it
  // depends on matching the exact $source/source.label shape a real
  // server gives self-originated deltas, which isn't something we can
  // fully verify without one running. This flag is a second, unconditional
  // defense: while true, ANY delta on our own publish/clear calls is
  // guaranteed to be our own synchronous echo, full stop, regardless of
  // what shape it arrives in.
  let isPublishingOwnChange = false

  // Reduces a notification value to just the fields that matter for
  // deciding whether something meaningfully changed (state, whether
  // "sound" is present in method, whether it's acknowledged) - ignoring
  // `message`, `timestamp`, the server-assigned `id`, and any other
  // `status` fields the server may add/recompute on top of what we
  // publish. Used to detect real external changes (via polling - see
  // below) without being fooled by a poll simply reflecting our own last
  // write back with cosmetic differences.
  function significantSignature(value) {
    if (!value || typeof value !== 'object') return 'none'
    const soundPresent = Array.isArray(value.method) && value.method.includes('sound')
    const acknowledged = !!(value.status && value.status.acknowledged === true)
    return JSON.stringify({ state: value.state, soundPresent, acknowledged })
  }

  // app.getSelfPath() for a notification path may return either the bare
  // notification value, or the full tree node ({value, timestamp,
  // $source}) wrapping it, depending on server version - unwrap
  // defensively rather than assuming one shape.
  function unwrapNotificationValue(raw) {
    if (raw && typeof raw === 'object' && !('state' in raw) && raw.value && typeof raw.value === 'object' && 'state' in raw.value) {
      return raw.value
    }
    return raw
  }

  // Generic version of the unwrap above, for plain leaf values (a bare
  // string, not a notification-shaped object) - app.getSelfPath() may
  // return either the raw value or the full tree node ({value, timestamp,
  // $source}) wrapping it, depending on server version.
  function unwrapPlainValue(raw) {
    if (raw && typeof raw === 'object' && 'value' in raw) return raw.value
    return raw
  }

  // "day" is the only phase/mode we treat as light - everything else
  // (dawn/sunrise/sunset/dusk/night for environment.sun; anything other
  // than "day" for the simpler environment.mode) is treated as dark. The
  // point is protecting night vision, which matters from dusk through
  // dawn, not just once it's fully dark - matching why the dark theme
  // itself is red-shifted rather than just "the same UI but dimmer".
  const SUN_DARK_PHASES = new Set(['dawn', 'sunrise', 'sunset', 'dusk', 'night'])

  // Recommends 'light' or 'dark' for the webapp's theme, or null if the
  // "Automatically switch theme" option is off, no host support for
  // reading paths synchronously, or neither environment.sun nor
  // environment.mode has a recognized value yet. environment.sun (set by
  // signalk-derived-data to one of dawn/sunrise/day/sunset/dusk/night) is
  // preferred for its finer-grained twilight awareness; environment.mode
  // (a simpler day/night string some setups use instead) is the fallback.
  // Read fresh on every /status call rather than maintained via a
  // subscription - status is already polled every ~1s by the webapp, so a
  // separate push mechanism would add complexity without adding
  // responsiveness that matters here.
  function computeThemeRecommendation() {
    if (!config('autoTheme', false)) return null
    if (typeof app.getSelfPath !== 'function') return null

    let sun
    try {
      sun = unwrapPlainValue(app.getSelfPath('environment.sun'))
    } catch (err) {
      sun = undefined
    }
    if (sun === 'day') return 'light'
    if (SUN_DARK_PHASES.has(sun)) return 'dark'

    let mode
    try {
      mode = unwrapPlainValue(app.getSelfPath('environment.mode'))
    } catch (err) {
      mode = undefined
    }
    if (typeof mode === 'string') {
      const normalized = mode.toLowerCase()
      if (normalized === 'day') return 'light'
      if (normalized === 'night') return 'dark'
    }

    return null
  }

  // Tracks the significant fields of whatever we most recently reconciled
  // against (our own last publish, or the last external change already
  // acted on) - see pollForExternalChange() below.
  let lastReconciledSignature = null

  function publishNotification(stage) {
    const value = {
      state: stage,
      message: STAGE_MESSAGE[stage],
      method: ['visual', 'sound'],
      timestamp: new Date().toISOString(),
      // The whole point of this switch is that "I muted the
      // sound" must never be mistaken for "a human is
      // present" - silencing alone would let it go quiet
      // while nobody has actually checked in. Acknowledging
      // (which does properly reset the switch - see below)
      // remains available.
      //
      // canSilence isn't a top-level notification field in the
      // SignalK spec - the real, respected one lives inside
      // `status`, matching the shape SignalK's v2 Notifications
      // API itself adds.
      status: {
        silenced: false,
        acknowledged: false,
        canSilence: false,
        canAcknowledge: true,
        canClear: false,
      },
    }
    lastReconciledSignature = significantSignature(value)
    debugLog(`OUTPUT notification -> ${notificationPath}:`, {
      state: stage,
      message: STAGE_MESSAGE[stage],
      method: ['visual', 'sound'],
    })
    isPublishingOwnChange = true
    try {
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: [
              {
                path: notificationPath,
                value,
              },
            ],
          },
        ],
      })
    } finally {
      isPublishingOwnChange = false
    }
  }

  // Publishes a resting (non-escalated) notification - used for both
  // "armed" and "disarmed", instead of clearing the path entirely. Keeping
  // a notification present (state: normal, message reflecting which
  // resting state we're actually in) means anything watching the path -
  // an MFD, another plugin, a log - can always tell "the switch is armed
  // and watching" from "the switch is disarmed" at a glance, rather than
  // an absent value being ambiguous between those two very different
  // things (and also indistinguishable from the plugin never having run
  // at all).
  function publishRestingNotification(label) {
    const value = {
      state: 'normal',
      message: label,
      method: [],
      timestamp: new Date().toISOString(),
      status: {
        silenced: false,
        acknowledged: false,
        canSilence: false,
        canAcknowledge: false,
        canClear: false,
      },
    }
    lastReconciledSignature = significantSignature(value)
    debugLog(`OUTPUT notification -> ${notificationPath}:`, { state: 'normal', message: label })
    isPublishingOwnChange = true
    try {
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: [
              {
                path: notificationPath,
                value,
              },
            ],
          },
        ],
      })
    } finally {
      isPublishingOwnChange = false
    }
  }

  // Arms the switch: drops back to plain "armed" (no stage) and starts the
  // check-in interval countdown, then publishes a resting "armed"
  // notification. `state` is updated FIRST, before the notification
  // write - so that even in the reentrancy edge case the guard above
  // doesn't catch, any self-echo that reaches
  // handleExternalNotificationChange sees the already-correct new state
  // rather than a stale one.
  function arm(reason) {
    const previousState = state
    clearTimer()
    state = 'armed'
    deadlineAt = Date.now() + intervalMs()
    timer = setTimeout(raisePrompt, intervalMs())
    debugLog(`STATE ${previousState} -> armed (${reason || 'unspecified'}); next check-in in ${intervalMs() / 1000}s`)
    app.setPluginStatus(statusMessage())
    publishRestingNotification('armed')
  }

  // Fires once the check-in interval elapses: raises the first escalation
  // stage ("alert") and starts its own timeout.
  function raisePrompt() {
    escalateTo(0, 'check-in interval elapsed')
  }

  function escalateTo(stageIndex, reason) {
    const previousState = state
    const stage = STAGES[stageIndex]
    state = stage

    clearTimer()
    if (stageIndex >= STAGES.length - 1) {
      // Emergency is terminal - no further auto-escalation, no deadline.
      deadlineAt = null
      debugLog(`STATE ${previousState} -> ${stage} (${reason || 'unspecified'}); terminal, no further auto-escalation`)
    } else {
      deadlineAt = Date.now() + stageWindowMs(stageIndex)
      timer = setTimeout(() => escalateTo(stageIndex + 1, 'stage window elapsed'), stageWindowMs(stageIndex))
      debugLog(`STATE ${previousState} -> ${stage} (${reason || 'unspecified'}); escalates further in ${stageWindowMs(stageIndex) / 1000}s unless acknowledged`)
    }
    app.setPluginStatus(statusMessage())
    publishNotification(stage)
  }

  // Acknowledges the switch, from any stage (or even while merely armed -
  // a no-op reset in that case). Always resets to a freshly-armed timer -
  // this must NEVER leave the switch disarmed; disarming is a distinct,
  // separate action (see disarm() below) that only ever happens via an
  // explicit /disarm call, not as a side effect of acknowledging.
  function ack(reason) {
    if (state === 'disarmed') {
      debugLog(`INPUT ack (${reason || 'unspecified'}) - no-op, switch is disarmed`)
      return false
    }
    arm(reason || 'ack')
    return true
  }

  function disarm(reason) {
    const previousState = state
    clearTimer()
    state = 'disarmed'
    deadlineAt = null
    debugLog(`STATE ${previousState} -> disarmed (${reason || 'unspecified'})`)
    app.setPluginStatus(statusMessage())
    publishRestingNotification('disarmed')
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
  //   - an acknowledgement via SignalK's own v2 Notifications API
  //     (POST /signalk/v2/api/notifications/{id}/acknowledge, which is
  //     what clients like Freeboard's "Acknowledge" button actually call)
  //     is treated the same as our own /ack. Importantly, that action does
  //     NOT clear the notification or change its `state`. When the server
  //     exposes the v2 API's `status` object, `status.acknowledged: true`
  //     is the most direct, authoritative signal and is trusted outright.
  //     As a fallback for servers/configurations where `status` isn't
  //     populated, the spec also has the action strip "sound" from the
  //     `method` array (and, for state=emergency specifically, ONLY
  //     "sound" - "visual" stays), so `method` no longer including "sound"
  //     is checked too. Either signal is watched for BEFORE the
  //     stage-matching check below, since an acknowledged-but-still-
  //     escalated delta would otherwise look like "the same stage being
  //     written again" and just restart that stage's timer instead of
  //     resetting all the way back to armed.
  //   - a stage value (alert/warn/alarm/emergency) written externally
  //     (with sound still present in method) snaps our state machine to
  //     that stage, exactly as if we'd escalated to it ourselves, with a
  //     freshly-started window
  //   - the notification being cleared, or set to any non-stage value,
  //     while we're currently armed/escalated is treated as an external
  //     acknowledgement - same effect as our own /ack
  //   - while disarmed, external changes are ignored entirely - a
  //     disarmed switch isn't managing this path, so what happens on it
  //     is none of our business until re-armed
  // Deltas WE published (via publishNotification/publishRestingNotification
  // above) come back through this same subscription like any other - they
  // are recognized (see isOwnDelta below) and ignored, so we don't
  // re-process our own writes or create a feedback loop.
  // subscriptionmanager.subscribe() takes an array and pushes its own
  // unsubscribe function into it, rather than returning one directly.
  let unsubscribes = []
  let pollTimer = null

  function isOwnDelta(delta) {
    return isPublishingOwnChange || (delta && (delta.$source === plugin.id || (delta.source && delta.source.label === plugin.id)))
  }

  // Shared by both the delta-bus subscription and the poll-based fallback
  // below - decides what an observed (non-own) notification value means
  // and acts on it.
  function reconcileExternalValue(value, sourceDescription) {
    if (state === 'disarmed') {
      debugLog(`  -> ignored (${sourceDescription}), switch is disarmed`)
      return
    }

    const externalState = value && value.state
    const method = value && value.method
    const status = value && value.status
    // status.acknowledged is the most direct, authoritative signal a
    // server can give us - when present and true, trust it outright.
    // method no longer including "sound" is a fallback for servers/
    // configurations where status isn't populated at all (e.g. the v2
    // Notifications API isn't enabled) but the method-stripping behavior
    // still happens.
    const acknowledgedViaStatus = !!status && status.acknowledged === true
    const acknowledgedViaMethod = Array.isArray(method) && !method.includes('sound')
    const stageIndex = STAGES.indexOf(externalState)

    if (acknowledgedViaStatus || acknowledgedViaMethod || stageIndex === -1) {
      // Ack-equivalent signal (explicit flag, method stripped, or a
      // cleared/non-stage value). Only meaningful when there's actually
      // something escalated to acknowledge - if we're already just
      // "armed", there's nothing to do. This matters because some
      // servers keep status.acknowledged STICKY on a notification id
      // even after we publish a fresh resting "armed" value under it -
      // without this guard, every subsequent poll would see that same
      // stale "acknowledged: true", call arm() again, and reset the
      // 60s-style check-in timer back to full every ~2s forever, so the
      // switch could never actually escalate again.
      if (state === 'armed') {
        debugLog(`  -> no-op (${sourceDescription}): already armed, nothing to acknowledge`)
        return
      }
      arm(
        `${sourceDescription}: ${
          acknowledgedViaStatus ? 'status.acknowledged' : acknowledgedViaMethod ? 'method no longer includes sound' : 'cleared or non-stage state'
        }`
      )
      return
    }

    escalateTo(stageIndex, `${sourceDescription}: stage write`)
  }

  function handleExternalNotificationChange(delta) {
    if (isOwnDelta(delta)) {
      debugLog('INPUT external delta on notification path - own echo, ignored')
      return
    }
    const value = delta && delta.value
    debugLog('INPUT external delta on notification path:', value)
    lastReconciledSignature = significantSignature(value)
    reconcileExternalValue(value, 'external delta')
  }

  // Fallback for a real-world gap no subscription mechanism can close:
  // SignalK's v2 Notifications API acknowledge/silence/clear actions may
  // update a notification's `status` without re-emitting a normal delta
  // at all. Polling app.getSelfPath() reads the actual current value
  // directly, sidestepping that entirely. Deliberately kept
  // alongside (not instead of) the delta subscription above - cheap
  // insurance, and instant when the delta path does work.
  const POLL_INTERVAL_MS = 2000

  function pollForExternalChange() {
    if (state === 'disarmed') return
    if (typeof app.getSelfPath !== 'function') return
    let raw
    try {
      raw = app.getSelfPath(notificationPath)
    } catch (err) {
      return
    }
    // undefined means "nothing at this path yet" (or a transient gap
    // right after our own write hasn't been ingested yet) - not a
    // meaningful signal either way, so don't treat it as a clear. An
    // explicit `null` (a real external clear) is still handled below.
    if (raw === undefined) return

    const value = unwrapNotificationValue(raw)
    const signature = significantSignature(value)
    if (signature === lastReconciledSignature) return
    lastReconciledSignature = signature
    debugLog('INPUT external poll on notification path:', value)
    reconcileExternalValue(value, 'external poll')
  }

  // PUT handler on the notification path itself - the idiomatic SignalK
  // way for another plugin (or SignalK core machinery) to act on this
  // switch via app.putSelfPath(notificationPath, value, cb), no
  // PropertyValues/REST-specific knowledge of this plugin required, just
  // the standard PUT mechanism any SignalK path can support. The PUT's
  // value is interpreted exactly like an external delta on this path
  // (reconcileExternalValue - see the top-of-file comment and the
  // external-change subscription above for the exact rules): a stage
  // value escalates to that stage, an ack-equivalent value (or anything
  // else, including no value at all) acknowledges. Always reports the
  // PUT as COMPLETED - even a no-op (e.g. while disarmed) is not an
  // error, the same way POST /ack while disarmed returns 200 with
  // ok: false rather than failing the request.
  function handleNotificationPut(context, path, value, callback) {
    debugLog('INPUT PUT on notification path:', value)
    reconcileExternalValue(value, 'PUT handler')
    return { state: 'COMPLETED', statusCode: 200 }
  }

  plugin.start = function (opts) {
    options = opts || {}
    notificationPath = `notifications.${config('notificationPath', 'security.deadmansswitch')}`
    debugLog('plugin.start()', {
      notificationPath,
      enabled: config('enabled', true),
      checkIntervalMinutes: config('checkIntervalMinutes', 15),
      ackWindowSeconds: config('ackWindowSeconds', 90),
      warnWindowSeconds: config('warnWindowSeconds', 60),
      alarmWindowSeconds: config('alarmWindowSeconds', 60),
    })
    if (app.subscriptionmanager && typeof app.subscriptionmanager.subscribe === 'function') {
      unsubscribes = []
      app.subscriptionmanager.subscribe(
        {
          context: 'vessels.self',
          // The whole reason for using subscriptionmanager instead of
          // app.streambundle: sourcePolicy is only honored here, and
          // 'all' is what lets us see a delta regardless of which
          // source wrote it, not just the path's "preferred" one.
          sourcePolicy: 'all',
          subscribe: [{ path: notificationPath, period: 1000 }],
        },
        unsubscribes,
        (subscriptionError) => {
          debugLog(`subscriptionmanager error subscribing to ${notificationPath}:`, subscriptionError)
        },
        (delta) => {
          ;(delta.updates || []).forEach((update) => {
            ;(update.values || []).forEach(({ path, value }) => {
              if (path !== notificationPath) return
              handleExternalNotificationChange({
                value,
                $source: update.$source || delta.$source,
                source: update.source || delta.source,
              })
            })
          })
        }
      )
      debugLog(`subscribed to external changes on ${notificationPath}`)
    }
    if (typeof app.getSelfPath === 'function') {
      pollTimer = setInterval(pollForExternalChange, POLL_INTERVAL_MS)
      debugLog(`polling ${notificationPath} for external changes every ${POLL_INTERVAL_MS / 1000}s as a fallback`)
    }
    if (typeof app.emitPropertyValue === 'function') {
      app.emitPropertyValue(PROPERTY_VALUE_API_NAME, buildExternalApi())
      debugLog(`announced in-process API via PropertyValues as "${PROPERTY_VALUE_API_NAME}"`)
    }
    if (typeof app.registerPutHandler === 'function') {
      // No documented way to unregister a PUT handler - if the plugin
      // restarts (reconfiguration, etc.) this may register more than
      // once. Not harmful: reconcileExternalValue's own dedup
      // (lastReconciledSignature) and the arm()/escalateTo() calls it
      // can trigger are safe to run redundantly, just mildly wasteful.
      app.registerPutHandler('vessels.self', notificationPath, handleNotificationPut)
      debugLog(`registered PUT handler on ${notificationPath}`)
    }
    if (config('enabled', true)) {
      arm('start (enabled)')
    } else {
      // Reuses disarm() itself (rather than duplicating its body) so the
      // resting "disarmed" notification is always published consistently,
      // including here: e.g. the server was restarted mid-escalation and
      // this plugin now starts disabled, or was simply configured
      // disabled with a leftover notification from a previous run/
      // version. A disarmed switch must never leave a stale escalated
      // notification hanging around for something it's no longer
      // actually managing.
      disarm('start (enabled: false)')
    }
  }

  plugin.stop = function () {
    debugLog('plugin.stop()')
    clearTimer()
    timer = null
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
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
      playSounds: {
        type: 'boolean',
        title: 'Play sounds in browser',
        description:
          'The companion webapp plays a siren at emergency and a repeating alert sound at alarm. Uncheck to disable audio in the webapp entirely - useful if this notification is already wired into a dedicated alarm system and the browser sounds would just be redundant/annoying.',
        default: true,
      },
      autoTheme: {
        type: 'boolean',
        title: 'Automatically switch light/dark theme based on sun position',
        description:
          'Webapp follows vessels.self.environment.sun (preferred - dawn/sunrise/day/sunset/dusk/night) or vessels.self.environment.mode (simpler day/night fallback) instead of the manual light/dark toggle. Needs a plugin like signalk-derived-data publishing one of those paths.',
        default: false,
      },
    },
  }

  // If a plugin provides an API, SignalK's convention is to implement
  // getOpenApi() returning the parsed openApi.json - this surfaces the
  // definition in the server's Admin UI under Documentation -> OpenAPI.
  plugin.getOpenApi = () => openapi

  // ---- In-process API for other plugins (PropertyValues) -------------------
  //
  // The REST API below is for the webapp and hardware ack buttons - things
  // outside the SignalK server process. Another PLUGIN calling it would
  // mean loopback HTTP with an auth token, for no real reason: plugins
  // share the same process and app object, and SignalK's own
  // PropertyValues mechanism (app.emitPropertyValue / app.onPropertyValues)
  // exists specifically so one plugin can expose a callable API to others
  // in-process, no HTTP/auth involved - the emitted value can be a
  // function (or, as here, an object of them). Emitted once on start()
  // under a name namespaced with this plugin's id; per SignalK's own
  // PropertyValues docs, `onPropertyValues` delivers the full history of
  // everything ever emitted for a name as an array (starting with
  // `undefined` if nothing has been emitted yet), which is exactly why
  // this is emitted once rather than on every state change - the API
  // object's methods are closures reading live state on every call, they
  // don't need to be re-emitted just because that state changed.
  function buildExternalApi() {
    return {
      // Acknowledges the switch, exactly like POST /ack - returns false
      // if the switch is currently disarmed (nothing to acknowledge).
      ack: (reason) => ack(reason || 'external plugin via PropertyValues'),
      // (Re-)arms the switch, exactly like POST /arm.
      arm: (reason) => {
        arm(reason || 'external plugin via PropertyValues')
        return true
      },
      // Disarms the switch, exactly like POST /disarm.
      disarm: (reason) => {
        disarm(reason || 'external plugin via PropertyValues')
        return true
      },
      // Same shape as GET /status, minus the config block (a caller in
      // the same process can just read the plugin's own config directly
      // if it needs to).
      getStatus: () => ({
        state,
        secondsRemaining: secondsRemaining(),
        deadlineAt,
        notificationPath,
      }),
    }
  }

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
      debugLog('INPUT REST GET /status')
      const body = {
        state,
        secondsRemaining: secondsRemaining(),
        deadlineAt,
        notificationPath,
        themeRecommendation: computeThemeRecommendation(),
        config: {
          checkIntervalMinutes: config('checkIntervalMinutes', 15),
          ackWindowSeconds: config('ackWindowSeconds', 90),
          warnWindowSeconds: config('warnWindowSeconds', 60),
          alarmWindowSeconds: config('alarmWindowSeconds', 60),
          playSounds: config('playSounds', true),
          autoTheme: config('autoTheme', false),
        },
      }
      debugLog('OUTPUT REST GET /status ->', { state: body.state, secondsRemaining: body.secondsRemaining })
      res.json(body)
    })

    router.post('/ack', (req, res) => {
      debugLog('INPUT REST POST /ack')
      const acked = ack('REST /ack')
      const body = { ok: acked, state, secondsRemaining: secondsRemaining() }
      debugLog('OUTPUT REST POST /ack ->', body)
      res.json(body)
    })

    router.post('/disarm', (req, res) => {
      debugLog('INPUT REST POST /disarm')
      disarm('REST /disarm')
      const body = { ok: true, state }
      debugLog('OUTPUT REST POST /disarm ->', body)
      res.json(body)
    })

    router.post('/arm', (req, res) => {
      debugLog('INPUT REST POST /arm')
      arm('REST /arm')
      const body = { ok: true, state, secondsRemaining: secondsRemaining() }
      debugLog('OUTPUT REST POST /arm ->', body)
      res.json(body)
    })
  }

  // Exposed for tests only - not part of the plugin API SignalK server calls.
  plugin.__test__ = { STAGES, STAGE_MESSAGE }

  return plugin
}
