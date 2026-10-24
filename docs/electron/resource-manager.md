# Resource Manager

> Replaces the old "Process Monitor". The old process-tree view and `GetProcessMetrics` channel are removed.

## Overview

Two entry points open the same standalone singleton window: the Help menu in the native macOS menu bar, and the question-mark help menu at the top right on all desktop platforms (`WorkspaceHelpMenuButton`; Windows/Linux have no native menu bar). The Web app does not render this menu item (`isDesktop` is injected at the mount point; see `docs/windows-caption-help-menu.md`). The window has four tabs: **CPU**, **Memory**, **Storage**, **Network**. All storage management lives here, not in Settings.

- **CPU / Memory tabs**: ZCode CPU or memory usage in real time. Same layout; the metric cards and list columns follow the selected tab. 1-second polling stops when switching to **Storage** or **Network**.
- **Storage tab**: disk usage of the local `.zcode` data directory, by volume and category, with drill-down and cleanup. Product and implementation details are in `docs/settings-storage-management.md`; the data flow below covers only this window's wiring.
- **Network tab**: observes HTTP(S) requests and WebSocket connections of local Main, Host, App Renderer and CLI only while the window is open; no bodies are collected. Closing the window cancels listeners and releases records. See [Network Request Observability](resource-manager-network.md).

The CPU / Memory tabs contain:

- Two metric cards on the left: **CPU** and **Memory**. Each has a dual-layer progress bar: **gray** = total machine usage, **color (brand)** = ZCode usage; values show ZCode and total machine usage.
- Processes on the right in three groups. Each group shows a subtotal and expands to per-process name, PID, CPU and memory:
  - **Core services**: Electron main, GPU, all renderers (including DevTools / WebContentsView), window-scoped Host (utility), non-Agent child processes spawned by Host (such as terminal shells), Agent CLI processes and their non-plugin child processes, and other Electron utilities (such as network service).
  - **Built-in plugins**: MCP child-process trees for plugins from the official marketplace (`zcode-plugins-official`), currently `browser-use` (`node_repl` + plugin host) and `computer-use`.
  - **Community plugins**: all other MCP child-process trees (third-party marketplace plugins and user-defined MCP, `custom`).

## Storage Tab Data Flow

This window does not connect through RPC / MessagePort (see `preload/resourceManager.ts`), so storage does not go through Window Host. The **main process owns the sole `StorageService` instance** (the storage module in `@zcode/services`), and scanning runs in `worker_threads` (entry `main/storageScanWorker`) without blocking the main event loop. This does not conflict with "main must not launch external processes for sampling"; disk scanning is only filesystem traversal.

```
Resource Manager Renderer            preload (window.resourceManager.storage)        Main
  │ Switch to Storage tab → startScan() ─► ipc invoke StorageStartScan ──────────────► resourceManagerStorage.ts
  │                                                                                   │ Lazily create StorageService (Worker runner)
  │◄─ subscribeScanProgress ◄──────── ipc on StorageScanProgress ◄────────────────── │ onScanProgress → webContents.send
  │ Switch away / close window → cancelScan(jobId) ─► ipc invoke StorageCancelScan ─► │ Closing window also cancels the latest job
  │ clean({rootId,categoryId}) ─────► ipc invoke StorageClean ─────────────────────► │
  │ revealPath(abs) ────────────────► ipc invoke StorageRevealPath ────────────────► │ Validate path is inside data root → shell.showItemInFolder
```

- Channels: `PlatformChannels.StorageStartScan / StorageCancelScan / StorageGetSnapshot / StorageClean / StorageRevealPath` (invoke), `StorageScanProgress` (main → renderer push).
- Types: `packages/shared/src/storage.ts` (`StorageUsageSnapshot`, `StorageManagementBridge`, etc.), shared by services / main / UI.
- UI: `packages/ui/src/resource-manager/storage/*`, `useStorageUsage({ bridge, enabled: tab === "storage" })`.

