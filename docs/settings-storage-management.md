# Storage management

> Bash output is written to the system tmp directory first and falls back to `cli/exec` when that
> directory is unavailable. This page still measures only the existing `.zcode` data roots: tmp
> output is not counted and has no cleanup entry; historical and fallback `cli/exec` stays in tool
> output and temporary cache. File reads and open actions use the real output path and are not
> affected by the measured scope. Path contract: `tmpdir-storage-paths-spec.md`.

> Status: **implemented (2026-09-10)**. Rulings are in §8, implementation locations in §11.
> Location: **Resource Manager window → "Storage" tab** (ruling of 2026-09-10: moved as a whole out of
> Settings "Data and statistics" into the Resource Manager next to CPU / Memory; Settings no longer
> has an entry). Window architecture: `docs/electron/resource-manager.md`.

## 1. Background and current state

### 1.1 User need

On opening the tab, immediately start computing ZCode disk usage and show:

- how much space `.zcode` takes on each disk (volume);
- per disk, the data split by category (databases, logs, trajectories, ...) with drill-down to details;
- a cleanup action for cleanable categories (for example model-call trajectories).

### 1.2 There are actually two data roots

The app lets the user set a "data storage path" (`setting.json.dataBaseDir`), but **only the app-side
`v2` follows it**; agent-side data always stays in the user's home directory. Current facts:

