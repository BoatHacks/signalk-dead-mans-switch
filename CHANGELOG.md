# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- Embedded mode's overlaid progress bar ran off the right edge of the
  button. Its base rule sets `width: 100%`, which is over-constrained
  together with absolute positioning plus explicit `left` and `right`
  offsets - added `width: auto` to the embedded override so `left`/
  `right` alone determine the width, as intended.

## [0.5.0] - 2026-07-20

### Changed
- In embedded mode (`?embedded=true`), the progress bar is now overlaid
  near the bottom of the button itself instead of being hidden - neutral
  translucent colors rather than the stage color (which would disappear
  into the button's own matching background).

### Added
- New **Automatically switch light/dark theme based on sun position**
  config option (off by default). When on, the webapp follows
  `vessels.self.environment.sun` (preferred - dawn/sunrise/day/sunset/
  dusk/night, only `day` counts as light) or `vessels.self.environment.mode`
  (simpler day/night fallback) instead of a manual toggle - the toggle
  button is hidden entirely while this is on. Computed server-side and
  exposed via `GET /status`'s new `themeRecommendation` field (`"light"`,
  `"dark"`, or `null` if the option is off or neither path has a usable
  value yet).
- Merged "Styling for embedding in an iframe" from hoeken: `?embedded=true`
  hosts the webapp transparently in an iframe - toolbar and progress bar
  hidden, state button fills the viewport, connection banner overlays
  instead of pushing content down. Added test coverage for it (none
  shipped with the PR).
- New **Play sounds in browser** config option (on by default). Unchecking
  it disables the webapp's emergency siren and repeating alarm sound
  entirely - useful when this notification is already wired into a
  dedicated alarm system and the browser's own audio would just be
  redundant. Exposed via `GET /status`'s `config.playSounds` (defaults to
  `true` if a server doesn't have the option yet).

### Changed
- Countdown time is now formatted as bare `mm:ss` (e.g. `12:34`, no
  "remaining" suffix) instead of `12m 34s remaining`, and displayed at
  the same size/weight as the stage title (ARMED/WARNING/etc.) instead
  of smaller text.

## [0.4.0] - 2026-07-18

### Fixed
- The poll fallback (added just above) had a bug of its own, caught via
  debug logging on a real server: some servers keep `status.acknowledged:
  true` STICKY on a notification id even after the plugin publishes a
  fresh "armed" resting value under it. Every poll saw that same stale
  flag, called `arm()` again, and reset the check-in timer back to full
  every ~2s - so the switch could never actually count down again after
  an external acknowledgement. Fixed: an ack-equivalent signal
  (`status.acknowledged`, method stripped, or a cleared/non-stage value)
  is now only acted on when there's actually something escalated to
  acknowledge - a no-op while already just "armed".
- External changes on the notification path (acknowledgements, other
  plugins/devices writing to it) were sometimes never seen at all -
  debug logging showed no `INPUT external delta` ever arriving on some
  real servers. Likely cause: servers filter deltas from a
  non-preferred source out of the delta chain before
  `app.streambundle` subscribers ever see them, and/or the v2
  Notifications API's acknowledge/silence/clear actions may update a
  notification's `status` without re-emitting a normal delta at all.
  Added a periodic `app.getSelfPath()` poll (every 2s) as a fallback
  alongside the existing delta subscription - it reads the actual
  current value directly, independent of whatever nuance of the delta
  chain would otherwise drop the change silently.

### Added
- Debug logging: every state transition (with the reason - a timer
  elapsing, an ack, an external change, etc.), every notification
  published, and every input received (REST calls to
  `/status`/`/ack`/`/arm`/`/disarm` and external changes seen on the
  notification path) is now logged via SignalK's standard per-plugin
  debug facility (`app.debug()`). Switchable the same way as any other
  plugin's debug output - the server admin UI's debug settings or the
  `DEBUG` env var - no separate config option in this plugin.

### Changed
- The switch no longer clears the notification at `notificationPath`
  when armed or disarmed - it keeps a resting notification present
  instead (`state: "normal"`, `message: "armed"` or `"disarmed"`), so
  anything watching the path can always tell which of those two very
  different states it's actually in, rather than an absent value being
  ambiguous between them (and indistinguishable from the plugin never
  having run at all). Applies everywhere the switch reaches "armed" or
  "disarmed": on start, via `/ack`, `/arm`, `/disarm`, and when an
  external change is reconciled as an acknowledgement.

### Fixed
- The switch now also trusts `status.acknowledged: true` directly as an
  acknowledgement signal, when a server's v2 Notifications API exposes
  it - the most direct, authoritative signal available. Live testing
  showed the `method`-stripping heuristic alone wasn't always enough to
  catch a real acknowledgement in time; `status.acknowledged` is checked
  first, with the method-based check remaining as a fallback for
  servers/configurations where `status` isn't populated.
- Acknowledging from Freeboard (and any other client using SignalK's v2
  Notifications API) now actually works. That API's acknowledge action
  does NOT clear the notification or change its `state` - per spec it
  strips `"sound"` from the `method` array instead (and, for
  `state: "emergency"`, only `"sound"` - `"visual"` stays). The switch
  previously only looked at `state`/clearing to detect an acknowledgement,
  so a v2 acknowledge was misread as "the same stage being written again"
  and just refreshed that stage's timer instead of resetting all the way
  back to armed. Now detected directly by `method` no longer including
  `"sound"`, checked before stage-matching, for both regular stages and
  the emergency special case.