## Measurement Definitions

- **CPU is a machine-normalized percentage everywhere**: `100%` = all logical cores fully occupied. The gray bar is busy/total between two `os.cpus()` samples; ZCode usage is the sum of CPU across all process rows; each process row uses the same basis, so group subtotals and totals add directly. (The old Process Monitor used the macOS Activity Monitor convention, one core = 100%; this window does not.)
  - Electron processes use `app.getAppMetrics().cpu.percentCPUUsage`: darwin / win32 already report machine-wide percentages; on linux Chromium returns a per-core percentage, so divide by the logical core count (`normalizeElectronCpuToMachinePercent`).
  - External processes (Agent / MCP / terminal) are computed by the Host sampler as `Δcputime / Δwall / logical core count`. The first sample has no baseline, so CPU is 0.
- **Memory**: Electron processes use `workingSetSize`; external processes use RSS (macOS/Linux) or WorkingSet (Windows). Total machine memory is `os.totalmem()`; used is `total - os.freemem()` (same basis as PhysMem used in macOS `top`, including file cache).
- Shared memory between Chromium processes is counted repeatedly, matching Task Manager / Activity Monitor; it is not deduplicated.
- Agents for remote workspaces (SSH/WSL/Docker/Server) run remotely, outside local observability scope, and are not shown.

## Architecture

```
Resource Manager Renderer         Main (Electron)                 Window Host (utility)                 Agent CLI
   │ 1s polling                       │                                 │                                    │
   │─ invoke GetResourceUsageSnapshot ►│                                 │                                    │
   │                                  │─ ResourceUsageSnapshotRequest ─►│  (fan-out to each live Host,        │
   │                                  │   {requestId}                   │   900ms timeout; use previous result)│
   │                                  │                                 │─ Async ps / /proc / CIM ────┐        │
   │                                  │                                 │◄───────────────────────────┘        │
   │                                  │                                 │─ request process/childProcesses ───►│
   │                                  │                                 │◄─ {processes:[{pid,serverName,     │
   │                                  │                                 │     mcpSource,pluginName?}]}        │
   │                                  │                                 │  Attribute Host subtree: agent / mcp root │
   │                                  │◄─ ResourceUsageSnapshotResult ──│                                    │
   │                                  │   {requestId, processes[]}      │                                    │
   │                                  │ + app.getAppMetrics()           │                                    │
   │                                  │ + os CPU/memory totals          │                                    │
   │                                  │ + Agent registry fallback (unsampled=0)        │
   │◄──────── ResourceUsageSnapshot ──│                                 │                                    │
```

### Read-Only Sampling Lifecycle and Regression Constraints

- The Main Resource Manager window is the sole owner of sampling start/stop: enable after the CPU/Memory page mounts; disable when switching to Storage, when the window closes, or when the renderer exits. Send nothing to Host when sampling is disabled or the query did not come from this window.
- Each Host has at most one sample in flight. Main's 900ms display-wait timeout returns the cache only and does not queue another sample; the next sample starts only after the current one completes. On disable, in-flight requests are cancelled by requestId; late results must not update the cache or projection. Host keeps no sampling queue.
- `process/childProcesses` is an observation request: query only existing runtimes whose storage is ready; do not wait for migration or start a process. Failure, timeout and cancellation affect only that query; they do not publish a runtime failure, reclaim a process, or refresh the business idle timer. The regular business RPC watchdog keeps its existing semantics.
- Host propagates cancellation to process-table reads and CLI queries; cancellation terminates only helper commands created for this sample, never the Agent/MCP being observed. Late results after Linux file reads complete are discarded.
- Sampling covers local processes only, creates no remote connections, and does not change business-message recovery boundaries for Desktop continuous / mobile replayable.