| Writer                                                          | Root resolution                                                                                                | Follows "data storage path" | Code                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| app services (host process)                                     | `{dataBaseDir}/.zcode`, default `~/.zcode`                                                                     | yes                         | `packages/services/src/paths.ts` `getZCodeDataRootDir()`                         |
| migration when the "data storage path" changes                  | copies only `.zcode/v2`, copy not move                                                                         | n/a                         | `packages/services/src/paths.ts` `copyDataDirectory()`                           |
| zcode-cli (agent process)                                       | `storage.dir` in `~/.zcode/cli/config.json`, default `~/.zcode`; the app does **not** pass `ZCODE_STORAGE_DIR` | no                          | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:184`                    |
| model-call trajectory model-io                                  | directly `homedir()/.zcode/cli/{debug,rollout}`                                                                | no (hardcoded)              | `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` `getModelIOBaseDir` |
| hooks trust store / subagents / skills / commands               | read `storage.dir` from `~/.zcode/cli/config.json`                                                             | no                          | `packages/services/src/hooks/hooksService.ts:153-173` etc.                       |
| Computer Use Helper, log export references to the cli directory | `homedir()/.zcode/...`                                                                                         | no (hardcoded)              | `packages/desktop/src/main/exportLogs.ts:34-48`                                  |
| `v2/setting.json` itself                                        | always written in the real HOME (bootstrap file)                                                               | deliberately not            | `packages/services/src/setting/settingService.ts:36-46`                          |
| GLM provider workspace config directory                         | `getDataBaseDir()/.zcode/cli/...`, which coexists with the `~/.zcode/cli` the CLI reads (two conventions)      | yes                         | `packages/services/src/paths.ts:295-299, 355-362`                                |
| trajectory viewer reading model-io                              | scans both `homedir()` and `dataBaseDir`                                                                       | reads both                  | `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts:16-22`             |

Storage management therefore scans both roots:

```text
R1 = ~/.zcode                       (always exists: cli/, agents/, computer-use/, old v2 copy, ...)
R2 = {dataBaseDir}/.zcode           (only when a data storage path is set and differs from HOME: v2/, workspace/, export-log/, feedback/, ...)
```

This phase only **shows both roots as they are**; it does not fix the split. Whether the CLI should
follow `dataBaseDir` is a separate design decision (§8). The E2E
`conversation-session-configurable-data-directory.test.ts` asserts that after switching,
`{custom}/.zcode/cli` does not exist and `~/.zcode/cli/db/db.sqlite` still does; this is an
intentionally kept product boundary.

### 1.3 Real-machine directory survey (2026-09-10, dev machine, 25 GB total)

| Path                                                                                                                                                                    | Size     | Writer / purpose                                                                    | Category                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `cli/db/backup`, `cli/db/backups`, `cli/db/*.bak`, `cli/db/*.backup-*`                                                                                                  | ~6 GB    | CLI DB pre-migration backups                                                        | backups                                                                  |
| `cli/db/db.sqlite(+wal/shm)`                                                                                                                                            | 0.77 GB  | CLI session/task DB (in use)                                                        | session records and databases                                            |
| `backup/*` (session-projects, before-\*-restore, ...)                                                                                                                   | 7.2 GB   | script/migration backups, incl. full cli-db and v2 copies                           | backups                                                                  |
| `v2/dev/stdio-traffic`                                                                                                                                                  | 2.4 GB   | dev stdio protocol capture (`zcodeStdioTapDevConfig.ts`)                            | dev diagnostic captures                                                  |
| `v2/migrations`, `v2/backup`, `v2/*.bak`, `v2/setting.json.corrupt-*`, `v2/config.json.pre-*`                                                                           | ~0.8 GB  | pre-migration snapshots / corrupt-file keepsakes                                    | backups                                                                  |
| `v2/acp-config`, `v2/acp-traffic-proxy`, `v2/acp-auth`                                                                                                                  | ~0.8 GB  | retired ACP runtime directories (exportLogs already skips them)                     | dev diagnostic captures / config                                         |
| `cli/debug` (dev), `cli/rollout` (production)                                                                                                                           | 1.35 GB  | model-call trajectory model-io JSONL                                                | model-call trajectories                                                  |
| `cli/agents/sess_*`                                                                                                                                                     | 0.94 GB  | subagent run artifacts                                                              | tool outputs and subagent artifacts                                      |
| `cli/exec`                                                                                                                                                              | 0.65 GB  | persisted Bash tool output (tmpdir convergence spec)                                | command output and temporary cache                                       |
| `cli/plugins/{cache,data,marketplaces}`                                                                                                                                 | 0.62 GB  | plugin cache and data                                                               | agent runtimes and plugins                                               |
| `cli/artifacts`, `cli/image-cache`                                                                                                                                      | 0.64 GB  | tool-result archives, image cache                                                   | tool outputs and subagent artifacts / command output and temporary cache |
| `lite/releases/*`, `bundled-agents/*.tgz`, `agents/{claude-code,opencode,codex,gemini-cli}`, `computer-use/*`                                                           | ~2.2 GB  | CLI runtime releases, bundled external agents, CUA Helper app                       | agent runtimes and plugins                                               |
| `export-log`, `export-log-stage`, `feedback`                                                                                                                            | ~1 GB    | log export results / staging left by failures / feedback bundles                    | exports and feedback bundles                                             |
| `v2/logs`, `cli/log`, `logs`, `agent/logs`, `v2/crash`                                                                                                                  | ~0.15 GB | app logs (14-day rotation), CLI logs (7-day rotation), legacy logs, crash capture   | logs and crash reports                                                   |
| `v2/sessions`, `v2/session-bindings`, `v2/checkpoints`, `agent/sessions` (legacy)                                                                                       | ~0.2 GB  | session snapshots / bindings / checkpoints (`agent/` is legacy residue → other)     | session records and databases                                            |
| `v2/*.sqlite*` (tasks-index, automation, task-index)                                                                                                                    | ~20 MB   | app task index / automation DBs (in use)                                            | session records and databases                                            |
| `v2/*.json`, `cli/config.json`, `security`, `v2/certs`, `v2/provider`, `cli/models`, `cli/memories`, `cli/workflows`, `commands`, `skills`, `agents/*.md`, `workspace/` | small    | config, credentials, memories, default conversation workspace (contains user files) | config, credentials and workspace                                        |

Result: the bulk (> 80%) is "backups", "dev diagnostic captures" and "model-call trajectories", all cleanable.

#### 1.3.1 Verified facts for easily confused directories

| Directory                          | Writer                                                                                | Content                                                                                                                                                                                                             | Read back                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/artifacts/<sess>/`            | `apps/zcode-cli/packages/adapters/src/storage/index.ts` `createNodeToolArtifactStore` | **Not user attachments.** Tool-result archives: oversized Bash output (`.txt`), Edit/Write before/after snapshots and structuredPatch (`.json`), screenshots (`.png`), referenced as `zcode-artifact://<sess>/<id>` | yes: file-change checkpoint summary/rollback (`cold-file-change-summaries.ts`), later turns referencing historical media attachments (`prompt-input.ts`), UI viewing full tool output |
| `cli/agents/<sess>/<agent>/`       | `apps/zcode-cli/packages/core/src/subagent/runner.ts`                                 | subagent run artifacts: `metadata.json`, `output.txt`, `task.output`, `transcript.jsonl` (a single file can reach 64 MB)                                                                                            | only when resuming a running subagent, by `task.outputFile`; not read for finished sessions                                                                                           |
| `cli/sessions/<sess>/workflows/`   | `script-workflow-tool-port.ts`                                                        | workflow scripts generated within the session                                                                                                                                                                       | within the session                                                                                                                                                                    |
| `v2/sessions/<hash>/<taskId>.json` | `packages/services/src/paths.ts` `getLegacyTaskSessionSnapshotPath`                   | legacy task snapshots; **still in use**: `readLegacyTaskSnapshot` falls back to them and Claude native session import (`persistImportedClaudeTask.ts`) still writes here                                            | yes                                                                                                                                                                                   |
| `agent/sessions/`, `agent/logs/`   | no writer in current code (ACP-era residue from 2026-04/05)                           | legacy session JSON/JSONL                                                                                                                                                                                           | no                                                                                                                                                                                    |

## 2. Goals / non-goals

Goals:

- Add a "Storage management" section that asynchronously scans both data roots on open, summarizes
  by disk (volume), splits by category, and shows progress while scanning.
- Each category drills down to details (subdirectory / file, size, owning root).
- Cleanable categories offer a cleanup action with confirmation and result feedback.
- The classification rules are a single source of truth (services-layer catalog) covered by unit tests.

Non-goals:

- Do not change any module's write path and do not fix "CLI does not follow the data storage path" (§8).
- No automatic scheduled cleanup and no quota alerts (can be built on the same catalog later).
- Never clean paths outside `.zcode` (for example `~/.claude`, system TMPDIR).
- Mobile `/remote` and Web do not show this section in the first release (§6.3).

## 3. Classification catalog

The classification is a static table `storageCatalog.ts` in the services layer. Each rule is
`{ categoryId, root?: "home" | "dataBaseDir", pattern (path match relative to the root), cleanable, protect?: [...] }`.
Matching is **longest prefix first**; unmatched entries go to "other".

| id                    | Name                              | Match paths (relative to root)                                                                                                                                                                                                                                                                                                                                                         | Cleanable                                                                        | Cleanup rule                                                                                                                 |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `sessionStore`        | Session records and databases     | `v2/*.sqlite{,-wal,-shm}`, `cli/db/db.sqlite{,-wal,-shm}`, `v2/sessions`, `v2/session-bindings`, `v2/checkpoints` (except pending/tmp)                                                                                                                                                                                                                                                 | no                                                                               | handled by task deletion / auto-archive, not here                                                                            |
| `subagentTranscripts` | Subagent artifacts                | `cli/agents/<sess>/<agent>/transcript.jsonl`                                                                                                                                                                                                                                                                                                                                           | yes                                                                              | only session directories **not updated in the last 24 hours** (protects running subagents); aggregated per session directory |
| `toolOutputs`         | Tool outputs and temporary cache  | `cli/artifacts`, `cli/agents` (except transcript.jsonl), `cli/sessions`, `cli/exec`, `cli/image-cache`, `cli/pdf-cache`, `clipboard`, `git-checkpoint-index`, `editor-icon`, `tmp`, `cache`, `v2/coding-plan-cache.json`, `v2/bots-model-cache*.json`, `v2/checkpoints/**/{pending,tmp}`                                                                                               | no (ruling 2026-09-10: not deletable for now, pending item-by-item confirmation) | n/a                                                                                                                          |
| `modelTrajectory`     | Model-call trajectories           | `cli/debug`, `cli/rollout`                                                                                                                                                                                                                                                                                                                                                             | yes                                                                              | delete all `model-io-*.jsonl`; a file being written that fails to delete counts in `failures` and does not block             |
| `devTraces`           | Dev diagnostic captures           | `v2/dev`, `v2/acp-traffic-proxy`, `v2/acp-stream-diagnostics`                                                                                                                                                                                                                                                                                                                          | yes                                                                              | delete directory contents; keep `v2/dev/zcode-stdio-tap.json` (switch state)                                                 |
| `logs`                | Logs and crash reports            | `v2/logs`, `cli/log`, `logs`, `agent/logs`, `v2/crash`, `v2/perf`, `feedback/logs`, `computer-use/run/*.log`                                                                                                                                                                                                                                                                           | yes                                                                              | delete **non-today** log files; keep `v2/crash/live` and `computer-use/run/.tokens`                                          |
| `backups`             | Backups                           | `backup`, `v2/backup`, `v2/migrations`, `cli/db/backup`, `cli/db/backups`, `cli/db/*.bak*`, `cli/db/*.backup-*`, `v2/*.bak`, `v2/*.backup.json`, `v2/setting.json.corrupt-*`, `v2/config.json.pre-*`, `cli/config.json.bak-*`                                                                                                                                                          | yes (second confirmation)                                                        | delete all                                                                                                                   |
| `exports`             | Exports and feedback bundles      | `export-log`, `export-log-stage`, `feedback`                                                                                                                                                                                                                                                                                                                                           | yes                                                                              | delete all                                                                                                                   |
| `runtimes`            | Agent runtimes and plugins        | `agents/<runtime>/`, `bundled-agents`, `lite`, `computer-use`, `cli/plugins` (including cache; ruling 2026-09-10: not deletable)                                                                                                                                                                                                                                                       | no                                                                               | managed by install / update flows                                                                                            |
| `config`              | Config, credentials and workspace | `v2/*.json`, `v2/agent-config`, `v2/bots-runtime-locks`, `v2/certs`, `v2/acp-auth`, `v2/acp-config`, `v2/provider`, `cli/config.json`, `cli/models`, `cli/memories`, `cli/workflows`, `security`, `commands`, `skills`, `agents/*.md`, `workspace`, `mailbox`, `server`, `controller`, `launcher`, `dev-signing`, `cua-helper-dev-identity`, `perf-task-manifests`, `plugin-workspace` | no                                                                               | n/a                                                                                                                          |
| `other`               | Other                             | unmatched paths; the whole old `~/.zcode/v2` copy once a custom data path is enabled; `agent/` (legacy residue)                                                                                                                                                                                                                                                                        | no                                                                               | drill-down shows concrete paths so rules can be added later                                                                  |

Constraints:

- A `cleanable` rule may delete only **paths the rule itself matched**. Before deleting, re-check
  with `path.relative(root, target)` that the target does not escape the root, and reject symlink targets.
- The protected-file allowlist (`setting.json*`, `credentials.json`, `*.sqlite`, `*.sqlite-wal`,
  `*.sqlite-shm`, `v2/dev/zcode-stdio-tap.json`) is never deleted in any category.
- The catalog matches the existing skip lists in `exportLogs.ts` (`RETIRED_ACP_RUNTIME_ARCHIVE_PATHS`,
  `HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS`, `NON_LOG_STATE_ARCHIVE_PATHS`). exportLogs may reference the
  same catalog later; this phase does not change exportLogs.

## 4. Data model

```ts
// packages/services/src/storage/storage.ts
export type StorageRootId = "home" | "dataBaseDir";
export type StorageCategoryId =
  | "sessionStore"
  | "subagentTranscripts"
  | "toolOutputs"
  | "modelTrajectory"
  | "devTraces"
  | "logs"
  | "backups"
  | "exports"
  | "runtimes"
  | "config"
  | "other";
export type StorageCleanability = "none" | "safe" | "confirm";

export interface StorageVolume {
  /** Stable key of one physical volume: stat().dev; roots with the same dev merge into one disk card */
  deviceId: string;
  /** Mount point found by walking up until dev changes: a path on mac/Linux, a drive letter on Windows */
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageEntryUsage {
  relativePath: string; // relative to the root
  bytes: number;
  fileCount: number;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  cleanability: StorageCleanability;
  entries: StorageEntryUsage[]; // drill-down detail: first-level paths matched by the rule
}

