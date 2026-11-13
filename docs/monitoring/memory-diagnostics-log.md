# Process memory local diagnostic log

Status: **confirmed, implemented per this spec**

## CLI allocation diagnostics (3.18.1)

Besides the 60-second base log described below, the CLI enables a separate, bounded diagnostics recorder once
app-server is ready. The goal is to correlate memory growth with release-code locations; it does not change task
scheduling, recovery or model behaviour.

- The CLI adapter is the single owner of collection and file retention. Bootstrap only exposes read-only counters
  and stops collection with the runtime.
- Every 15 seconds it reads the memory breakdown and read-only counters and keeps the last 8 readings: read-only
  session counts and V4 container sizes, without calling `eventStore.getStats()`, which walks historical events.
  Full event statistics keep the original 60-second period; message bodies are not walked and business objects are
  not re-serialized.
- It uses an in-process inspector Session: no debug port is opened, script sources are not read, no source map is
  generated or loaded, no heap snapshot is taken, no forced GC. The allocation sampling interval is 1 MiB with
  stack depth 16; the sampling window resets every 60 seconds.
- Each 15-second sample inspects at most 4096 profile nodes and outputs only the top 32 allocation hotspots with
  the last 8 stack frames of each. The profile is not retained size or a retention chain, and Buffer backing
  stores do not necessarily show up in the JS profile, so it must be read together with `external`.
- Only function names of the release bundle and zero-based line/column numbers are stored; for other scripts no
  paths, function names or source are stored. The bundle SHA-256, build version, Node/V8 versions, process
  instance and PID are stored, so growth can be located against the same internal build.
- At most one collect/write operation per round; when busy the round is dropped, not queued. If one synchronous
  sampling/projection exceeds 25 ms or the node count exceeds the limit, this process permanently degrades to
  metrics only. A sampling exception degrades the same way and must never throw into a task. Startup and exit do
  not wait for disk collection. After degrading, the record keeps the last valid hotspot and its collection time,
  so metrics-only rotation does not overwrite existing evidence. Past 80% of the heap-usage limit it also
  degrades, never materializing a profile near OOM. If a write is still in flight when the sampling window
  expires, the profiler is released; a slow disk must not let sampling state accumulate without bound.
- All CLI processes share `~/.zcode/cli/memory-diagnostics`: at most 2 completed files per instance, at most 16
  in the whole directory, 64 KiB each, completed files totalling at most 1 MiB. A directory lock serializes
  eviction and writing; contention retries only briefly and then drops the round. Evict first, then write, with
  atomic replacement; inside the lock, temporary files left by a previous crash are cleaned up, so at most one
  extra 64 KiB temporary file exists. Files older than 7 days are evicted too. The JSONL is not appended to, so
  it cannot grow without bound with run length or process restarts.
- Feedback full/compact archives and manual log export both carry the records. Feedback places this directory
  ahead of the normal logs, accepts only the specified file names and structured numeric/location fields, and
  must not drop a whole profile because generic body redaction matched it; environment variables, conversations,
  tool arguments, configuration or script contents are never uploaded. When feedback is submitted without
  attaching logs, this directory is not packaged or uploaded.
- A remote CLI records on the remote side; local feedback does not auto-download remote diagnostics. Mobile still
  reuses the Host and adds no duplicate collector.

```text
app-server ready -> adapter allocation sampling + 15s metrics -> bounded files (directory lock is the sole writer)
                          | 60s window reset                 |
                          v                                  v
                    over budget -> metrics only     existing feedback / log export -> structured safe projection
runtime stop -> stop timers, disconnect the inspector; a crash relies on the files already written
```

Acceptance: the CLI regression covers sampling-window reset, over-budget degradation, no writes after stop, no
queueing on slow writes, concurrent retention limits, expired/temporary-file cleanup and forbidden data fields; a
real runtime verifies allocation locations of the minified bundle and external growth of Buffers; the real
archive function is verified with synthetic records for full/compact carriage, privacy filtering and the total
budget. Alternating the sampling switch under the same load records CPU/elapsed time and the per-collection
cost; a "low sampling frequency" is not accepted in place of performance evidence.

