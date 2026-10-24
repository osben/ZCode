# Process memory local diagnostic log

Status: **confirmed, implemented per this spec**

## Problem

When users report steadily growing desktop memory, a log archive could not answer three questions: which process
grows, whether it is JS heap or native memory, and which memory table grows. Existing ARMS resource telemetry has
only 5-minute aggregates of RSS / working set, nothing numeric lands in local logs, and the renderer has no memory
dimension at all. The repo-wide static audit (`docs/analysis/memory-leak-audit-2026-09-03.md`) lists high-risk
growth points spread over main / renderer / host / agent CLI, and runtime evidence is needed before deciding which
to fix.

This feature solves only **local locating**: each process writes one line of "heap breakdown + domain counters" to
its own existing local log under a gating rule. It does not report to ARMS, change the ZCode Protocol schema, add
host→main or renderer→main message types, or change any business logic.

## Product contract

1. Four process kinds each sample their own memory: main, renderer (per window), utility_host (per-window Local
   Host), agent_node (the `zcode-cli` of each workspace). The sampling period is fixed at `60_000ms`; agent_node
   reuses the beat of the existing `process/resourceSample` sampler and adds no timer.
2. Sampling and writing are separate. After each sample it is written on any of these conditions, otherwise
   dropped:
   - first sample (`reason=first`);
   - `heapUsedKb` changed by more than `5%` relative to the **last written value**, or `rssKb` / `externalKb` by
     more than `10%`, or any domain counter differs from the last written value (`reason=changed`); native /
     external take part in the decision separately because real machines showed host RSS jumping from 240 MB to
     1.5 GB with the heap hardly moving;
   - `300_000ms` since the last write (`reason=heartbeat`).
3. Worst case is one line per process per minute and, when idle, one line per 5 minutes. Estimated for 8
   processes: about 3.4 MB per day, roughly a tenth of the current log volume.
4. Log lines contain only numbers and low-cardinality enums: no pid, path, workspace / session / task id, model
   name, prompt or file content.
5. A failure in sampling, counter reading, formatting or writing drops only the current sample: no retry, no
   queue, no business impact.
6. The gating and formatting logic has a single implementation, `packages/shared/src/memoryDiagnostics.ts`, reused
   by all four process kinds.

## Data flow

```text
 renderer (per window)            host (per window)               zcode-cli (per workspace)
 60s: performance.memory          60s: process.memoryUsage()      existing 60s sampler, inside onSample
      + ui domain counters             + services domain counters       process.memoryUsage()
      │ logger.logMemoryDiagnostics    │ host logger.info                + server domain counters
      │ (bypasses prod gating, goes     │ (existing [host-log] forwarding) │ CLI logger.info
      │  through window.zcode.log)      v                                 v
      v
 ~/.zcode/v2/logs/YYYY-MM-DD.log  ←── main 60s: memoryUsage + per-role working set + main counters
                                                                ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl
```

- Lines of main / host / renderer all land in the Desktop main log (host via the existing `[host-log]` forwarding,
  renderer via the existing preload `window.zcode.log` bridge).
- agent_node writes the CLI's own JSONL log. The CLI log of a remote workspace stays on the remote machine; this
  is deliberate, as resource samples add no protocol fields.
- Log export (`exportLogs.ts`) and the user feedback archive (`prepareCompactLogArchive`) already cover these
  files and need no change.

## Line format

Desktop side (main / host / renderer), one `key=value` line:

```text
[memory] role=main reason=changed rssKb=412300 heapUsedKb=91234 heapTotalKb=120000 externalKb=30211 arrayBuffersKb=2048 app.willDownloadListeners=3 app.windows=2 taskBus.leases=1 taskBus.sessionRoutes=14 taskBus.streamBatches=0 ws.chromium_other=120000 ws.gpu=88000 ws.host=380000 ws.main=412300 ws.renderer_main=910000 ...
```

- Fixed field order: `role`, `reason`, `rssKb`, `heapUsedKb`, `heapTotalKb`, `externalKb`, `arrayBuffersKb`;
  missing fields are omitted (the renderer has no rss / external).
- Counters are named `<provider>.<key>`, printed in lexicographic order, values rounded.
- All KB values are rounded.

The CLI side writes a structured log: `event=zcode_protocol.process.memory_sample`,
`module=bootstrap.zcode_protocol`, with `reason`, the five memory fields and a `counters` object in `context`.