export interface StorageRootUsage {
  id: StorageRootId;
  path: string;
  volume: StorageVolume | null; // null when statfs fails: show usage but not disk capacity
  bytes: number;
  categories: StorageCategoryUsage[];
}

export interface StorageUsageSnapshot {
  jobId: string;
  status: "scanning" | "complete" | "cancelled" | "failed";
  startedAt: number;
  finishedAt?: number;
  roots: StorageRootUsage[];
  errors: Array<{ path: string; code: string }>; // EACCES/ENOENT etc., do not interrupt the scan
}

export interface IStorageService {
  startScan(): Promise<{ jobId: string }>;
  cancelScan(jobId: string): Promise<void>;
  getSnapshot(jobId: string): Promise<StorageUsageSnapshot | null>;
  /** Progress event: throttled to once per >=300ms; payload is the full incremental snapshot */
  onScanProgress(listener: (snapshot: StorageUsageSnapshot) => void): () => void;
  clean(params: { rootId: StorageRootId; categoryId: StorageCategoryId }): Promise<{
    freedBytes: number;
    deletedCount: number;
    failures: Array<{ path: string; code: string }>;
  }>;
}
export const IStorageService = createServiceDescriptor<IStorageService>("storage");
```

Size basis: the sum of `lstat().size`, not following symlinks. Hard links and APFS clones may be
double counted, so the UI labels the value as an estimate.

Reuse: desktop already has a recursive size scanner used only for telemetry
(`packages/desktop/src/main/zcodeDataSizeScanner.ts`, runs in a Worker, does not follow symlinks,
called from `desktopZCodeDataSizeTelemetry.ts`). This feature moves it down to the services layer
and extends it to "accumulate by catalog category + progress callback + cancel"; telemetry calls the
same implementation so there is one directory-walk implementation.

Wiring: the main process owns the single `IStorageService` instance
(`packages/desktop/src/main/resourceManagerStorage.ts`) and exposes commands as IPC invokes
`PlatformChannels.StorageStartScan` / `StorageCancelScan` / `StorageGetSnapshot` / `StorageClean` /
`StorageRevealPath`, and pushes progress snapshots on `StorageScanProgress`. The Resource Manager
window calls through `packages/desktop/src/preload/resourceManager.ts`, not through host RPC registration.

## 5. Sequence and state

```text
Renderer <StorageSection>                 Host StorageService                       FS
  | enter tab                                     |                                      |
  |- startScan() -------------------------------->| new job(jobId, AbortController)       |
  |                                               | resolve roots: R1=~/.zcode            |
  |                                               |                R2={dataBaseDir}/.zcode (optional) |
  |                                               | per root: stat dev -> find mount -> statfs ->|
  |                                               | readdir(withFileTypes) bounded concurrency(8) ->|
  |<- onScanProgress(snapshot, throttled 300ms) --| per entry lstat -> catalog.classify -> accumulate |
  |   UI: "Calculating..." + running totals update|                                      |
  |<- onScanProgress(status=complete) ------------|                                      |
  | leave tab - cancelScan(jobId) --------------->| abort -> status=cancelled             |
  |                                               |                                      |
  | click "Clean" -> confirm dialog (confirm class) - clean() ->| resolve targets by catalog -> escape/protection check -> rm |
  |<- {freedBytes, failures} ---------------------|                                      |
  | toast result -> startScan() again             |                                      |
