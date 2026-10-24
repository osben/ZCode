# Chromium hardware acceleration setting

## Background

The ZCode desktop app runs on Electron/Chromium. Some GPU or driver environments can show blank screens,
crashes or rendering glitches in GPU initialization, page compositing or the WebGL path. Electron allows
`app.disableHardwareAcceleration()` only before `app.ready`, so the product switch must be saved as a
startup-time configuration and take effect on the next launch.

## Product semantics

- Setting name: Chrome hardware acceleration.
- Default: on.
- When turned off: the next desktop launch calls `app.disableHardwareAcceleration()`.
- When turned on: `app.disableHardwareAcceleration()` is not called, restoring Electron/Chromium default
  hardware acceleration behavior.
- After a change the user must be prompted to restart for it to take effect; there is no runtime hot switch.
- Linux AppImage deep link `.desktop Exec` argument sync is out of scope.

## Implementation boundary

- The config field is written to the global `AppSettings` and expresses only desktop startup behavior; Web and
  mobile produce no platform action when they read this field.
- Early at startup, `~/.zcode/v2/setting.json` is read with a synchronous file read, so the read does not
  happen too late (after `createSettingService().get()` or `app.whenReady()`).
- Read failure, missing config or an invalid config type all fall back to the default (on) and do not affect app
  startup.
- The UI shows the switch only on the desktop settings page, with copy that says turning off hardware
  acceleration can avoid some GPU/driver problems and that it takes effect after restart.

## Verification

- Unit tests cover the settings schema default and patch.
- Unit tests cover startup config extraction and the `app.disableHardwareAcceleration()` call boundary.
- Unit tests cover desktop switch rendering and callbacks on the settings page.
- Run `pnpm typecheck` and `pnpm lint` afterwards.
