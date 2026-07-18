# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
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
