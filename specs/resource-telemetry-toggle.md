# Resource telemetry toggle

Status: implemented. Unit tests cover schema defaults, main gating and the sync channel; the desktop E2E PRT-023 enables the toggle before asserting events but has not been run.

## Problem

`packages/desktop/src/main/desktopResourceTelemetry.ts` samples unconditionally in main: every 10 s it reads `app.getAppMetrics()`, system, CLI, MCP and renderer-heap sample sources, aggregates them into windows and every 5 min sends `perf_process_window` / `perf_system_window` (plus immediate `perf_tool_exec_resource`) through the ARMS RUM SDK (`@arms/rum-electron`, Alibaba Cloud). Every ~60 s it also writes a local `[memory]` main-process log line.

Where the data goes is decided at build time by `ZCODE_ARMS_RUM_ENDPOINT` (`scripts/build-time-config.mjs`: env, then `config/private/build-defaults.json`). Upstream release builds bake in an Alibaba SLS endpoint; fork builds have neither source, so the SDK initialises with `enable: false` and nothing leaves the machine. The sampling loop still costs main-process CPU and timers, and the user cannot switch it off.

## Product rules

1. **One fork setting, `resourceTelemetryEnabled`, default `false`.** When off, main runs no resource sampling timers, sends no resource events (window or tool-exec) and writes no `[memory]` main log line.
2. **Live toggle.** Changing the setting starts or stops sampling immediately, with no restart.
3. **Turning off drops, never flushes.** Disabling clears any partial window without reporting it. Normal shutdown drains partial windows only while sampling is active.
4. **Scope is resource telemetry only.** Stability/crash, network, MCP, data-size, database-startup, the renderer RUM collectors and the warehouse event reporter (`ZCODE_TELEMETRY_REPORT_ENDPOINT`) are unaffected. The renderer keeps its own 60 s heap diagnostics; main ignores the readings while off.
5. **Desktop only.** The switch lives in Settings → General next to "Keep awake while running" and is shown only on desktop.

## State owner and storage

- Owner: the fork settings sidecar `~/.zcode/v2/fork-settings.json` (`FORK_SETTING_KEYS` in `packages/shared/src/forkAppSettings.ts`). The default (`false`) is materialised by `forkAppSettingsSchema` and never written back, so it is not stored in `setting.json` (upstream would strip it).
- Runtime owner: `desktopResourceTelemetry.ts`. Its running sampling timer is the single "enabled" gate: `registerDesktopResourceTelemetry` starts it, `stopDesktopResourceTelemetry` clears it, and `ingestToolExecResource` and the shutdown flush both check it. Main applies the setting only through `setDesktopResourceTelemetryEnabled(enabled, logger)` (`desktopResourceTelemetryToggle.ts`, a separate file because `desktopResourceTelemetry.ts` is at the 400-line limit). A repeated enable restarts the timers instead of stacking them.

## Event order

```
startup:   mainSettingService.get() ──► bootstrapSettings.resourceTelemetryEnabled
           configureDesktopResourceTelemetry(ctx)            (always: shared ARMS properties)
           setDesktopResourceTelemetryEnabled(flag, logger)  (timers only when true)

toggle:    Settings Switch ──► useSettings.update({resourceTelemetryEnabled})
             ├─► settingService.update  ──► fork-settings.json   (persist first)
             └─► platform.syncAppSettings(patch) ──► IPC SyncAppSettings
                   main: appSettingsSyncPatchSchema (base + resourceTelemetryEnabled)
                   └─► syncImmediateAppSettings ──► setDesktopResourceTelemetryEnabled

shutdown:  stopDesktopResourceTelemetry({flushPendingWindows:true})  (drains only if active)
```

`appSettingsPatchSchema` strips fork keys, so the main sync handler extends it with exactly this fork key; without that the switch would persist but main would never react.

## Acceptance scenarios

1. Fresh profile: `forkAppSettingsSchema.parse({}).resourceTelemetryEnabled === false`; main starts no sampling timer and logs no `[resource] sampling started`.
2. Settings on: sampling starts at once; after the report interval, window events are emitted.
3. Settings off while running: timers stop, partial window is dropped (no `sendCustom`), later `ingestToolExecResource` calls are ignored.
4. Shutdown while off: no resource event is sent.
5. Restart with the setting on: sampling starts at boot from `bootstrapSettings`.
6. PRT-023 (desktop E2E) enables the setting through `syncAppSettings` before waiting for window events.
