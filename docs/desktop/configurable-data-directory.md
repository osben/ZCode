# Configurable data storage directory

## Overview

App data is stored in `~/.zcode/v2/` by default (`~` is `os.homedir()`). The user can change the root
corresponding to `~` in "Settings -> General -> Data storage path" (设置 → 通用 → 数据存储路径); the
`.zcode/v2` suffix cannot be changed.

## Directory layout

```
<dataBaseDir>/.zcode/v2/          ← configurable data directory
  ├── logs/
  ├── perf/
  ├── sessions/
  ├── tasks-index.sqlite
  ├── telemetry-state.json
  └── ...

<dataBaseDir>/.zcode/workspace/default/  ← real working directory shared by non-project conversations

~/.zcode/v2/setting.json          ← Bootstrap pointer (always under the default homedir)
```

## Bootstrap mechanism

`setting.json` always and only exists at the default `homedir()/.zcode/v2/setting.json` and does not follow a
custom directory migration. It is the bootstrap entry of the whole path switch:

1. Main process starts -> reads `dataBaseDir` from `homedir()/.zcode/v2/setting.json`.
2. If set -> calls `setDataBaseDir(dir)` to switch all later data paths.
3. When starting the host process it is passed to the child through the environment variable
   `ZCODE_DATA_BASE_DIR`.

Path resolution priority (`getDataBaseDir()`):

1. The value set by `setDataBaseDir()` (main-process bootstrap).
2. `process.env.ZCODE_DATA_BASE_DIR` (received by the host process through the environment variable).
3. `os.homedir()` (fallback default).

## Copy behavior

When the user changes the data directory, old-directory data is copied to the new one:

| Rule                                                      | Description                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`setting.json` and its transient files are not copied** | `setting.json` is the bootstrap pointer; `setting.json.lock` and `setting.json.*.tmp` are atomic-write intermediates, all existing only under the default homedir; copying them would cause migration races or old/new directory conflicts |
| **Existing files are not overwritten**                    | `force: false`: if the target directory already has a same-name file, the target version is kept. This prevents newly produced data being overwritten by an old copy when restoring to the old directory                                   |
| **New files are copied normally**                         | Files present in the source but not the target are copied                                                                                                                                                                                  |
| **Conversation workspace not yet migrated**               | `copyDataDirectory()` currently copies only `.zcode/v2`; non-overwriting copy of `.zcode/workspace` is target semantics, to be included in data-directory migration after CDD02 / later work                                               |

### Example scenarios

**Forward migration** (`/Users/a` -> `/Users/a/test`):

- All files under `/Users/a/.zcode/v2/` (except setting.json) are copied to `/Users/a/test/.zcode/v2/`.
- The target directory is created automatically if absent.

**Restore** (`/Users/a/test` -> `/Users/a`):

- Files under `/Users/a/test/.zcode/v2/` are copied to `/Users/a/.zcode/v2/`.
- Files newly produced in `/Users/a/.zcode/v2/` in the meantime are not overwritten.
- `setting.json` is never affected.

## Windows install directory protection

On Windows, the data root must not be set to ZCode's install directory or a subdirectory of it, because the
install directory is managed by the installer and auto-update flow; putting `<dataBaseDir>/.zcode/v2/` there
could let a later update overwrite or clean user data.

Blocking rules:

| Source                                | Example                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Current desktop app install directory | parent of `process.resourcesPath`, e.g. `C:\Users\{UserName}\AppData\Local\Programs\ZCode` |
| Program Files install directory       | `%ProgramFiles%\ZCode`, `%ProgramFiles(x86)%\ZCode`, `%ProgramW6432%\ZCode`                |
| User LocalAppData install directory   | `%LOCALAPPDATA%\Programs\ZCode`                                                            |

`packages/desktop/src/main/desktopRuntimeEnv.ts` passes the current install directory to the host process as
`ZCODE_WINDOWS_APP_INSTALL_DIR` in the Windows packaged state. `packages/services/src/paths.ts` does a
case-insensitive "equal to or under" check by Windows path rules at the service layer, and
`packages/services/src/setting/settingService.ts` runs that check before copying data. The UI only shows the
error and is not the sole safety boundary.

### Installer blocking protection

The Windows installer does not forbid the user choosing any install directory. To cover users whose historical
version already put data in the install directory, the NSIS assisted installer checks, after the user picks the
install directory and before any file is written, whether the final install directory or its subdirectories
contain `.zcode`:

