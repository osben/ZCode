# Linux close-to-tray spec

## Background and goal

Windows already supports "hide to tray on window close" (the `closeToTrayOnWindows` setting, default on). Linux
used to go "confirm quit -> `app.quit()`" on window close, which contradicts ZCode's product intent as a
long-running background app (prevent accidental closing from interrupting agent sessions).

macOS's "closing the window does not quit" relies on the system app lifecycle model (Dock persistence + running
indicator); Linux desktops have no such model, and the only resident mechanism with a visible entry on Linux is
the system tray (StatusNotifierItem). So Linux aligns with the **Windows tray mode**, not the mac mode.

Tray support on Linux desktops is not uniform:

- KDE / XFCE etc. natively provide a StatusNotifierItem host.
- GNOME removed the system tray by default since 3.26; users must install an AppIndicator-type extension.
- Electron `new Tray()` on GNOME without a host **succeeds but never renders and reports no error**, a silent
  failure.

Core design principle: **residency depends not on whether the tray was created but on whether the tray can
really be rendered; when undetectable, degrade to the existing "confirm quit" path, so the user is never
stranded.**

## Behavior matrix

| Platform / environment   | Setting switch             | Default | Window-close behavior                                       | Tray                                      |
| ------------------------ | -------------------------- | ------- | ----------------------------------------------------------- | ----------------------------------------- |
| Windows                  | operable (unchanged)       | on      | hide and stay resident (unchanged)                          | resident                                  |
| Linux + tray available   | operable                   | **off** | after the user turns it on: hide and stay resident          | created after capability detection passes |
| Linux + tray unavailable | **greyed out, locked off** | n/a     | existing "confirm quit" path, same as today                 | not created                               |
| macOS                    | setting not shown          | n/a     | system default (closing does not quit, Dock keeps it alive) | none (unchanged)                          |

Ways to bring a hidden resident window back: the tray icon (click/double-click restores; the menu includes quit)

- the existing `second-instance` restore (clicking the pin icon / desktop icon; already implemented, unchanged).

## Tray capability detection

### Detection signal

Whether the `org.kde.StatusNotifierWatcher` name on the session DBus has an owner:

- has owner -> an SNI host exists (KDE/XFCE natively; GNOME after installing an AppIndicator extension) -> tray
  available.
- no owner / query failure / timeout -> treated as "unavailable" (safe default).

**No hard-coded desktop-environment list** (no "GNOME means unsupported" judgment): one signal naturally covers
all desktop environments, and a new desktop needs no code change.

`XDG_CURRENT_DESKTOP` containing `gnome` (case-insensitive) -> flag `gnomeLike`, used only to decide whether the
greyed-out copy adds the "install an AppIndicator extension" hint.

### Detection implementation

Zero new dependencies: try system tools in turn to query `org.freedesktop.DBus.NameHasOwner` on the session bus:

1. `gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.kde.StatusNotifierWatcher`
   (standard on GNOME-family; output `(true,)` / `(false,)`).
2. `busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus NameHasOwner s "org.kde.StatusNotifierWatcher"`
   (standard on systemd-family; output `b true` / `b false`, the boolean unquoted; the parser also accepts the
   quoted variant).
3. `qdbus org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner org.kde.StatusNotifierWatcher`
   (Qt-family; output `true` / `false`).

Any tool giving a definite result returns; tool absent / execution failure / timeout (about 1.5 s) -> treated as
unavailable. The three tools cover mainstream distributions; the extreme environment missing all of them falls
to the safe default, behaving like default GNOME (no residency), and the user is never stranded.

### Cache and refresh (monitor)

The window-close path `handleDesktopWindowCloseRequest` is a synchronous callback and cannot await a probe, so
the main process keeps a **synchronous cache**:

```
createCloseToTrayCapabilityMonitor
  ├─ getSync(): returns the cached value on Linux; returns null before the first probe finishes after start (treated as unavailable, safe path)
  └─ refresh(): probe asynchronously and update the cache
```

Refresh moments (no periodic polling, to avoid resident child processes):

- the first probe after app ready;
- when the settings page queries through IPC (re-probe if the cache is stale by more than 10 s), so a user who
  has installed the extension and opens the settings page sees the switch released from grey.

Startup timing note: in an autostart scenario Linux's StatusNotifierWatcher may start later than ZCode, so the
first probe is false; the user opening settings re-probes and corrects it; in the meantime the window close goes
the safe path (confirm quit), which is acceptable.

### Tray creation timing and merged "can hide" capability (CR-01)

- Windows: created after app ready, `trayReady` set from the creation result.
- Linux: **created after the capability probe passes** (not created if the probe fails, avoiding registering a
  DBus name nobody renders); tray creation follows the capability, not the setting switch (same semantics as
  Windows: the setting only controls whether closing the window stays resident, not tray residency); if the
  capability becomes available while the tray is not built when the settings page queries over IPC, it is built
  then.
- The Linux tray icon uses PNG (dev: `build/icon.png`; packaged: `resources/icon.png`, extraResources already
  bundles it unconditionally so packaging config needs no change); Windows keeps `tray_icon.ico`.

**Final decision of the "can hide" capability (`resolveCloseToTraySupported`):** a DBus watcher existing only
proves the desktop may have a host, not that the Electron `Tray` instance was created successfully (missing icon,
session not ready and so on make `new Tray()` throw). Before hiding the window, the final user entry must be
verified to exist:

```
win32:  trayReady
linux:  trayReady ∧ DBus capability probe passed
other:  cannot hide
```