```

State constraints:

- At most one running job at a time; another `startScan` first cancels the old job (user clicks
  "Recalculate" or re-enters the tab).
- Scanning and cleanup run in the host process, all async `fs/promises`; `readdirSync`/`statSync` are forbidden.
- Progress events use the existing service event channel (the same subscription style as
  `IUsageStatsService`). The UI only consumes the snapshot and never accumulates itself.
- The feature touches only the local disk. It does not enter the task realtime path and does not
  affect `desktop-continuous` / `web-remote-replayable` semantics.

Performance constraints (ruling Q7: real-time refresh, performance first):

- Lifecycle is bound to the tab: `startScan` only on entering "Storage"; `cancelScan` immediately on
  switching tabs, closing the window, or window blur longer than 60 s; restart on return. No
  resident background scan.
- The walk runs in a Worker thread (reusing the Worker form of `zcodeDataSizeScanner.ts`); the host
  main event loop receives only throttled progress. Inside the Worker everything is `fs/promises`,
  `readdir({ withFileTypes: true })` reduces stat calls, directory-level bounded concurrency
  (default 4, configurable), and `setImmediate` yields once every N entries.
- Cancellation uses `AbortSignal`, checked on entering each directory. After cancel the Worker stops
  immediately instead of finishing and discarding.
- On entering the tab, if memory holds a previous `complete` snapshot, show the old values first and
  rescan in the background (stale-while-revalidate), so numbers do not restart from 0 every time.
- Progress events fire at most every 300 ms and only when numbers change. Snapshot size is bounded:
  `entries` aggregate only to the first-level path matched by a rule, with no per-file list.
- Cleanup is also async with bounded-concurrency deletion; the UI rescans after it returns and
  disables other cleanup buttons while cleaning.

## 6. UI

### 6.1 Layout

```text
+- Storage management ------------------------------------------------------+
| Total 25.0 GB . last computed 12:03  [Recalculate]                         |
| +- Disk Macintosh HD ----------+  +- Categories (selected disk) ---------+ |
| | ################....         |  | Backups              12.9 GB [Clean] > | |
| | ZCode 25.0 GB / free 6.9 GB  |  | Dev diagnostic caps   3.2 GB [Clean] > | |
| | * Backups          12.9 GB   |  | Model trajectories    1.4 GB [Clean] > | |
| | * Dev captures      3.2 GB   |  | Agent runtimes/plugins 2.2 GB        > | |
| | * Trajectories      1.4 GB   |  | Sessions and tasks    1.8 GB         > | |
| | * ...                        |  | Logs and crash        0.15 GB [Clean] > | |
| | Root: ~/.zcode (25.0 GB)     |  | Databases             0.8 GB         > | |
| +------------------------------+  | Other                 ...            > | |
| +- Disk /Volumes/Data --------+   +----------------------------------------+ |
| | ... (only when R2 is on another disk) |                                  |
| +------------------------------+                                            |
+----------------------------------------------------------------------------+
```

- Left column: one card per volume (`bg-card border-card-border rounded-xl`). The bar is colored by
  category and the legend is sorted by size descending. The card bottom lists the roots on that volume
  with usage. With several cards, clicking selects which category list shows on the right; with one
  card there is no selected state.
- Right column category row: icon + name + size + (when cleanable) a "Clean" button + `>`. Clicking
  opens the detail view (second-level page within the tab, breadcrumb back, same navigation as the
  plugin detail): lists `entries`, each with size, owning root and "Show in file manager".
- While scanning, the total and row numbers update with progress events and a `Loader2` spins at the
  top right. When `errors` is non-empty, a bottom caption says "some directories could not be read".
- Cleanup confirmation: `safe` categories run directly + toast; `confirm` categories open a Dialog
  whose body explains the consequence (see §3) with a red destructive primary button.
- Narrow screens (< 900px) stack the columns. All text uses `text-ui-*`; light/dark themes and zh/en
  copy are complete (i18n key prefix `settings.storage.*`).
- Section registration: `settingsPageConfig.ts` adds `{ id: "storage", icon: HardDrive, titleId: "settings.storage.title" }`
  to the `dataAndStats` group, and `settingsNavigation.ts` gets the id.

### 6.2 Category icons

Session records and databases `Database`, tool outputs `FileOutput`, trajectories `Route`, captures
`Activity`, logs `FileText`, backups `Archive`, exports `PackageOpen`, cache `Layers`, runtimes
`Blocks`, config `KeyRound`, other `Folder` (lucide).

### 6.3 Platforms

- Desktop: full feature; the service is registered in the local host's service collection.
- Web / mobile `/remote`: **not shown** (ruling Q5), hidden through `createSettingsPageConfig({ isDesktop })`, the same gating as Computer Use.

## 7. Tests

Unit tests (`packages/services/src/storage/*.test.ts`):

- catalog: a fixture tree classifies every path correctly; longest prefix wins; unknown path → `other`; protected files never become cleanable targets.
- scanner: temp-directory fixture → exact bytes/fileCount per category; symlinks not followed; EACCES goes to `errors` without interrupting; no progress after `cancelScan`; two roots with the same dev merge into one volume and different devs give two volumes (mock `stat`).
- cleaner: deletes only matched paths; rejects escaping paths; `logs` keeps today's files; an unconfirmed `confirm` category does not run (the service has no confirmation concept; this is tested in the UI); failures go to `failures`.

E2E (`packages/desktop/test/e2e/settings/settings-storage-management.test.ts`, fixtures seeded in an isolated HOME):

| Case                     | Setup                                                                                                                                  | Action                                        | Assertion                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| SM-01 scan               | wait for startup migration, clear the isolated HOME's `backup/`, then seed 4 KiB `cli/debug`, 6 KiB `backup/` and yesterday/today logs | open Resource Manager › Storage               | after the scan, trajectories show 4.0 KB and backups 6.0 KB; the total includes normal app runtime data         |
| SM-02 drill-down         | same                                                                                                                                   | click "Model-call trajectories"               | detail lists 2 files and the root `~/.zcode`; breadcrumb returns                                                |
| SM-03 clean safe         | same                                                                                                                                   | click "Clean" on the trajectories row         | no confirm dialog; toast shows freed size; files deleted; row size becomes 0                                    |
| SM-04 clean confirm      | same                                                                                                                                   | click "Clean" on "Backups" → cancel / confirm | cancel deletes nothing; confirm deletes                                                                         |
| SM-08 stop on leave      | seed many small files                                                                                                                  | switch to another tab and back during a scan  | after leaving, host receives cancel (no progress events); on return it restarts and first shows the last result |
| SM-09 tool outputs guard | seed one `cli/artifacts/sess_*` with mtime 1 hour ago and one 3 days ago                                                               | clean "Tool outputs and subagent artifacts"   | only the 3-day-old directory is deleted                                                                         |
| SM-05 logs keep today    | same                                                                                                                                   | clean logs                                    | yesterday's file deleted, today's kept                                                                          |
| SM-06 two roots          | `setting.json.dataBaseDir` points to another directory and `v2` is seeded                                                              | open the tab                                  | the disk card lists both roots with their usage; still one card when on the same disk                           |
| SM-07 i18n/theme         | n/a                                                                                                                                    | switch to en + light                          | copy and colors correct (representative sample)                                                                 |

## 8. Rulings (2026-09-10)

| #   | Question                                                  | Ruling                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Category granularity                                      | "Databases" and the old "Session and task data" merge into **Session records and databases** (not cleanable); `cli/artifacts`, `cli/agents`, `cli/sessions` become **Tool outputs and subagent artifacts** (cleanable with confirmation, 24h protection). Verified facts in §1.3.1: artifacts are tool-result archives, not user attachments     |
| 2   | Is command output and temporary cache cleanable           | Cleanable, `confirm` with consequence text                                                                                                                                                                                                                                                                                                       |
| 3   | Backups and migration residue                             | Cleanable (`confirm`); category renamed **Backups**                                                                                                                                                                                                                                                                                              |
| 4   | Old `~/.zcode/v2` copy after enabling a custom path       | Goes to **Other**, no cleanup                                                                                                                                                                                                                                                                                                                    |
| 5   | Platform scope                                            | Desktop only                                                                                                                                                                                                                                                                                                                                     |
| 6   | Root cause of the CLI not following the data storage path | Not fixed now, only managed (a fix would still leave residue problems)                                                                                                                                                                                                                                                                           |
| 7   | Progress                                                  | Real-time refresh; stop when leaving, recompute on entering; async IO, performance first (§5 performance constraints)                                                                                                                                                                                                                            |
| 8   | Can tool outputs / cache be deleted (added 2026-09-10)    | Split into two: **Subagent artifacts** = `cli/agents/**/transcript.jsonl`, directly cleanable (keep sessions active within 24h); **Tool outputs and temporary cache** = the rest of the former "Tool outputs and subagent artifacts" + the former "Command output and temporary cache", not deletable for now, pending item-by-item confirmation |

## 9. Implementation split (after the rulings)

1. MR-1 `feat(storage): catalog + scanner + cleaner + IStorageService` (services layer + unit tests)
2. MR-2 `feat(settings): storage management section` (host registration, UI scan and display, i18n, E2E SM-01/02/06/07)
3. MR-3 `feat(settings): storage cleanup actions` (confirm dialog, toast, E2E SM-03/04/05)

Each MR first runs `pnpm architecture:check --changed`, `pnpm typecheck`, `pnpm lint`.

## 10. Code architecture (per the `architecture-governance` skill)

Based on `.agents/skills/architecture-governance/SKILL.md` and `references/ai-guidance.md`: decision
record first, then the managed module's layers and contract, then the wiring points. Before
implementing run `pnpm architecture:context storage`; after implementing run
`pnpm architecture:check --changed`; commit only with zero new violations.

### 10.1 Decision record

```text
owner:              the single StorageService instance in the new managed module packages/services/src/storage,
                    which alone holds "current scan job, latest completed snapshot, cleanup-in-progress flag".
                    The Renderer keeps only a projection (current snapshot + selected disk/category); it does not
                    accumulate or cache a second truth.