Local verification (2026-11-11, macOS, Node 24.21.0 shipped with the desktop): a synthetic bundle, minified
without source maps, recorded allocation locations and a matching SHA-256, with a single inspection taking
13.8 ms. Across 8 same-load tests alternating the sampling switch, the median elapsed time was 441.9 ms off and
446.6 ms on (about +1.1%), with no median CPU increase. This short test measures the cost of allocation
sampling; the cost of the 15-second periodic check is measured separately and cannot be extrapolated into a
performance guarantee for all real tasks. After 8 processes competed to write 400 times, 14 valid files
totalling 10,164 bytes remained, with no leftover locks or temporary files. A real feedback archive kept the
allocation locations and removed injected body and environment-variable fields; Windows/Linux runtimes are not
verified yet.

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
   Host), agent_node (the `zcode-cli` of each workspace). The base log's sampling period is fixed at `60_000ms`;
   agent_node reuses the beat of the existing `process/resourceSample` sampler. The 3.18.1 allocation diagnostics
   use the separate 15-second timer described above.
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
      │ (bypasses prod gating, goes    │ (existing [host-log] forwarding) │ CLI logger.info
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

| role         | provider.key                                                                                                                             | Meaning                                                                                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| agent_node   | `sessions`                                                                                                                               | Number of resident protocol-server session records                                                                                                                                                                                                     |
| agent_node   | `eventRows`                                                                                                                              | Sum of in-memory event-store rows over all records                                                                                                                                                                                                     |
| agent_node   | `eventEvicted` / `eventTransientRetained`                                                                                                | Accumulated transient events evicted by the turn-window policy / transient events still resident (`apps/zcode-cli/docs/design/v2/session-event-store-retention.md`)                                                                                    |
| agent_node   | `v4.publishers` / `v4.detachedLive` / `v4.detachedTerminal` / `v4.rawSeqStates`                                                          | V4 gateway publishers, detached child sessions, terminal detached child sessions awaiting release, size of the raw seq state table                                                                                                                     |
| utility_host | `agent.sessionEmitters` / `agent.seqStates` / `agent.pendingPermissions` / `agent.pendingUserInputs`                                     | Per-session mirror tables of `zcodeAgentService`                                                                                                                                                                                                       |
| utility_host | `task.runtimeCommands` / `task.toolMemoryTasks` / `task.taskEmitters` / `task.overlays`                                                  | Per-task tables of `zcodeTaskServiceAdapter`                                                                                                                                                                                                           |
| utility_host | `terminal.open` / `fileWatcher.open`                                                                                                     | Number of pty and `fs.watch` instances                                                                                                                                                                                                                 |
| utility_host | `bots.streamSubs` / `bots.runningTasks` / `bots.typingIntervals` / `bots.liveStatusProgress`                                             | Per-task state of bots                                                                                                                                                                                                                                 |
| main         | `app.windows` / `app.willDownloadListeners`                                                                                              | Window count, `will-download` listeners on `defaultSession`                                                                                                                                                                                            |
| main         | `taskBus.streamBatches` / `taskBus.leases` / `taskBus.sessionRoutes`                                                                     | The three `TaskRealtimeBus` tables                                                                                                                                                                                                                     |
| main         | `guest.tabs` / `guest.closedTabIds`                                                                                                      | `BrowserGuestManager`                                                                                                                                                                                                                                  |
| main         | `broadcast.claims` / `broadcast.processes`                                                                                               | `BroadcastHub`                                                                                                                                                                                                                                         |
| main         | `ws.<process_role>` (`ws.main` / `ws.renderer_main` / `ws.renderer_guest` / `ws.gpu` / `ws.chromium_other` / `ws.host` / `ws.scheduler`) | Working set (KB) summed by `process_role` from `app.getAppMetrics()`. The role vocabulary is the same source as the ARMS `perf_process_window` (`docs/monitoring/process-resource-telemetry.md`); only roles with a live process this tick are printed |
| renderer     | `shiki.tokensCache` / `shiki.highlighters`                                                                                               | Code-highlight token cache entries                                                                                                                                                                                                                     |
| renderer     | `taskSnapshotCache.entries` / `taskSnapshotCache.persisted`                                                                              | Task snapshot in-memory and persisted cache entries                                                                                                                                                                                                    |
| renderer     | `sessionStore.workspaces`                                                                                                                | Workspace buckets of `zcodeSessionStore`                                                                                                                                                                                                               |
| renderer     | `projection.stores` / `projection.rows`                                                                                                  | Live V4 projection stores and the sum of their `rows.window` rows                                                                                                                                                                                      |
| renderer     | `xterm.sessions`                                                                                                                         | Resident sidebar terminal instances                                                                                                                                                                                                                    |
| renderer     | `taskQueryCache.queryKeys` / `taskQueryCache.taskMetas`                                                                                  | Task list query cache entries                                                                                                                                                                                                                          |
| renderer     | `toolLayout.openState`                                                                                                                   | Size of the tool-card expand-state table                                                                                                                                                                                                               |

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
- The CLI's base log reuses the resource-sampling timer; the allocation diagnostics hold their own separate
  `unref()` timer, which stops with the runtime.

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

| Case ID | Setup                            | Action                          | Assertions                                                                                                                                                                                          | Layer |
| ------- | -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| MEM-001 | empty gate                       | first evaluate                  | returns `first`                                                                                                                                                                                     | unit  |
| MEM-002 | last heap 100000                 | heap 104000, counters unchanged | returns `null`                                                                                                                                                                                      | unit  |
| MEM-003 | last heap 100000                 | heap 106000                     | returns `changed`                                                                                                                                                                                   | unit  |
| MEM-004 | one counter key changes          | evaluate                        | returns `changed`                                                                                                                                                                                   | unit  |
| MEM-005 | all unchanged                    | 300 s elapsed                   | returns `heartbeat`, timing restarts                                                                                                                                                                | unit  |
| MEM-006 | registry has a throwing provider | collect                         | other providers return normally, the thrower is skipped                                                                                                                                             | unit  |
| MEM-007 | CLI sampler                      | inject readMemoryUsage          | second onSample argument is the full memoryUsage, protocol sample shape unchanged                                                                                                                   | unit  |
| MEM-008 | host 60s tick                    | advance timer                   | logger.info prints a line with `role=utility_host heapUsedKb=`; no more output after stop; the same reading is also sent as `HostResourceSample` via parentPort                                     | unit  |
| MEM-009 | main 6 x 10s ticks               | advance timer                   | logger.info prints a line with `role=main` and `ws.<process_role>=`; the same reading is also the main heap sample of `perf_process_window`                                                         | unit  |
| MEM-010 | renderer production build        | `logMemoryDiagnostics`          | still calls the bridge; no-op without a bridge                                                                                                                                                      | unit  |
| MEM-011 | renderer 60s tick                | advance timer                   | the same reading sends the heap sample over the preload bridge and writes a local line per the gate; ticks skipped by the gate still send the sample; a bridge throw does not affect the local line | unit  |
