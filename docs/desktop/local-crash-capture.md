# Desktop local crash archive

The Desktop main process configures the crash dump path early in startup and keeps two chains:

- ARMS receives native crashes and Electron main exceptions for online monitoring (`appARMSBootstrap.ts`).
- A raw minidump copy is additionally archived locally for user or developer troubleshooting
  (`desktopCrashCapture.ts`).

The ARMS crash collector scans all dumps in the `live` directory. To keep dumps such as `hdc`,
`plugin-container` and `chrome-headless-shell` out of ZCode health metrics when descendants or external programs
inherit Crashpad, `beforeReport` first keeps events whose `binary_images` contain the current ZCode product
executable; but a binary hit alone does not prove a main-process crash. A dump without an explicit
`native_dump_process_role=main` is marked `native_dump_unattributed`: the raw diagnostic event is kept but it does
not enter App Crash / Crash-Free, so helper/utility crash loops sharing an executable on Linux/Windows do not
pollute product stability metrics. The role source must be a structured Crashpad dump annotation: the
`@arms/rum-electron` crash collector must locate the Crashpad info from the minidump stream directory, follow the
annotation's RVA references to read `process_type` / `ptype`, and pass it through as event `meta.process_type`;
the app side then normalizes `browser` to `main`. Scanning the whole dump to guess adjacent key/value bytes is
forbidden; same-name bytes not referenced by the Crashpad annotation structure are ignored. `meta.process` in the
event is only the app name and must not be a fallback for the process role; a missing or unparseable role must
stay `native_dump_unattributed`.

The trusted executable names are both the product app name and `basename(process.execPath)`: in production
packages they are usually the same; local dev runs actually use `Electron`, and Linux Preview uses
`zcode-preview`, so comparing only `app.getName()` with the dump module name is not enough. The local `archive`
still keeps the raw files; filtering online metrics does not change the local diagnostic chain.

## Directory layout

```
<appConfigDir>/crash/
  ├── live/        ← Electron / Crashpad real-time write directory (`app.setPath("crashDumps")`)
  └── archive/     ← the extra local copy ZCode keeps
```

`appConfigDir` defaults to `~/.zcode/v2/`; with a custom `dataBaseDir` the path is
`<dataBaseDir>/.zcode/v2/crash/` (relying on `desktopEarlyDataBaseDirBootstrap` to inject `dataBaseDir` before
crash initialization).

## Local archive retention

`archive/` only keeps raw minidumps for offline troubleshooting when online events are not enough to locate a
problem; it takes no part in Crashpad collection or ARMS reporting. To keep historical dumps from occupying user
disk without bound, the local archive follows these rules:

- keep at most the latest 5 `.dmp`;
- apart from the newest one, the archive total size must not exceed 100 MiB;
- the newest `.dmp` is always kept, even if it alone exceeds 100 MiB;
- deleting an old `.dmp` also deletes the same-name `.dmp.json` metadata; if the metadata deletion fails
  temporarily, later cleanup recognizes and retries deleting orphan metadata whose same-name regular `.dmp` no
  longer exists, and does not touch other JSON files;
- cleanup acts only on `archive/`; `live/` stays entirely managed by Electron Crashpad / ARMS.

Cleanup runs after each archive completes, keeping files by `.dmp` modification time from newest to oldest. This
limits historical accumulation while ensuring the most recent native crash always has a local raw scene for
analysis. If the newest single dump is itself huge, the directory may temporarily exceed 100 MiB; this is an
intentional exception to keep the latest crash diagnosable, not a strict disk quota.

## Startup order

1. `desktopEarlyDataBaseDirBootstrap`: synchronously reads `dataBaseDir` from `setting.json`.
2. `appCrashCaptureBootstrap`: configures `crashDumps` and archives `.dmp` leftovers from the previous run.
3. `appARMSBootstrap`: initializes ARMS (`collectors.crash: true`).
4. `index.ts`: `app.setPath("userData")` / `sessionData` and so on.
5. `registerCrashEventMonitor`: delayed archive after a renderer / child process crash (so the local copy exists
   even if the SDK cleans the live directory).

## Related files

- `packages/desktop/src/main/desktopDataBaseDirBootstrap.ts`
- `packages/desktop/src/main/desktopEarlyDataBaseDirBootstrap.ts`
- `packages/desktop/src/main/appCrashCaptureBootstrap.ts`
- `packages/desktop/src/main/desktopCrashCapture.ts`
- `packages/desktop/src/main/appARMSBootstrap.ts`
- `packages/desktop/src/main/index.ts`