command path:       UI <StorageSection> → useStorageUsage() → IStorageService (RPC ProxyChannel)
                    → StorageService.startScan/cancelScan/clean → ScanRunnerPort (Worker) → fs
derived views:      snapshot.roots[].categories[].entries are folded by pure domain functions from the
                    (relativePath, bytes, mtimeMs) reported by the Worker; volume grouping is folded from deviceId;
                    the UI legend / bar / detail are all projections of the snapshot.
ordering/idempotency: jobId increases monotonically; startScan aborts the old job before creating a new one; progress
                    events carry jobId and the UI drops events whose jobId is not current; cancelScan(jobId) on a
                    non-current job is a no-op; clean() first cancels the current job if scanning, and the UI
                    restarts startScan after deletion completes.
delivery:           desktop-continuous only (local disk, not in task realtime; Web/mobile do not register it).
contracts/spec/tests: this document §3/§4/§5; storage/contract.ts + contract.test.ts;
                    packages/services/src/storage/**/*.test.ts; E2E SM-01..09.
```

Rejected shapes (anti-patterns from ai-guidance):

- Renderer scanning the disk with `fs` directly or building its own queue: only `IStorageService`.
- A second directory walker: the walk logic of desktop main's `zcodeDataSizeScanner.ts` moves into this module's adapters and the telemetry Worker imports the same implementation.
- `fs` / `path.resolve(homedir)` / timers in domain: classification, folding and cleanup planning are pure functions.
- Deep imports `@zcode/services/src/storage/app/...`: only `contract.ts` is allowed.

### 10.2 Module layout and layers

`architecture-policy.yaml` adds a managed module (layerOrder semantics: earlier layers cannot import later layers):

```yaml
- id: storage
  roots: [packages/services/src/storage]
  managed: true
  requires: [shared, rpc] # if the checker reports a deep-import for ../descriptors.js, add services to requires and create the descriptor in contract.ts; the first architecture:check result decides
  publicEntrypoints: [packages/services/src/storage/contract.ts]
  layers: { domain: domain, app: app, adapters: adapters }
  layerOrder: [domain, app, adapters]
  owner: desktop-settings