## Domain counters

| role | provider.key | Meaning |
| --- | --- | --- |
| agent_node | `sessions` | Number of resident protocol-server session records |
| agent_node | `eventRows` | Sum of in-memory event-store rows over all records |
| agent_node | `eventEvicted` / `eventTransientRetained` | Accumulated transient events evicted by the turn-window policy / transient events still resident (`apps/zcode-cli/docs/design/v2/session-event-store-retention.md`) |
| agent_node | `v4.publishers` / `v4.detachedLive` / `v4.detachedTerminal` / `v4.rawSeqStates` | V4 gateway publishers, detached child sessions, terminal detached child sessions awaiting release, size of the raw seq state table |
| utility_host | `agent.sessionEmitters` / `agent.seqStates` / `agent.pendingPermissions` / `agent.pendingUserInputs` | Per-session mirror tables of `zcodeAgentService` |
| utility_host | `task.runtimeCommands` / `task.toolMemoryTasks` / `task.taskEmitters` / `task.overlays` | Per-task tables of `zcodeTaskServiceAdapter` |
| utility_host | `terminal.open` / `fileWatcher.open` | Number of pty and `fs.watch` instances |
| utility_host | `bots.streamSubs` / `bots.runningTasks` / `bots.typingIntervals` / `bots.liveStatusProgress` | Per-task state of bots |
| main | `app.windows` / `app.willDownloadListeners` | Window count, `will-download` listeners on `defaultSession` |
| main | `taskBus.streamBatches` / `taskBus.leases` / `taskBus.sessionRoutes` | The three `TaskRealtimeBus` tables |
| main | `guest.tabs` / `guest.closedTabIds` | `BrowserGuestManager` |
| main | `broadcast.claims` / `broadcast.processes` | `BroadcastHub` |
| main | `ws.<process_role>` (`ws.main` / `ws.renderer_main` / `ws.renderer_guest` / `ws.gpu` / `ws.chromium_other` / `ws.host` / `ws.scheduler`) | Working set (KB) summed by `process_role` from `app.getAppMetrics()`. The role vocabulary is the same source as the ARMS `perf_process_window` (`docs/monitoring/process-resource-telemetry.md`); only roles with a live process this tick are printed |
| renderer | `shiki.tokensCache` / `shiki.highlighters` | Code-highlight token cache entries |
| renderer | `taskSnapshotCache.entries` / `taskSnapshotCache.persisted` | Task snapshot in-memory and persisted cache entries |
| renderer | `sessionStore.workspaces` | Workspace buckets of `zcodeSessionStore` |
| renderer | `projection.stores` / `projection.rows` | Live V4 projection stores and the sum of their `rows.window` rows |
| renderer | `xterm.sessions` | Resident sidebar terminal instances |
| renderer | `taskQueryCache.queryKeys` / `taskQueryCache.taskMetas` | Task list query cache entries |
| renderer | `toolLayout.openState` | Size of the tool-card expand-state table |

A new counter self-registers in its module with `registry.register(name, provider)`; a provider must be a pure
read (only `Map.size` / `Set.size` / array length), must not change state and must not do IO.

## Mandatory boundaries

- `zcodeProcessResourceSampleSchema` is unchanged; protocol samples still send only `rssKb` / CPU fields.
- Memory samples are not wired into `session/event`, V4 conversation frames, the task realtime bus, snapshot,
  queue, continuous or replayable recovery chains; mobile `/remote` does not take part.
- The renderer writes through `logMemoryDiagnostics` in `packages/ui/src/logger.ts`; it is the "official
  monitoring chain" exception in `docs/performance/renderer-production-logging.md`, production builds still go
  through the bridge, and on Web with no bridge it is a no-op. UI modules must not call `window.zcode.log`
  directly.
- Main does not supplement other processes with `ps` / PowerShell; it uses only `process.memoryUsage()` and
  `app.getAppMetrics()`.
- Each workspace process on the CLI side has only the one existing `unref()` timer.

## How to read

```bash
# Desktop main log: heapUsed curve by role
grep '\[memory\] role=renderer' ~/.zcode/v2/logs/2026-09-03.log \
  | sed -E 's/^\[([^]]+)\].*heapUsedKb=([0-9]+).*shiki\.tokensCache=([0-9]+).*/\1 \2 \3/'

# CLI log
grep memory_sample ~/.zcode/cli/log/zcode-2026-09-03.jsonl | jq -c '[.time, .context.heapUsedKb, .context.counters.eventRows]'
```