```text
CPU/Memory page → Main enables → One Host sampling round → OS process table + CLI observation
Switch tab/close window → Main disables → cancel(requestId) → Cancel I/O/query and discard late results
CLI observation timeout → No mapping for this round; Agent lifecycle and business idle timer remain unchanged
```

Acceptance: no queries when unopened; slow sampling does not build a backlog; switching tabs/closing the window cancels in-flight work and prevents further queries; reopening does not accept old results; business requests remain executable after an observation timeout; successful or pending observation does not extend the idle lifetime of mcp-status.

### Why the Layers Are Structured This Way

- **Main must not launch external processes for sampling** (synchronous `ps` / PowerShell blocked the whole app; the CreateProcess stage of asynchronous `execFile` also blocks main). External-process CPU/memory is sampled asynchronously inside **Window Host (utility process)**, only when the Resource Manager window requests it; Host has no periodic overhead after the window closes.
- **Only the CLI knows plugin ownership**: MCP child processes are started by the Agent CLI, and `ZCODE_PLUGIN_ID` / server name / `source.kind` are in CLI memory; the existing `process/mcpTelemetry` channel deliberately omits pid for telemetry redaction. A pure-memory, no-I/O protocol request `process/childProcesses` lets Host map pids to plugins.
- **Host attributes process trees**: Host is the Agent's parent process. One `ps -axo pid=,ppid=,rss=,cputime=,comm=` (darwin) / scan of `/proc/*/stat` + `/proc/<pid>/status` (linux) / `Get-CimInstance Win32_Process` (win32) covers all Host descendants. Each descendant is attributed to its nearest known ancestor: MCP root pid → corresponding plugin; Agent pid → core-service `cli`; no owner → core-service `host` child process.
- **Main only merges**: `app.getAppMetrics()` (Electron processes) + system totals + Host reports. Agents known to the Agent registry but not yet reported by Host still appear in the list (`sampled=false`, metrics 0), keeping the topology visible; E2E depends on this.

### Data Types (`packages/shared/src/protocol.ts`)

```ts
type ResourceUsageCategory = "base" | "builtin-plugin" | "community-plugin";

interface ResourceUsageProcess {
  pid: number;
  name: string; // zcode-main / zcode-renderer-main / zcode-agent-<provider>-<ws> / MCP server name / command name
  category: ResourceUsageCategory;
  groupKey: string; // base: main|gpu|renderer|host|cli|utility; plugin: plugin name or MCP server name
  groupLabel: string; // Group display name (plugin name / server name)
  cpuPercent: number; // Machine-normalized
  memoryBytes: number;
  sampled: boolean; // false = topology is known, but metrics have not been sampled yet
}

interface ResourceUsageSnapshot {
  sampledAt: number;
  logicalCpuCount: number;
  system: { cpuPercent: number; memoryTotalBytes: number; memoryUsedBytes: number };
  app: { cpuPercent: number; memoryBytes: number }; // = sum of processes
  processes: ResourceUsageProcess[];
}
```

### Protocol Addition (`packages/shared/src/zcode-protocol/index.ts`)

- `zcodeProtocolMethods.processChildProcesses = "process/childProcesses"`, params `{}`.
- Result `zcodeProcessChildProcessesResultSchema`: `{ processes: Array<{ pid, serverName, mcpSource: "builtin"|"plugin"|"custom", pluginName?: string }> }`.
- CLI implementation: `McpTelemetryTracker.listProcesses()` reads `process.pid`, `serverName` and `mcpSource` from registered connections; `pluginName` is resolved from the `plugin:<name>:<key>` namespace or official-plugin `hostMcpServerNames` (`node_repl` → `browser-use`). No I/O.

### Main ↔ Host Messages

- main → host `HostMessageTypes.ResourceUsageSnapshotRequest { requestId }`.
- host → main `HostResponseTypes.ResourceUsageSnapshotResult { requestId, sampledAt, processes: HostResourceUsageProcess[] }`, where `HostResourceUsageProcess = { pid, name, category, groupKey, groupLabel, cpuPercent, memoryBytes }`.
- Validation: `hostIncomingMessageSchema` / `hostResponseMessageSchema` in `packages/shared/src/validation.ts`.