1. Compute the final install directory by electron-builder assisted installer's directory completion rule.
2. If the user picked a parent directory, electron-builder installs to `$INSTDIR\ZCode`, so check
   `$INSTDIR\ZCode` and its subdirectories.
3. On a hit, show a blocking page saying the install directory or its subdirectories contain `.zcode` data and
   that continuing to install or update would make the installer clean historical sessions and configuration.
4. The blocking page disables "Next", widens the "Back" button and changes its text to "重选目录" (re-pick
   directory).
5. After clicking "重选目录" the user returns to the directory page and must choose another install directory
   to continue.
6. The user can still cancel and exit the installer; there is no "ignore and continue" entry.
7. A silent install that hits `.zcode` exits with failure directly, so automated installs cannot bypass the data
   protection.

This blocking protection applies only to the installer flow and does not replace the settings page's data
migration validation.

## UI flow

1. A read-only path box shows the currently effective path by default (the configured path or homedir).
2. Click "选择文件夹" (choose folder) and pick the new root through the system directory dialog.
3. After confirming, click "保存" (save).
4. The button shows a loading animation, the choose button is disabled, and the hint reads "正在复制数据，请勿关闭应用…"
   (copying data, do not close the app).
5. Copy done -> hint "数据已保存，重启应用后生效。" (data saved, takes effect after restart).
6. Copy failed -> hint "数据复制失败，路径未更改。" (data copy failed, path unchanged; in red); the user may
   re-pick and retry.
7. On Windows, if the ZCode install directory or a subdirectory is chosen -> hint "不能选择 ZCode 安装目录作为数据存储路径"
   (the ZCode install directory cannot be used as the data storage path), and the path is not written to config.
8. The new path takes effect after the user restarts the app.

## Confirmed migration boundary

The user confirmed the following target semantics on 2026-08-10:

1. App `.zcode/v2` and non-project conversation `.zcode/workspace` migrate together.
2. Migration may start only when the current conversation is idle.
3. After a successful save the app enters a restart-pending state; the target product state should prevent
   further writes to the old App data directory.
4. If the target directory already holds ZCode data, migration is refused, with no per-file or SQLite merge.
5. After a full cold restart, pre-migration task history is still visible and the same task can continue the
   conversation.
6. `dataBaseDir` changes only the App data directory; CLI user resources still use `<HOME>/.zcode/cli`, and
   in-project `.zcode/*` keeps its original path.

The first automated case `CDD01` does not change the above product behavior and verifies only the currently
safely executable representative path: Desktop local `desktop-continuous`, task idle, empty target directory,
no business operation after saving and an immediate full restart of Electron, Host and Agent.

```text
old App root + idle task
          |
          | choose empty target + save
          v
restart-required UI
          |
          | no more writes in the old process
          | immediate full cold restart
          v
new App root
          +--> old task history is visible
          +--> same task accepts a follow-up
          +--> App task-index writes stay under the new root
          +--> CLI stays under <HOME>/.zcode/cli
```

The idle state and immediate restart of `CDD01` are test preconditions/timing constraints and do not mean the
product currently blocks busy migration or writes after saving mechanically; refusing a non-empty target is not
proven by this case either. `copyDataDirectory()` currently copies only `.zcode/v2` and does not yet implement
the `.zcode/workspace` migration this spec requires, so the workspace assertion is recorded separately as a bug
candidate, and `CDD01` passing must not be read as fully satisfying item 1.

## Related code

| File                                              | Responsibility                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/services/src/paths.ts`                  | `setDataBaseDir` / `getDataBaseDir` / `getAppConfigDir` / `copyDataDirectory` / Windows install-directory validation |
| `packages/services/src/setting/settingService.ts` | `updateDataBaseDir()`: validate + copy + persist                                                                     |
| `packages/services/src/setting/setting.ts`        | `ISettingService` interface definition                                                                               |
| `packages/shared/src/protocol.ts`                 | `AppSettings.dataBaseDir` type                                                                                       |
| `packages/shared/src/validation.ts`               | zod schema                                                                                                           |
| `packages/desktop/build/installer.nsh`            | Windows installer blocks installs when `.zcode` already exists in the install directory, before writing files        |
| `packages/desktop/src/main/index.ts`              | main-process bootstrap read                                                                                          |
| `packages/desktop/src/main/desktopRuntimeEnv.ts`  | `buildHostProcessEnv` passes the environment variable                                                                |
| `packages/ui/src/settingsPageHelpers.tsx`         | UI input box + save state management                                                                                 |
| `packages/ui/src/SettingsPage.tsx`                | page-level state + service calls                                                                                     |