Reading order: first find which `role` has a monotonically rising `heapUsedKb`; then which counter on the same line
rises with it; if `rssKb` grows but `heapUsedKb` does not, it is native / ArrayBuffer memory, so look at
`externalKb` / `arrayBuffersKb`.

## Implementation

The sampling source is shared with [all-process CPU / memory telemetry](./process-resource-telemetry.md): the
60-second timers of host and renderer feed one reading to both the local log and ARMS samples; main's heap
reading joins the resource telemetry's 10-second tick (once every 6 ticks); the CLI is already in shared form. The
gating and line format of this document are unchanged; main's `ws.*` counters moved to the new `process_role`
vocabulary together with the resource telemetry's role classifier (`ws.renderer` → `ws.renderer_main` /
`ws.renderer_guest`, `ws.utility_host` → `ws.host`, `ws.other` → `ws.chromium_other`, new `ws.scheduler`), so the
same classification logic does not keep two sets of role names.

- Shared: `packages/shared/src/memoryDiagnostics.ts` (`createMemorySampleWriteGate`, `formatMemorySampleLine`,
  `createMemoryDiagnosticsRegistry`, `memoryUsageToSampleFields`)
- CLI: `apps/zcode-cli/packages/bootstrap/src/process-resource-sampler.ts`, `zcode-protocol-entrypoint.ts`,
  `zcode-protocol/server.ts`, `zcode-protocol-v4/v4-gateway.ts`,
  `apps/zcode-cli/packages/adapters/src/storage/index.ts`
- services: `packages/services/src/memoryDiagnostics.ts` and the self-registration of five services
- host: `packages/desktop/src/host/hostMemoryDiagnosticsLog.ts` (gating and line format); the entry in
  host/index.ts is `hostSelfResourceTelemetry.ts`, which wraps this module and hands the same `memoryUsage()`
  reading to resource telemetry too (the `onMemoryUsage` hook is independent of the write gate: the local line may
  be skipped by gating while the telemetry sample is sent every 60 s)
- main: `packages/desktop/src/main/mainMemoryDiagnostics.ts`, `desktopResourceTelemetry.ts`
- renderer: `packages/ui/src/lib/memoryDiagnostics.ts`, `packages/ui/src/logger.ts`; the sampler's
  `reportHeapSample` injection point precedes the write gate and hands the same `performance.memory` reading to
  resource telemetry via `IPlatformService.reportRendererHeapSample` (the local line may be skipped by gating
  while the telemetry sample is sent every 60 s; Web and mobile remote control have no bridge, so it is a no-op)

## Acceptance cases

| Case ID | Setup | Action | Assertions | Layer |
| --- | --- | --- | --- | --- |
| MEM-001 | empty gate | first evaluate | returns `first` | unit |
| MEM-002 | last heap 100000 | heap 104000, counters unchanged | returns `null` | unit |
| MEM-003 | last heap 100000 | heap 106000 | returns `changed` | unit |
| MEM-004 | one counter key changes | evaluate | returns `changed` | unit |
| MEM-005 | all unchanged | 300 s elapsed | returns `heartbeat`, timing restarts | unit |
| MEM-006 | registry has a throwing provider | collect | other providers return normally, the thrower is skipped | unit |
| MEM-007 | CLI sampler | inject readMemoryUsage | second onSample argument is the full memoryUsage, protocol sample shape unchanged | unit |
| MEM-008 | host 60s tick | advance timer | logger.info prints a line with `role=utility_host heapUsedKb=`; no more output after stop; the same reading is also sent as `HostResourceSample` via parentPort | unit |
| MEM-009 | main 6 x 10s ticks | advance timer | logger.info prints a line with `role=main` and `ws.<process_role>=`; the same reading is also the main heap sample of `perf_process_window` | unit |
| MEM-010 | renderer production build | `logMemoryDiagnostics` | still calls the bridge; no-op without a bridge | unit |
| MEM-011 | renderer 60s tick | advance timer | the same reading sends the heap sample over the preload bridge and writes a local line per the gate; ticks skipped by the gate still send the sample; a bridge throw does not affect the local line | unit |
