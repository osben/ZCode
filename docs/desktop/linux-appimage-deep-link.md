# Linux AppImage deep link callback

## Background

Linux `.deb` / `.rpm` packages register the `zcode://` protocol through a system-level desktop entry, so the
login callback reliably returns to the installed app. An AppImage run directly has no fixed install entry; ZCode
writes the user-level `~/.local/share/applications/zcode.desktop` at startup so the browser-login `zcode://...`
can be handed to the current AppImage (provided no system-level entry with the same ID exists, see "Coexistence
with system installs" below).

A user on Ubuntu 24.04 + NVIDIA found that when manually launching the AppImage with `--no-sandbox`,
`--disable-gpu`, `--use-gl=swiftshader` and so on, the window and login page open; but when the browser callback
triggers the `.desktop Exec`, the system relaunches the bare AppImage path without those arguments, the process
crashes during Electron sandbox/GPU initialization, and the app stays stuck at "waiting for browser callback".

## Approach

- Only in the AppImage case use the `APPIMAGE` environment variable as the protocol handler executable, provided
  there is no system-level entry with the same ID (when one exists, user-level writing is skipped, see
  "Coexistence with system installs").
- In the AppImage case, keep from the current `process.argv` a small set of safe startup switches that affect
  whether Electron/Chromium starts, and write them to `.desktop Exec`.
- `.deb`, dev mode and ordinary binary installs keep writing the bare executable and do not copy the current
  argv.
- Do not persist one-off or sensitive arguments such as the deep link URL, workspace path, debug port or user
  data directory.

Switches currently allowed to persist:

- `--no-sandbox`
- `--disable-gpu`
- `--disable-software-rasterizer`
- `--use-gl=...`
- `--use-angle=...`
- `--disable-features=...`
- `--enable-features=...`

## Coexistence with system installs (rpm/deb)

A user-level desktop entry always takes priority over a system-level entry with the same ID in XDG resolution
(`~/.local/share/applications` comes before `/usr/share/applications`). Historically, a user-level
`zcode.desktop` written by an old AppImage kept shadowing `/usr/share/applications/zcode.desktop` after the user
migrated to rpm/deb, so shortcuts and the `zcode://` callback still pointed at the old AppImage (while the file
existed) or broke (after the file was deleted). The registration logic therefore works in this priority order:

1. At startup, probe for a system-level `zcode.desktop` along `XDG_DATA_DIRS` (default
   `/usr/local/share:/usr/share`); it **must be a regular file** to count as a valid system entry.
2. **When a system-level entry exists:** an AppImage run no longer writes the user-level same-name entry or the
   user-level icon, avoiding shadowing the system install again; when running in a system-install form such as
   rpm/deb, the leftover user-level entry written by this app is cleaned up. Ownership is recognized by the
   marker line `Comment=ZCode Desktop App`: only entries carrying that marker are deleted; a user's hand-written
   custom `zcode.desktop` (no marker, read failure, or ownership cannot be confirmed) is always kept.
3. **When no system-level entry exists:** the original AppImage user-level registration behavior is unchanged.

Cleanup and read failures only log a `warn` degradation and do not block the `update-desktop-database` /
`xdg-mime` protocol registration.

## Boundary

This only fixes the loss of startup arguments on the AppImage protocol-callback relaunch; it does not change
OAuth state routing, single-instance forwarding or `.deb` protocol registration semantics. If the user's
environment still needs `chrome-sandbox` SUID or `libfuse2`, the install docs must say so separately.