### Changed
- Published notifications set `status.canSilence: false` - silencing
  alone (muting sound without truly checking in) must never be mistaken
  for an acknowledgement. Removed the top-level `canSilence` field
  tried previously - it isn't a valid SignalK notification field and,
  per live testing, was never touched/respected by anything; only
  `status.canSilence` matters.

## [0.3.0] - 2026-07-18

### Fixed
- Hardened acknowledging against a self-echo reentrancy hazard: on a real
  server, our own notification writes (during arm/ack/disarm) can be
  redelivered back through the same subscription used to detect external
  changes, synchronously, before the write call even returns. Previously
  this was only filtered by matching the delta's source string against
  our own plugin id - now guarded unconditionally by a synchronous
  reentrancy flag as well, and `state` is updated before the notification
  write rather than after, so acknowledging can no longer be misread as
  an external change and reliably lands on "armed" with a full-length
  timer - never "disarmed".

### Added
- Reconciles with external changes to the notification path: if another
  plugin, webapp, or device writes an escalation state directly, the
  switch snaps to that stage with a fresh window; clearing it (or
  writing any non-stage state) while armed/escalated is treated as an
  acknowledgement. Ignored entirely while disarmed. The plugin's own
  writes are recognized by source and never reprocessed, so this can't
  loop. REST API and webapp both reflect the reconciled state
  immediately (webapp within its next ~1s poll).
- REST API documented as an OpenAPI 3.0 definition (`openApi.json`),
  exposed via `plugin.getOpenApi()` per SignalK's plugin convention -
  browsable in the server Admin UI under Documentation -> OpenAPI.

## [0.2.0] - 2026-07-18

### Added
- App-store screenshots (640x480) for the armed (light and dark theme),
  warn, and emergency states, wired up via `package.json`'s
  `signalk.screenshots`.
- App icon/favicon (`public/assets/icons/icon-512.png`), wired up as the
  browser favicon and as the SignalK admin UI app-list icon
  (`package.json`'s `signalk.appIcon`). Not used anywhere inside the
  webapp's own UI.
- Webapp plays a second bundled sound while in `alarm`: once immediately
  on entering the stage, then every 10s, stopping the moment the stage
  changes away from `alarm` (escalating to emergency or being
  acknowledged). Shares the same autoplay-unlock mechanism as the
  emergency siren. Sound is "Space-Intercom-Emergency" by electrobadger
  (Freesound.org), CC0 - see `public/audio/NOTICE.md`.
- Webapp plays a bundled siren sound, looped at full volume, the instant
  `emergency` is reached; stops the instant it's acknowledged. Includes
  an autoplay-policy "unlock" on the page's first tap/click so the siren
  can start later without needing a fresh user gesture right at the
  emergency moment. Siren is "High Frequency Siren Model D" by
  loganzsound (Freesound.org), CC0 - see `public/audio/NOTICE.md`.

### Changed
- Daylight (light theme) escalation colors: alert is light yellow, warn
  is bright yellow, alarm and emergency are fire-engine red; emergency
  additionally gets a thick, constant yellow outline while the
  background blinks. Alert/warn switched to dark text for readability
  against their new light backgrounds. Dark theme is intentionally
  unchanged (stays within its red-shifted night-vision palette).
- Emergency's call-to-action text is now "TAP HERE" in much larger,
  bolder letters instead of the usual "Tap to acknowledge".
- Emergency blink is now much faster and sharper (hard flash + slight
  scale pulse, ~3.5x/sec) instead of a slow smooth fade, for a more
  urgent feel.
- Emergency now blinks the whole state button (background alternates
  between two red shades), not just the outline.
- Webapp now clearly flags a lost connection to the SignalK server: a
  prominent banner appears, the state button and progress bar are dimmed
  to mark the data as stale, and the last known state (with a timestamp)
  stays visible rather than freezing silently or blanking out. Recovers
  automatically once polling succeeds again.
- Merged the state display and the ack/arm button into a single button:
  it now shows the stage, the remaining time in that stage's window, and
  doubles as the tap-to-acknowledge/tap-to-arm action.
- Progress bar now fills (grows toward 100% as the deadline approaches)
  instead of draining.
- Moved the disarm button out of the action row and into the top
  toolbar, next to the theme toggle.
- Disarm now asks for confirmation (native `confirm()`, matching the
  convention used for destructive actions in his other plugins) before
  actually disarming.
- Webapp redesign: removed the title bar; the current-state indicator is
  now a dedicated (non-interactive) button, with a horizontal countdown
  progress bar between it and the arm/reset button; the disarm button now
  sits next to arm/reset instead of below it.
- Added a light/dark theme toggle to the webapp, matching
  `signalk-stowage-mgmt`'s palette convention (dark mode red-shifted for
  night vision).
- State-button coloring: yellow on `warn`, red on `alarm`, and a blinking
  outline once escalated to `emergency`.

## [0.1.0] - 2026-07-18

### Added
- Initial scaffold: watch dead man's switch plugin.
- Periodic "are you still there?" check-in, raised as a SignalK notification
  at `notifications.security.deadmansswitch` (path configurable).
- Automatic escalation through `alert` -> `warn` -> `alarm` -> `emergency`
  notification states if not acknowledged; `emergency` is terminal (no
  further auto-escalation) until acknowledged.
- Acknowledgement, at any stage, clears the notification and restarts the
  check-in interval.
- REST API (`/status`, `/ack`, `/arm`, `/disarm`) so both the companion
  webapp and an external ack source (e.g. a physical hardware button) can
  drive the switch.
- Companion webapp: large ack button with a live countdown, color-coded by
  current stage.
- Native SignalK plugin config schema: armed-on-start, check interval, and
  per-stage escalation windows.
