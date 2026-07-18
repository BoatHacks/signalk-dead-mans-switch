# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