Both the close branch and the settings-page capability query (IPC) read this merged result; if either fails they
go confirm-quit / greyed out, ruling out "DBus available but Tray creation failed, so hiding strands the user".

## Window-close path

The hide-branch condition of `handleDesktopWindowCloseRequest` generalizes to:

```
window close request
  ├─ (win32 or (linux and closeToTraySupported)) + setting on + not forced quit/explicit quit
  │     → win.hide() stay resident (existing Windows branch behavior)
  ├─ darwin / not the last window → system default
  └─ rest (Linux without tray, or setting off)
        → existing "last window confirm quit" path (in production with running sessions shows a confirm dialog)
```

`closeToTraySupported` takes the monitor's synchronous cache (null counts as false, the safe default). With the
setting on but the capability unavailable at the instant of closing -> do not stay resident, go confirm quit;
"hidden but nowhere to bring it back" cannot occur.

`window-all-closed` needs no change: `win.hide()` only hides and does not destroy the window, so it does not
fire.

## Setting

### Storage key compatibility

The `closeToTrayOnWindows` storage key and schema are kept (avoiding migration cost for existing settings), and
only the semantics extend to Linux. Internal naming such as function parameters changes to the platform-neutral
`closeToTray`.

### Linux default migration

Problem: existing Linux users have already had `closeToTrayOnWindows` normalized to `true` by
`migrateCloseToTrayOnWindowsDefault` (shared has no platform concept), and Linux previously **had no setting
entry** (UI shown only on Windows), so an existing true cannot be an explicit Linux user choice.

Approach: a new marker field `closeToTrayLinuxMigrationInitialized` (schema default false). When the main-process
bootstrap loads settings:

```
Linux && !closeToTrayLinuxMigrationInitialized
  → force closeToTrayOnWindows false (reset default off) + write initialized=true
Linux && initialized → closeToTrayOnWindows ?? false (respect the user's explicit choice)
non-Linux            → unchanged (closeToTrayOnWindows ?? true, marker field not read)
```

A new Linux user completes the reset at first launch, defaulting to off.

**Persistence timing (CR-02):** the migration write must complete (`await`) before startup continues (before
windows are created / the renderer reads settings), so the settings page always reads the post-migration value;
local JSON write time is negligible. **On write failure** (disk full / read-only etc.): the in-memory value falls
back to the current value of the persisted file (`resolveCloseToTrayRuntimeValue`), keeping "the file is the only
trusted source", so main behavior and the settings-page display agree (both the file value) and there is no dual
data source; the migration retries on the next start, and during the failure Linux users keep the old
not-yet-migrated behavior.

### Channel (state hierarchy)

```
main process (the only data source)
  closeToTrayCapabilityMonitor ──cache──→ close branch (getSync)
  mainSettingService (settings persistence) ──closeToTrayOnWindows──→ close branch
        │ ipcMain.handle(GetCloseToTrayCapability)
        ▼
preload bridge (window.zcode.getCloseToTrayCapability)
        ▼
renderer desktopPlatform (IPlatformService adapter)
        ▼
SettingsPage (grey-out decision; Web/remote control has no bridge and does not implement it, the setting is only shown on desktop anyway)
```

Returned DTO: `{ supported: boolean; gnomeLikeWithoutTray: boolean }` (the latter = gnomeLike && !supported,
deciding the copy).

### Settings-page UI

- The display condition widens from `isWindowsDesktop` to `isWindowsDesktop || isLinuxDesktop`.
- On Linux with `capability` loading/unavailable -> the Switch is greyed out (`disabled`).
- Grey-out description (zh-CN, kept verbatim): "当前桌面环境未提供系统托盘,无法启用关闭驻留"
  (this desktop environment provides no system tray, so close-resident cannot be enabled); when
  `gnomeLikeWithoutTray`, append: "GNOME 用户可安装 AppIndicator 类扩展后重启应用启用" (GNOME users can install an
  AppIndicator-type extension and restart the app to enable it).
- Windows does not query capability and the switch is directly usable (unchanged).

## i18n

- Reuse the existing `settings.closeToTrayOnWindows` (its copy "关闭窗口时隐藏到托盘", hide to tray when closing
  the window, is platform-neutral).
- Add `settings.closeToTrayUnavailable` and `settings.closeToTrayGnomeHint` (zh and en).

## Limits and follow-ups (not this phase)

- **Tray icon asset:** at 22~24px on a Linux tray, using the colored app PNG directly is only moderately
  recognizable; later produce monochrome symbolic-style icons (one each for dark and light themes).
- **Dynamic capability watching:** subscribing to DBus `NameOwnerChanged` could sense the watcher going online/
  offline in real time and create/destroy the tray dynamically; this phase covers the main scenario with
  "settings-page query refresh".
- **Real-machine verification items** (CI containers have no desktop session): KDE/XFCE tray interaction, GNOME
  before and after installing the extension, AppImage/deb/rpm/pacman package formats; listed as MR pending items.
- On GNOME, the left-click behavior depends on the AppIndicator extension implementation (it may pop up the menu
  instead of triggering `click`); `double-click` and the menu entry are the fallback.

## Test requirements

- Capability probe: mock the child-process executor, covering gdbus/busctl/qdbus output parsing, tool absent,
  timeout, and non-Linux passthrough.
- Close branch: linux + supported/unsupported x setting on/off matrix unit tests (add to the existing
  `desktopWindowLifecycle.test.ts`).
- Linux default reset: unit tests after extracting a pure function (uninitialized forces false; initialized
  respects an explicit value; non-Linux untouched).
- monitor: cache refresh and stale semantics.