```

```text
packages/services/src/storage/
├─ module.ts                 { id:"storage", requires:["shared","rpc"], provides:["storage-service"], publicEntrypoints:["contract.ts"] }
├─ contract.ts               IStorageService + all public types (§4) + createServiceDescriptor (<=300 lines, <=12 methods)
├─ contract.example.ts       demonstrates "enter tab → subscribe progress → cancel → clean" with a fake port
├─ contract.test.ts          contract behavior assertions (events carry jobId, cancel is idempotent, clean return shape)
├─ CONTRACT.md               invariants types and tests cannot express (see 10.3)
├─ domain/                   pure functions, no IO
│  ├─ storageCatalog.ts      rule table + classify(relativePath) → {categoryId, cleanability, protected}
│  ├─ usageAggregate.ts      fold(entries) → StorageRootUsage; entries aggregate to the first-level path matched by a rule
│  ├─ volumeGrouping.ts      merges roots into a volume view by deviceId
│  └─ cleanPlan.ts           planClean(listing, categoryId, now) → paths to delete; includes 24h protection, protected-file allowlist, escape rejection
├─ app/                      use-case orchestration, depends only on domain and ports
│  ├─ ports.ts               ScanRunnerPort / VolumeProbePort / FsCleanerPort / RootsResolverPort
│  ├─ scanJob.ts             single job lifecycle: jobId, AbortController, 300ms throttle, state machine
│  └─ storageService.ts      createStorageService(deps: ports) → IStorageService; Emitter<snapshot>
└─ adapters/                 IO implementations
   ├─ fsWalker.ts            opendir/lstat walk (moved from desktop main zcodeDataSizeScanner), bounded concurrency, AbortSignal, setImmediate yield, emits (relativePath, bytes, mtimeMs)
   ├─ volumeProbe.ts         stat().dev + walk up to the mount point + statfs → StorageVolume
   ├─ fsCleaner.ts           async bounded-concurrency rm per cleanPlan result, collects failures
   └─ scanWorkerProtocol.ts  Worker message types and the isSnapshot guard (the Worker entry itself lives in the desktop package)
