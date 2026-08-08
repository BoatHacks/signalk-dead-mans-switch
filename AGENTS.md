# signalk-dead-mans-switch

Watch dead man's switch SignalK plugin: periodic "you still there?" check-in
escalating alert -> warn -> alarm -> emergency (each its own timeout window,
emergency terminal) until acknowledged. Ack resets to a resting "armed"
notification. Repo: BoatHacks/signalk-dead-mans-switch.

## Architecture
- Native plugin.schema config; companion Preact+htm webapp (vendored deps, no
  CDN) at `/plugins/<id>/`.
- REST API (`/status`, `/ack`, `/arm`, `/disarm`) documented as OpenAPI 3.0
  (`openApi.json`, `plugin.getOpenApi()`).
- `node --test` suite; CI via SignalK's reusable plugin-ci.yml.
- Armed/disarmed both keep a resting notification (state "normal", message
  "armed"/"disarmed", never cleared) so absent-vs-armed-vs-disarmed is never
  ambiguous.

## Ack paths
Webapp button, REST endpoint (hardware ack buttons e.g. ESP32), external
reconciliation (watches the notification path via
`app.subscriptionmanager.subscribe` with `sourcePolicy:'all'` — migrated off
`app.streambundle`, which only sees a path's "preferred" source — plus an
`app.getSelfPath` poll fallback every 2s for v2-API actions that emit no
delta), PropertyValues API (`{ack,arm,disarm,getStatus}` announced once on
start as `signalk-dead-mans-switch-api`), and a PUT handler on
`notificationPath`. Ack detection treats `status.acknowledged:true` (primary),
method no longer including "sound" (fallback), an external stage write, or a
clear/non-stage value as real signals — but only acts on them when actually
escalated (no-op while already armed, since some servers keep
`status.acknowledged` sticky).

## Webapp
Stage titles ARMED/ALERT/WARNING/ALARM/WATCH INCAPACITATED; merged state+ack
button (stage, mm:ss countdown, tap to ack/arm); fill-direction progress bar;
light/dark theme toggle (dark red-shifted for night vision, matches
signalk-stowage-mgmt convention) or fully automatic via "Automatically switch
theme" config (follows `environment.sun` preferred / `environment.mode`
fallback, computed server-side); disarm button with confirm(); connection-lost
banner (dims, never blanks); daylight colors (alert=light yellow,
warn=bright yellow, alarm/emergency=fire-engine red with blinking yellow
outline at emergency); "TAP HERE" CTA at emergency; `?embedded=true` iframe
mode (from collaborator hoeken's PR).

## Sounds
Emergency siren (loganzsound, CC0) loops at full volume; alarm-intercom.wav
(electrobadger, CC0) repeats every 10s during ALARM; both gated by "Play
sounds in browser" config (default on).

## Config options
`enabled`, `checkIntervalMinutes`, `ackWindowSeconds`, `warnWindowSeconds`,
`alarmWindowSeconds`, `notificationPath`, `playSounds`, `autoTheme`; debug
logging via SignalK's standard `app.debug()`.

## Persistence
Current stage+deadline written to a JSON file under `app.getDataDirPath()` on
every change, restored on start — resumes exact stage+remaining-time after a
crash/restart, escalating one stage forward immediately if the deadline
passed during downtime. The "armed on start" config option remains sole
authority on whether to arm at all; persistence only picks which stage to
resume within that.

## signalk-alert-manager integration (optional, feature-detected via
`app.alertManager`)
Raises/updates a correctly-prioritized alert on every escalation rather than
relying on alert-manager's generic ingestion (which wrongly maps our "alert"
stage to a no-ack-required "Caution"). Ack/disarm also acknowledge+clear the
alert-manager alert. Built from reading its README only, not verified live.
Declined adopting alert-manager's broader IEC 62923 lifecycle/priority-axis
model — out of scope for this deliberately single-purpose plugin. Note:
alert-manager's silencing feature is the opposite of this plugin's design
principle (`canSilence:false`) — a real, intentional tension if both plugins
run together.

## Notes
- `status.canSilence:false` included in notifications (no real top-level
  `canSilence` field exists in the spec, so this was removed from that
  approach) — the server's own v2-API `status.canSilence` stays
  computed/true regardless; confirmed not achievable from the plugin side.
- App icon: `public/assets/icons/icon-512.png` (skeleton squirrel artwork).
- Releases so far: v0.1.0 -> v0.2.0 -> v0.3.0 (OpenAPI, external
  reconciliation, self-echo fix) -> v0.4.0 (poll fallback, sticky-ack fix,
  Freeboard ack fixes) -> v0.5.0/v0.5.1 (embedded mode) -> v0.6.0
  (subscriptionmanager/PropertyValues/PUT-handler, Chromium 69+ fixes, doc
  updates). Persistence + alert-manager integration land after v0.6.0, not yet
  released. All releases published to npm manually by Tobi (no npm
  credentials in sandbox).
- Freeboard/v2-Notifications-API acknowledge behavior confirmed against real
  captured payloads: doesn't clear notification or change state, strips
  "sound" from method instead (only for emergency; "visual" stays) — locked in
  as regression tests using the exact captured data.