### Host-Side Sampling (`packages/services/src/process/processResourceSampler.ts`)

- `readProcessResourceTable()`: asynchronously reads the machine-wide process table `{ pid, ppid, rssKb, cpuTimeMs, command }` per platform, 3s timeout (5s on win32); returns `undefined` on failure (skip the round without throwing).
- `createProcessResourceSampler()`: stores each pid's `cpuTimeMs` and timestamp from the previous round and outputs machine-normalized `cpuPercent`; drops the baseline when a pid disappears.
- `attributeHostProcessTree()` (pure): takes the process table, Host pid, Agent list (pid/workspacePath/provider) and each Agent's MCP child-process mappings, and outputs `HostResourceUsageProcess[]`.

The Host entry point `packages/desktop/src/host/hostResourceUsage.ts` connects these with `IZCodeAgentService.collectLocalRuntimeChildProcesses()` and replies when requested.

## Architecture Governance Decision Record

```text
owner:            main-process resourceManagerWindow (Host / Agent pid registry + snapshot merge);
                  transient external-process metrics are owned by the Window Host sampler (cputime delta baseline);
                  MCP child-process ↔ plugin mapping is owned only by CLI McpTelemetryTracker
command path:     renderer invoke GetResourceUsageSnapshot → main buildResourceUsageSnapshot
                  → HostMessageTypes.ResourceUsageSnapshotRequest → host createHostResourceUsageResponder
                  → CLI process/childProcesses (in memory only)
derived views:    ResourceUsageSnapshot (main merges Electron metrics + system totals + Host reports);
                  UI groupResourceUsage only groups/sorts/formats and owns no metric state;
                  main lastHostResults is a timeout fallback cache, not a second source of truth
ordering:         At most one sample in flight per Host; on timeout Main returns the cache using the original requestId, and Host does not queue;
                  late replies from active requests may update the cache; replies after cancellation are discarded; pid reuse rebuilds the baseline when command changes / cputime goes backward
idempotency:      Requests have no side effects and may be replayed freely; Host maintains no timer and has zero overhead after the window closes
delivery:         desktop-only (standalone BrowserWindow + dedicated preload); not connected to conversation continuous / replayable paths
reuse decision:   Did not reuse services/process/processTreeSnapshot.ts (synchronous spawnSync, designed for app quit, different process list)
                  or CLI mcp/process-memory.ts (5-minute memory telemetry, tasklist only on Windows)—sampling must be asynchronous, use cputime,
                  and run inside Host, so the responsibilities differ; PowerShell CIM command format is similar to processTreeSnapshot, a known duplication
contracts/spec:   packages/shared protocol.ts / channels.ts / validation.ts / zcode-protocol; this document;
                  unit tests across desktop, services, ui, CLI + e2e resource-manager.test.ts
```

## File Inventory