```

Worker boundary (keeps the host event loop idle):

```text
desktop/src/host/storageScanWorker.ts   (new tsup entry "host/storageScanWorker")
   └─ import { walk } from services/storage/adapters/fsWalker
      import { classify, fold } from services/storage/domain/*     ← pure functions can run inside the Worker
      every 300ms postMessage(partial snapshot); stops on an abort message
desktop/src/host/storageScanWorkerClient.ts  implements ScanRunnerPort: new Worker(new URL(...)) + terminate on abort
desktop/src/main/zcodeDataSizeWorker.ts      imports services' fsWalker (removes the duplicate walk implementation in main)
```

Rationale: classification and folding finish inside the Worker, so the main thread receives only
aggregated snapshots and no per-file cross-thread messages. In-process tests use
`createInProcessScanRunner()` to call the same walker + domain, so the Worker and test paths are the same.

### 10.3 Invariants for CONTRACT.md

- At most one running job at a time; `startScan` implicitly cancels the old job.
- Progress snapshots are monotonic: within a job `bytes` only grows; `status` only goes scanning → complete | cancelled | failed.
- `clean` deletes only paths the catalog explicitly matched and `cleanPlan` validated; the protected allowlist is never deleted in any category; the returned `failures` are per path and the call does not throw as a whole.
- `entries` contains no per-file list, only first-level paths matched by a rule; snapshot size is independent of file count.
- Roots come from the injected `RootsResolverPort` (desktop passes `homedir()` and `getDataBaseDir()`); the module reads no environment variables.

### 10.4 Wiring points (change list)

| Location                                                                                          | Change                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture-policy.yaml`                                                                        | new `storage` managed module (10.2)                                                                                                                                                             |
| `packages/shared/src/channels.ts`                                                                 | `ServiceChannels.Storage = "storage"`                                                                                                                                                           |
| `packages/shared/src/test-ids.ts`                                                                 | `TID_SETTINGS_STORAGE_*`                                                                                                                                                                        |
| `packages/services/src/storage/**`                                                                | new module (10.2)                                                                                                                                                                               |
| `packages/services/src/accessor.ts`                                                               | `IServiceAccessor.storageService`                                                                                                                                                               |
| `packages/services/src/node.ts`                                                                   | export `createStorageService` and the adapter factories                                                                                                                                         |
| `packages/client/src/remoteServiceAccess.ts`                                                      | `ProxyChannel.toService<IStorageService>`                                                                                                                                                       |
| `packages/desktop/src/host/index.ts`                                                              | assemble near `createSettingService()`: roots resolver, Worker scan runner, fs cleaner, volume probe                                                                                            |
| `packages/desktop/src/main/resourceManagerStorage.ts`                                             | Main-owned `IStorageService` instance exposed over IPC to the Resource Manager window (no host RPC registration)                                                                                |
| `packages/desktop/src/host/storageScanWorker.ts` + `storageScanWorkerClient.ts`                   | Worker entry and ScanRunnerPort implementation                                                                                                                                                  |
| `packages/desktop/tsup.config.ts`                                                                 | add the `"host/storageScanWorker"` entry to host                                                                                                                                                |
| `packages/desktop/src/main/zcodeDataSizeWorker.ts` / `zcodeDataSizeScanner.ts`                    | walk implementation moves to services; main keeps only the Worker entry                                                                                                                         |
| `packages/ui/src/hooks/useStorageUsage.ts`                                                        | subscribe `onScanProgress`, `startScan` on mount, `cancelScan` on unmount / 60 s blur, filter by jobId                                                                                          |
| `packages/ui/src/settings/storage/`                                                               | `StorageSection.tsx`, `StorageDiskCard.tsx`, `StorageCategoryList.tsx`, `StorageCategoryDetail.tsx`, `StorageCleanConfirmDialog.tsx`, `storageCategoryPresentation.ts` (icon / copy id / color) |
| `packages/ui/src/settings/settingsPageConfig.ts`, `lib/settingsNavigation.ts`, `SettingsPage.tsx` | register the `storage` section (`isDesktop` gate)                                                                                                                                               |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`                                                   | `settings.storage.*`                                                                                                                                                                            |
| `packages/desktop/test/e2e/settings/settings-storage-management.test.ts`                          | §7 E2E                                                                                                                                                                                          |

### 10.5 Where events and types live

- Progress events follow the RPC `onXxx: Event<T>` convention (`packages/rpc/src/proxy-channel.ts` recognizes `on`-prefixed properties as events and buffers them). The contract declares `onScanProgress: Event<StorageUsageSnapshot>`; no new broadcast channel.
- `IStorageService` public methods: `startScan`, `cancelScan`, `getSnapshot`, `onScanProgress`, `clean` (5 in total). "Show in file manager" reuses the platform's `openInFileManager`; the UI calls it with `root.path + relativePath` and does not go through the storage service.
- Byte formatting reuses the UI's existing size formatter (grep `formatBytes`/`formatFileSize` first; do not write a second one).

## 11. Implementation locations (2026-09-10, z-code-2 staging)

> Differences after moving into the Resource Manager (2026-09-10): the service instance is owned by
> **desktop main** (no longer a host RPC service, no ServiceDescriptor / channel); the renderer calls
> through the preload `window.resourceManager.storage` (`StorageManagementBridge`); data types live in
> `packages/shared/src/storage.ts`; UI is in `packages/ui/src/resource-manager/storage/`; "Show in file
> manager" goes through `StorageRevealPath`, where main checks the path is inside the data roots and
> then calls `shell.showItemInFolder`. The table below shows the post-move locations.

| Layer             | Files                                                                                                                                                                                             | Notes                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| policy            | `architecture-policy.yaml`                                                                                                                                                                        | `storage` managed module: `requires: [shared, rpc, services]`, layerOrder `domain → app → adapters`                                                                                                                   |
| shared            | `packages/shared/src/storage.ts`, `channels.ts`, `test-ids.ts`                                                                                                                                    | data types and `StorageManagementBridge`; `PlatformChannels.Storage*`; `TID_RESOURCE_MANAGER_STORAGE_*`, `TID_RESOURCE_MANAGER_TAB`                                                                                   |
| services/domain   | `storage/domain/{storageCatalog,usageAggregate,cleanPlan}.ts`                                                                                                                                     | classification rules, bounded aggregation (at most 100 entries per category, the rest folded into `…`), cleanup plan; volume grouping `groupStorageRootsByVolume` is in shared                                        |
| services/app      | `storage/app/{ports,scanJob,storageService}.ts`                                                                                                                                                   | ports, single-job throttle and terminal states, single-owner `IStorageService`                                                                                                                                        |
| services/adapters | `storage/adapters/{fsWalker,volumeProbe,fsCleaner,inProcessScanRunner,rootsResolver}.ts`                                                                                                          | bounded-concurrency cancellable walk, statfs volume probe, bounded-concurrency delete + empty-directory reclaim, `runStorageScan` (the only scan path shared by the Worker entry and unit tests), two-root resolution |
| desktop main      | `main/resourceManagerStorage.ts`, `main/storageScanWorker.ts`, `storageScanWorkerClient.ts`, `storageScanWorkerProtocol.ts`, `tsup.config.ts`                                                     | IPC surface + the single StorageService instance; Worker entry (entry `main/storageScanWorker`) and ScanRunnerPort implementation; forced terminate after a 500 ms abort grace; closing the window cancels the scan   |
| desktop preload   | `preload/resourceManager.ts`                                                                                                                                                                      | `window.resourceManager.storage` bridge                                                                                                                                                                               |
| ui                | `resource-manager/ResourceManagerApp.tsx` (tab), `resource-manager/storage/*` (incl. `useStorageUsage`), i18n `resourceManager.storage.*`                                                         | storage tab, disk cards, category list, detail, confirm dialog                                                                                                                                                        |
| tests             | `packages/services/test/storage*.test.ts`, `storage/contract.test.ts`, `packages/ui/test/resourceManagerStorage{Presentation,Usage}.test.ts`, `desktop/test/e2e/resource-manager-storage.test.ts` | unit tests + E2E SM-01~05                                                                                                                                                                                             |

Differences from §4/§10:

- The service no longer goes through RPC: `IStorageService` is only the interface of the instance main owns (`StorageManagementApi` + `onScanProgress` + `dispose`) with no descriptor / channel; `useStorageUsage` takes the preload bridge as input, not `useServices()`.
- "Show in file manager" goes through `StorageRevealPath`; main validates with `isPathInsideStorageRoots` before calling `shell.showItemInFolder`.
- Contract types and `groupStorageRootsByVolume` live in `packages/shared/src/storage.ts` (shared by the renderer bridge, main and services, and avoiding a contract ↔ domain cycle).
- SM-08 (stop on leave) and SM-09 (24h protection) are covered by unit tests (`useStorageUsage.test.ts`, `storageCleanPlan.test.ts`); E2E does not repeat them.
- The desktop main telemetry scanner `zcodeDataSizeScanner.ts` is not yet switched to the services `walkStorageRoot`. This is left for a follow-up small MR (behavior-equivalent replacement that must keep the file/time limit partial semantics).
