# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
