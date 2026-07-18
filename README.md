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
   waiting - clears the notification and restarts the check-in interval
   from zero.

The escalation stage names are exactly the SignalK notification `state`
values (`alert`/`warn`/`alarm`/`emergency`), so any standard SignalK alarm
display can pick this notification up with no special-casing.

## Acknowledging

Two ways to ack:

- **The companion webapp** (installed automatically, available from the
  Signal K server's webapps list) - a big button showing the current
  stage, a live countdown, and a pulsing "acknowledge" prompt once things
  reach `alarm`/`emergency`.
- **A REST call** to `POST /plugins/signalk-dead-mans-switch/ack` - handy
  for wiring up a physical hardware ack button (e.g. an ESP32 with a big
  panic-style pushbutton at the helm) instead of relying on a screen.

## REST API

All endpoints are mounted at `/plugins/signalk-dead-mans-switch`.

| Method | Path       | Description                                              |
| ------ | ---------- | ---------------------------------------------------------|
| GET    | `/status`  | Current stage, seconds remaining, and active config      |
| POST   | `/ack`     | Acknowledge - clears the notification, restarts the timer|
| POST   | `/arm`     | (Re-)arm the switch                                      |
| POST   | `/disarm`  | Disarm - stops all timers, clears any live notification  |

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

## Development

```
npm install
npm test
```

Frontend dependencies (Preact + htm) are vendored under `public/vendor/`
rather than loaded from a CDN, since the browser accessing this webapp is
very often talking only to the local Signal K server with no wider
internet access. See `public/vendor/README.md` for details.
