# Linux AppImage Desktop Icon Integration

## Background

Running the Linux AppImage directly does not reliably write a system-level `.desktop` file and hicolor icon theme the way the deb package does. Some desktop environments' taskbars/docks do not rely on the Electron `BrowserWindow.icon` alone; they match running windows via the `.desktop` `Icon` and `StartupWMClass`, so a directly run AppImage can show the default icon.

## Goals

- Enhance only the Linux AppImage direct-run experience; deb, Windows, macOS, local dev, and remote-control flows are unaffected.
- On startup, refresh the user-level `zcode.desktop` so the `zcode://` protocol callback keeps pointing at the current AppImage path — write the user-level file only when no system-level regular `zcode.desktop` file exists in `XDG_DATA_DIRS` (default `/usr/local/share:/usr/share`). When a system-level entry exists (rpm/deb installed), skip the user-level write and icon install to avoid shadowing the system install; the system-install path also cleans up legacy user-level entries marked `Comment=ZCode Desktop App` (see `docs/desktop/linux-appimage-deep-link.md`).
- On startup, install the bundled 512x512 PNG into the user-level hicolor icon theme to raise the chance that `Icon=zcode` is matched by taskbars/docks.

## Implementation

On Linux packaged startup, `registerDeepLinkProtocol` receives the current bundled 512x512 icon path. `registerLinuxDeepLinkProtocol` resolves the user data directory preferring `XDG_DATA_HOME`, falling back to `~/.local/share`. It writes:

```text
$XDG_DATA_HOME/icons/hicolor/512x512/apps/zcode.png
$XDG_DATA_HOME/applications/zcode.desktop
```

only when the `APPIMAGE` env var is present, the icon source file exists, and no system-level regular `zcode.desktop` file exists in `XDG_DATA_DIRS`. After writing, refresh best-effort:

```text
gtk-update-icon-cache -f -t $XDG_DATA_HOME/icons/hicolor
update-desktop-database $XDG_DATA_HOME/applications
xdg-mime default zcode.desktop x-scheme-handler/zcode
```

Missing, failing, or timed-out refresh commands only log `warn`. External commands must have short timeouts, and `gtk-update-icon-cache` is skipped when the icon is unchanged; startup must never block unboundedly.

Core deep-link registration must run before icon installation. Icon install is optional desktop integration: failures in directory creation, file reads, copying, or cache refresh degrade to a `warn` log and never block the `.desktop` write or the `xdg-mime` protocol association.

## Boundaries

This cannot guarantee taskbar icon display on every Linux desktop environment. Wayland/X11, GNOME/KDE/other docks, running the AppImage straight from a terminal, and icon-cache policies all affect matching. For stable desktop integration, the deb package remains the recommended path.
