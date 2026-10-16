# Desktop Process Naming

## Goal

To make desktop-related processes easier to find in both development and runtime, the app adopts a unified `zcode-*` naming convention.

## Naming Rules

- main process: `zcode-main`
- renderer processes:
  - Main window: `zcode-renderer-main`
  - Remote window: `zcode-renderer-remote-<host>`
  - Resource Manager: `zcode-renderer-resource-manager`
- host utility process：`zcode-host-<label>`
- Agent child process: `zcode-agent-<provider>-<workspace>`

The shared string-construction logic is centralized in `packages/shared/src/process-names.ts`, avoiding scattered hard-coded names across main / host / preload / services.

## Implementation Entry Points

- `process.title`
- Set by main / host / renderer preload to improve discoverability with `ps` / `pgrep`
- `utilityProcess.fork({ serviceName })`
- Makes a stable host name available to `app.getAppMetrics()` and Resource Manager
- `spawn({ argv0 })`
- Gives Agent child processes a consistent, searchable name

## Boundaries

- In development, the “wrapper executable name” in macOS Activity Monitor or another system process manager may still appear as `Electron` / `Electron Helper`.
- `process.title` is better suited to search contexts such as `ps` / `pgrep` / the in-app Resource Manager; it does not guarantee that every system GUI displays the name exactly this way.
- Electron built-in child processes such as GPU / Network Service are consistently mapped to `zcode-*` in the in-app Resource Manager, but system-level display remains controlled by Electron / Chromium.
