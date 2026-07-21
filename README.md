# signalk-dead-mans-switch

A [Signal K](https://signalk.org) server plugin implementing a watch dead
man's switch: a periodic "are you still there?" check-in that escalates
through the standard SignalK notification states - `alert` -> `warn` ->
`alarm` -> `emergency` - until acknowledged.

Useful for solo or short-handed watchkeeping: if the person on watch stops
responding, the alarm state keeps climbing instead of silently staying at
a single low-priority notification.

## How it works

1. Once armed, the plugin waits `checkIntervalMinutes` and then raises a
   notification at state `alert`: *"are you still there? Acknowledge to
   reset the timer."*
2. If nobody acknowledges within `ackWindowSeconds`, it escalates to
   `warn`.
3. If still unacknowledged after `warnWindowSeconds`, it escalates to
   `alarm`.
4. If still unacknowledged after `alarmWindowSeconds`, it escalates to
   `emergency` - *"watch incapacitated!"* This is the top of SignalK's
   notification scale and is terminal: the plugin does not escalate any
   further on its own. (Sounding a horn, sending a distress alert, texting
   someone ashore, etc. once `emergency` is reached is left to other
   plugins/automations subscribed to this notification path - keeping
   those concerns out of this plugin.)
5. An acknowledgement at **any** stage - including while merely armed and
   waiting - resets to a resting notification (`state: normal`, `message:
   "armed"`) and restarts the check-in interval from zero.

The escalation stage names are exactly the SignalK notification `state`
values (`alert`/`warn`/`alarm`/`emergency`), so any standard SignalK alarm
display can pick this notification up with no special-casing. The switch
always keeps a notification present at `notificationPath` rather than
clearing it when armed or disarmed - `message` reads `"armed"` or
`"disarmed"` so anything watching the path can always tell which resting
state it's actually in, rather than an absent value being ambiguous
between "armed and watching," "disarmed," and "this plugin has never
run."

## Acknowledging

Two ways to ack:

- **The companion webapp** (installed automatically, available from the
  Signal K server's webapps list) - one big button showing the current
  stage, the remaining time in that stage's window, and doubling as the
  ack/arm action (tap it to acknowledge, or to arm when disarmed). A
  horizontal progress bar underneath fills up as the deadline approaches.
  Disarm and the light/dark theme toggle sit together in the top corner.
  The theme follows the same palette convention as `signalk-stowage-mgmt`
  (dark mode is deliberately red-shifted to preserve night vision on
  watch).
- **A REST call** to `POST /plugins/signalk-dead-mans-switch/ack` - handy
  for wiring up a physical hardware ack button (e.g. an ESP32 with a big
  panic-style pushbutton at the helm) instead of relying on a screen.

If the webapp loses its connection to the SignalK server (network drop,
server restart, etc.), it does not go blank or keep showing a frozen
countdown as if nothing were wrong. It shows a clear "connection lost"
banner and visibly dims the state button and progress bar, while still
displaying the last known state (and when it was last confirmed) - so
it's obvious the display can no longer be trusted, without losing the
last real information either. Polling continues in the background and
the banner clears automatically once the connection recovers.

## Siren

The moment the switch reaches `emergency`, the webapp plays a bundled
siren sound (`public/audio/emergency-siren.wav`), looped, at full volume
(the audio element's own gain - it can't override the device's system/
OS volume). It stops the instant `emergency` is acknowledged.

Browsers block audio from starting with sound until the page has seen a
real user gesture. The webapp "unlocks" the audio element on the very
first tap/click anywhere on the page (arming, acking, toggling the
theme - anything counts), so the siren can then start on its own later
with no further interaction needed, as long as *something* was tapped
at some point after the page loaded.

The bundled siren is "High Frequency Siren Model D" by loganzsound
(Freesound.org), CC0 - see `public/audio/NOTICE.md`.

While the switch is in `alarm` (one stage before emergency), the webapp
also plays a second bundled sound (`public/audio/alarm-intercom.wav`,
"Space-Intercom-Emergency" by electrobadger on Freesound.org, CC0) once
immediately and then again every 10 seconds, stopping the moment the
stage changes away from `alarm` in either direction (escalating to
emergency, which has its own continuous siren instead, or being
acknowledged).

Both sounds are controlled by the plugin's **Play sounds in browser**
config option (on by default). Turn it off if this notification is
already wired into a dedicated alarm system and the browser's own
audio would just be redundant.

## REST API

All endpoints are mounted at `/plugins/signalk-dead-mans-switch`.

| Method | Path       | Description                                              |
| ------ | ---------- | ---------------------------------------------------------|
| GET    | `/status`  | Current stage, seconds remaining, and active config      |
| POST   | `/ack`     | Acknowledge - resets to a resting "armed" notification, restarts the timer |
| POST   | `/arm`     | (Re-)arm the switch                                      |
| POST   | `/disarm`  | Disarm - stops all timers, sets a resting "disarmed" notification |

`POST /ack` always restarts the check-in interval, even if the switch
is already just `armed` (nothing escalated) - handy as a general
"I'm here" refresh via the webapp or a hardware button. It's a no-op
only while `disarmed` (`ok: false` in the response); use `/arm` to
start watching again. An *external* acknowledgement signal seen on the
notification path (see below) is more conservative: it's ignored
while already `armed`, since some servers keep an "acknowledged" flag
sticky on the notification even after the switch resets - reacting to
it every time would otherwise keep restarting the timer forever.

Fully documented as an OpenAPI 3.0 definition in `openApi.json`
(exposed via `plugin.getOpenApi()`, per SignalK's plugin API
convention) - browsable in the SignalK server's Admin UI under
**Documentation -> OpenAPI** once the plugin is installed.

## Interoperating with other plugins/devices

The switch's state isn't only driven by its own REST API - it also
watches the notification path itself and reconciles immediately if
something else writes to it directly, e.g. another plugin, a webapp
doing its own PUT, a device publishing straight to SignalK, or a
client using SignalK's v2 Notifications API. Watched two ways:

- an `app.subscriptionmanager.subscribe()` delta subscription, with
  `sourcePolicy: 'all'` so it sees a delta regardless of which source
  wrote it (not just the path's "preferred" one, which is all
  `app.streambundle` - a lower-level API this used before - ever sees)
- a periodic `app.getSelfPath()` poll (every 2s) as a further fallback -
  the v2 Notifications API's acknowledge/silence/clear actions may
  update a notification's `status` without re-emitting a normal delta
  at all, which no subscription mechanism can see. Polling reads the
  actual current value directly, sidestepping that gap.

Either path reacts the same way to what it sees:

- writing one of the escalation states (`alert`/`warn`/`alarm`/
  `emergency`) snaps the switch to that stage, with a freshly-started
  window for it - exactly as if the switch had escalated there itself
- an acknowledgement via SignalK's own v2 Notifications API (`POST
  /signalk/v2/api/notifications/{id}/acknowledge`, which is what clients
  like Freeboard's "Acknowledge" button actually call) resets the switch
  the same as calling `/ack`, but only while something is actually
  escalated - a no-op while already just `armed`, since some servers
  keep the "acknowledged" flag sticky on the notification even after
  the switch resets, which would otherwise restart the timer forever.
  That action doesn't clear the notification or change `state`. When a
  server exposes it, `status.acknowledged: true` is trusted directly -
  the most authoritative signal available. As a fallback for servers
  where `status` isn't populated, the spec also has the action strip
  `"sound"` from `method` (only `"sound"` when `state` is `emergency`),
  so that's checked too
- clearing the notification, or writing any other state (e.g.
  `normal`), while the switch is armed or escalated is treated as an
  external acknowledgement - same effect as calling `/ack`
- while disarmed, external changes on the path are ignored entirely -
  a disarmed switch isn't managing it

Published notifications also set `status.canSilence: false` (inside a
`status` object mirroring SignalK's v2 Notifications API shape) -
silencing alone (muting sound without truly checking in) must never be
mistaken for an acknowledgement. There's no valid top-level
`canSilence` field in the SignalK notification spec; only
`status.canSilence` is meaningful.

Deltas the plugin publishes itself are recognized (by source) and
never reprocessed, so this can't create a feedback loop. The REST API
and companion webapp both reflect the reconciled state immediately -
the webapp picks it up on its next poll (at most ~1s later), no
webapp-side changes needed.

## Configuration

Set via the plugin's config page in the Signal K admin UI:

| Option                 | Default                    | Description                                                       |
| ----------------------- | --------------------------- | ------------------------------------------------------------------ |
| Armed on plugin start    | `true`                      | Whether the switch starts armed when the plugin loads              |
| Check-in interval        | `15` minutes                | Wait time, once armed/acknowledged, before the first prompt        |
| Alert window              | `90` seconds                 | Time to ack before `alert` escalates to `warn`                     |
| Warn window                | `60` seconds                 | Time to ack before `warn` escalates to `alarm`                     |
| Alarm window                | `60` seconds                 | Time to ack before `alarm` escalates to `emergency`                |
| Notification sub-path      | `security.deadmansswitch`   | Appended after `notifications.`                                    |
| Play sounds in browser      | `true`                       | Whether the companion webapp plays the emergency siren and repeating alarm sound |
| Automatically switch light/dark theme based on sun position | `false` | See "Automatic theme" below |

### Automatic theme

When enabled, the webapp follows `vessels.self.environment.sun`
(preferred) or `vessels.self.environment.mode` (fallback) instead of a
manual toggle - the toggle button is hidden entirely while this is on.

- `environment.sun` (set by
  [signalk-derived-data](https://github.com/SignalK/signalk-derived-data)
  to one of `dawn`/`sunrise`/`day`/`sunset`/`dusk`/`night`) is checked
  first: `day` means light, anything else means dark. The point is
  protecting night vision, which matters from dusk through dawn, not
  just once it's fully dark.
- `environment.mode` (a simpler `day`/`night` string some setups use
  instead) is the fallback if `environment.sun` isn't available.
- If neither path has a usable value, the webapp falls back to its
  normal default (OS preference / last manually-picked theme) and the
  toggle stays hidden until a recommendation becomes available.

Needs a plugin like `signalk-derived-data` actually publishing one of
those paths - this plugin only reads them, it doesn't calculate sun
position itself.

### Debug logging

Logs every state transition (with its reason), every notification
published, and every input received (REST calls and external changes
on the notification path) via SignalK's standard per-plugin debug
facility (`app.debug()`) - the same mechanism every other well-behaved
plugin uses. Enable it the standard way: the plugin's entry in the
server admin UI's debug log settings, or the `DEBUG` environment
variable including `signalk-dead-mans-switch`. There's no separate
toggle in this plugin's own config screen.

## App icon

`public/assets/icons/icon-512.png` is used as the browser favicon and
as the app's icon in the SignalK admin UI's webapp list
(`package.json`'s `signalk.appIcon`). It's not shown anywhere inside
the webapp's own UI.

## Development

```
npm install
npm test
```

Frontend dependencies (Preact + htm) are vendored under `public/vendor/`
rather than loaded from a CDN, since the browser accessing this webapp is
very often talking only to the local Signal K server with no wider
internet access. See `public/vendor/README.md` for details.