| File                                                                                                    | Responsibility                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `desktop/src/main/resourceManagerWindow.ts`                                                             | Singleton window, Host / Agent process registry, `buildResourceUsageSnapshot()`, system CPU delta              |
| `desktop/src/main/resourceManagerHostSampling.ts`                                                       | main → Host sampling fan-out: requestId correlation, 900ms timeout, previous-result fallback                   |
| `desktop/src/main/resourceManagerProcessNames.ts`                                                       | Display names for non-BrowserWindow renderers (WebContentsView / DevTools / webview)                           |
| `desktop/src/main/desktopHostProcess.ts`                                                                | Forwards `ResourceUsageSnapshotResult`; `requestHostResourceUsage()` fan-out                                   |
| `desktop/src/host/hostResourceUsage.ts`                                                                 | Host-side sampling + attribution + reply                                                                       |
| `desktop/src/preload/resourceManager.ts`                                                                | Exposes `window.resourceManager.getSnapshot()` and `window.resourceManager.storage` (StorageManagementBridge)  |
| `desktop/src/main/resourceManagerStorage.ts`                                                            | Storage-tab IPC: owns StorageService, progress push, cancel on close, validate reveal path                     |
| `desktop/src/main/storageScanWorker.ts` / `storageScanWorkerClient.ts` / `storageScanWorkerProtocol.ts` | Scan Worker entry point and ScanRunnerPort implementation                                                      |
| `ui/src/resource-manager/storage/*`                                                                     | Storage-tab UI (disk cards, category list, details, cleanup confirmation) and `useStorageUsage`                |
| `desktop/src/renderer/resource-manager.html` / `src/resource-manager.tsx`                               | Standalone renderer entry point mounting `ResourceManagerApp` from `@zcode/ui`                                 |
| `ui/src/resource-manager/ResourceManagerApp.tsx`                                                        | Window UI (metric cards + grouped list); components live in `packages/ui` for Tailwind scanning                |
| `ui/src/resource-manager/resourceUsageView.ts`                                                          | Pure function for group aggregation and formatting                                                             |
| `services/src/process/processResourceSampler.ts`                                                        | Cross-platform process-table reading, CPU delta, process-tree attribution                                      |
| `services/src/zcode-agent/zcodeAgentService.ts`                                                         | `collectLocalRuntimeChildProcesses()`                                                                          |
| `shared/src/protocol.ts` / `channels.ts` / `validation.ts` / `zcode-protocol/index.ts`                  | Types, IPC channels, host-message schemas, CLI protocol                                                        |
| `apps/zcode-cli/.../mcp/telemetry.ts` / `zcode-protocol/server.ts`                                      | `listProcesses()` and `process/childProcesses` handling                                                        |

## UI Details

- Top tabs use `Tabs variant="line"` (same pill trigger as the Settings plugin tabs); test id `resource-manager-tab-{cpu|memory|storage}`; default CPU.
- Window size 900×600 with the system default title bar; theme and font size reuse the main window's `localStorage` (`zcode-theme` / UI font size); language uses the local preference in `ZCodeIntlProvider`.
- Metric cards: `bg-card border-card-border rounded-xl`; progress-bar background `bg-surface-hover`, machine-wide segment `bg-foreground-subtlest/40` (gray), ZCode segment `bg-brand` (color).
- Groups: fixed order Core services / Built-in plugins / Community plugins. Headers show process count and CPU/memory subtotals; empty groups show "No processes". Core services is expanded by default; others expand on demand. Expanded state is component-local.
- List rows: name (`font-medium`, full name in `title`), PID (`font-mono`), CPU, memory; unsampled rows show `—` for CPU/memory.
- Refresh interval 1s; requests are serialized (no new request while one is pending).
- If the `window.resourceManager` bridge is unavailable, show "Resource Manager interface unavailable".

## Tests

- Unit: `desktop/test/resourceManagerWindow.test.ts` (snapshot merge, Agent fallback, linux CPU normalization, system CPU delta), `services/test/processResourceSampler.test.ts` (three-platform parsing, CPU delta, tree attribution), `ui/test/resourceUsageView.test.ts` (group aggregation/formatting), CLI `mcp-telemetry.test.ts` (`listProcesses`).
- E2E `desktop/test/e2e/resource-manager-storage.test.ts`: Storage-tab scan / drill-down / safe and confirmed cleanup / retain logs from the current day (SM-01~05).
- E2E `desktop/test/e2e/resource-manager.test.ts`: open the window from the menu, verify three groups are visible on the default CPU tab, switch to Memory and verify metric cards change, verify `zcode-main` and `zcode-agent-*` rows appear, and verify Agent-row `memoryBytes > 0` after Host sampling. E2E helpers read `window.resourceManager.getSnapshot().processes`.
