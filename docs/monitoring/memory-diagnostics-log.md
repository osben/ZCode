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
   reuses the beat of the existing `process/resourceSample` sampler for the line-format log. The CLI profile file
   (below) has its own 15 s timer; it is the only extra timer.
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
   name, prompt or file content. **Exception (CLI profile file, see below):** the agent_node profile file
   `~/.zcode/cli/memory-diagnostics/memory-<ms>-<instanceId>.jsonl` carries a random `instanceId` (UUID), the CLI `pid`,
   the bundle's `bundleSha256`, and allocation stacks whose frames are functions of the CLI bundle itself (name, line,
   column). Frames from other files are dropped, so no user path or content appears. The file is local-only and reaches
   a feedback upload only through the log export described below.
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
- Log export (`exportLogs.ts`) and the user feedback archive (`prepareCompactLogArchive`) also collect the CLI
  profile files from `~/.zcode/cli/memory-diagnostics/` (see "CLI profile file"). The per-file and per-source caps
  for these files differ from the log caps; see that section.

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
| agent_node   | `v4.hydrations` / `v4.historyOpenings`                                                                                                   | In-flight conversation publisher hydrations, pending history openings (`hydrationInFlight`, `historyOpenings` maps)                                                                                                                                    |
| agent_node   | `v4.binaryCacheEntries` / `v4.binaryCacheBytes`                                                                                          | Entries and accumulated bytes of the binary read cache (`binaryReadCache`, `binaryReadCacheBytes`)                                                                                                                                                     |
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

The CLI's `collectMemoryDiagnostics({ includeEventStats })` option gates the `sessions` + `eventRows` /
`eventEvicted` / `eventTransientRetained` sums. The line-format sampler calls it with the default (all keys); the
profile recorder calls it with `includeEventStats: false` on each 15 s tick, so it never walks every session's
event store at that rate.

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
- Each workspace process on the CLI side has the existing `unref()` 60 s sampler timer plus one `unref()` 15 s timer
  for the profile recorder. Both are cleared by the sampler's `stop()`.

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
- CLI profile file: `apps/zcode-cli/packages/bootstrap/src/memory-diagnostics/recorder.ts` (recorder, allocation
  projection), `writer.ts` (retention and lock), `start.ts` (inspector profiler, bundle hash, wiring); wired from
  `zcode-protocol/resource-sampler.ts`, which returns the sampler wrapper that also stops the recorder.
- CLI: `apps/zcode-cli/packages/bootstrap/src/process-resource-sampler.ts`, `zcode-protocol-entrypoint.ts`,
  `zcode-protocol/server.ts`, `zcode-protocol-v4/v4-gateway.ts`,
  `apps/zcode-cli/packages/adapters/src/storage/index.ts`
- services: `packages/services/src/memoryDiagnostics.ts` and the self-registration of five services
- archive: `packages/services/src/feedback/feedbackLogArchive.ts` (`cli-memory` content policy), `compactLogArchive.ts`
  (first source), `packages/desktop/src/main/exportLogs.ts` (`createLogArchiveArtifacts` by-name collection and
  `createFeedbackLogArchiveFromExportLogs` source); sanitizer and bounds in `packages/shared/src/memoryDiagnostics.ts`
- host: `packages/desktop/src/host/hostMemoryDiagnosticsLog.ts` (gating and line format); the entry in
  host/index.ts is `hostSelfResourceTelemetry.ts`, which wraps this module and hands the same `memoryUsage()`
  reading to resource telemetry too (the `onMemoryUsage` hook is independent of the write gate: the local line may
  be skipped by gating while the telemetry sample is sent every 60 s)
- main: `packages/desktop/src/main/mainMemoryDiagnostics.ts`, `desktopResourceTelemetry.ts`
- renderer: `packages/ui/src/lib/memoryDiagnostics.ts`, `packages/ui/src/logger.ts`; the sampler's
  `reportHeapSample` injection point precedes the write gate and hands the same `performance.memory` reading to
  resource telemetry via `IPlatformService.reportRendererHeapSample` (the local line may be skipped by gating
  while the telemetry sample is sent every 60 s; Web and mobile remote control have no bridge, so it is a no-op)

## CLI profile file (agent_node)

The agent_node process also keeps a local V8 sampling profile and a heap-trend record, written to a separate
JSONL file. This is the only memory evidence in the CLI that is not a `[memory]` line.

- **Enablement:** always on, no environment variable or setting gates it. It starts with the protocol resource
  sampler (`startProtocolResourceSampler`) and stops with it.
- **Sampling:** `node:inspector` `HeapProfiler.startSampling` with `samplingInterval` 1 MiB,
  `stackDepth` 16, `includeObjectsCollectedByMajorGC` and `includeObjectsCollectedByMinorGC` both `false`. Every
  15 s the recorder reads `process.memoryUsage()` plus `v8.getHeapStatistics().heap_size_limit` and the counters
  (`includeEventStats: false`), and appends one entry to a ring of the last 8 samples.
- **Profile window:** the sampling profile is read each tick and reset (`HeapProfiler.disable` + `startSampling`)
  once the current window is 60 s old. The top 32 allocation sites are kept, keyed by self bytes and limited to
  frames whose script URL equals the running bundle (names and line / column only; the top 8 frames of each stack).
- **Write:** each tick writes one file `memory-<Date.now()>-<instanceId>.jsonl` containing one JSON object followed
  by a newline, under `~/.zcode/cli/memory-diagnostics/`. The format is `zcode-cli-memory-v1`:
  `format`, `timestamp`, `instanceId`, `pid`, `version`, `commit`, `node`, `v8`, `bundleSha256` (empty when the
  bundle is missing or larger than 128 MiB), `sampler`, `samples`, `allocations`.
- **Sampler states** (`sampler.state`):
  - `active`: profiling works and the recorder stays within its budgets.
  - `unsupported`: the initial `startSampling` failed; no profile is read and the profiler is disposed.
  - `budget-exceeded`: the profiler is disposed and the file keeps being written without a new profile, when any
    of these holds: the first `startSampling` took more than 25 ms; a tick's heap usage reached 80 % of
    `heapLimit`; the profile projection returned nothing (more than 4096 nodes visited); or the tick took more than
    25 ms (checked after the profile read and again at the end of the tick).
  - `error`: a profile read or projection threw; the profiler is disposed.
- **Sanitizer:** `sanitizeCliMemoryDiagnostic` (`packages/shared/src/memoryDiagnostics.ts`) is applied to the record
  before the write and again on read by the archive. Unknown keys are dropped; numbers are coerced to finite,
  non-negative values; `instanceId` must match `^[a-f0-9-]{36}$`, `bundleSha256` `^[a-f0-9]{64}$`, stack names
  `^[a-zA-Z0-9_$.[\]<>-]{0,64}$`, and `version` / `commit` / `node` / `v8` `^[a-zA-Z0-9._-]{1,80}$`. The counter
  keys are fixed to the `CLI_MEMORY_DIAGNOSTIC_COUNTER_KEYS` list and the memory keys to `CLI_MEMORY_DIAGNOSTIC_MEMORY_KEYS`.
- **Retention (writer):** under a `records` directory lock (`acquireFileLock`, no retry, 25 ms maximum wait).
  Temporary `.memory-*.tmp` files are removed. Files are removed when they are not regular files, have more than
  one link, exceed 65536 bytes, or are older than 7 days. Among the remaining files, the writing instance keeps only
  its newest older file, and then the 15 newest files of any instance are kept. The new record is added on top, so
  the directory holds at most 16 files.
- **Re-entrancy:** a module-level flag drops a write while another is in flight.
- **Export:** the log export (`createLogArchiveArtifacts`, `createFeedbackLogArchiveFromExportLogs`) and the
  feedback archive (`prepareCompactLogArchive`) include files matching `^memory-[0-9]+-[a-f0-9-]{36}\.jsonl$` from
  this directory, flat (no recursion), with no lookback window. The feedback source uses `contentPolicy: "cli-memory"`:
  at most 16 accepted files, each at most 65536 bytes, no `redactFeedbackText`. Each file is parsed as one JSON value,
  sanitized and re-serialized; unparseable or non-matching content is skipped as `invalid-memory-diagnostic`.

## Acceptance cases

| Case ID | Setup                                 | Action                                                                          | Assertions                                                                                                                                                                                          | Layer |
| ------- | ------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| MEM-001 | empty gate                            | first evaluate                                                                  | returns `first`                                                                                                                                                                                     | unit  |
| MEM-002 | last heap 100000                      | heap 104000, counters unchanged                                                 | returns `null`                                                                                                                                                                                      | unit  |
| MEM-003 | last heap 100000                      | heap 106000                                                                     | returns `changed`                                                                                                                                                                                   | unit  |
| MEM-004 | one counter key changes               | evaluate                                                                        | returns `changed`                                                                                                                                                                                   | unit  |
| MEM-005 | all unchanged                         | 300 s elapsed                                                                   | returns `heartbeat`, timing restarts                                                                                                                                                                | unit  |
| MEM-006 | registry has a throwing provider      | collect                                                                         | other providers return normally, the thrower is skipped                                                                                                                                             | unit  |
| MEM-007 | CLI sampler                           | inject readMemoryUsage                                                          | second onSample argument is the full memoryUsage, protocol sample shape unchanged                                                                                                                   | unit  |
| MEM-008 | host 60s tick                         | advance timer                                                                   | logger.info prints a line with `role=utility_host heapUsedKb=`; no more output after stop; the same reading is also sent as `HostResourceSample` via parentPort                                     | unit  |
| MEM-009 | main 6 x 10s ticks                    | advance timer                                                                   | logger.info prints a line with `role=main` and `ws.<process_role>=`; the same reading is also the main heap sample of `perf_process_window`                                                         | unit  |
| MEM-010 | renderer production build             | `logMemoryDiagnostics`                                                          | still calls the bridge; no-op without a bridge                                                                                                                                                      | unit  |
| MEM-011 | renderer 60s tick                     | advance timer                                                                   | the same reading sends the heap sample over the preload bridge and writes a local line per the gate; ticks skipped by the gate still send the sample; a bridge throw does not affect the local line | unit  |
| MEM-012 | CLI recorder with fake profiler       | first `start` under 25 ms                                                       | state `active`, `startSampling` called with `samplingInterval` 1 MiB and `stackDepth` 16                                                                                                            | unit  |
| MEM-013 | start takes 30 ms (fake clock)        | `start`                                                                         | state `budget-exceeded`, profiler disposed, no read on later ticks                                                                                                                                  | unit  |
| MEM-014 | `startSampling` throws                | `start`                                                                         | state `unsupported`, profiler disposed                                                                                                                                                              | unit  |
| MEM-015 | tick heapUsed >= 0.8 x heapLimit      | `sample`                                                                        | state `budget-exceeded`, file still written with that sample and no allocations change                                                                                                              | unit  |
| MEM-016 | projection visits > 4096 nodes        | `sample`                                                                        | state `budget-exceeded`, allocations array keeps the previous value                                                                                                                                 | unit  |
| MEM-017 | profile read throws                   | `sample`                                                                        | state `error`, profiler disposed, file written                                                                                                                                                      | unit  |
| MEM-018 | 60 s window elapsed                   | `sample` while `active`                                                         | `profiler.reset` called, `windowStartedAt` advances, `profileCapturedAt` is set                                                                                                                     | unit  |
| MEM-019 | sanitizer input                       | object with unknown keys, bad regex fields, non-finite numbers                  | output contains only known keys, bad strings become `""`, non-finite numbers become `0`, bad state returns `null`                                                                                   | unit  |
| MEM-020 | writer, 3 own-instance files          | `writeMemoryDiagnostic`                                                         | at most one older own file remains plus the new one; temp `.memory-*.tmp` removed; mode `0700` on directory                                                                                         | unit  |
| MEM-021 | writer, 20 other-instance files       | `writeMemoryDiagnostic`                                                         | at most 15 other files remain; files over 7 days or over 65536 bytes are removed                                                                                                                    | unit  |
| MEM-022 | archive, cli-memory source            | 17 valid files, one invalid JSON, one oversized, one wrong name, one nested dir | 16 cap applied, invalid skipped as `invalid-memory-diagnostic`, oversized skipped as `metadata-policy`, wrong name and nested files not collected, `about.txt` lists the counts                     | unit  |
| MEM-023 | log export, createLogArchiveArtifacts | memory dir with one valid file                                                  | file appears at `.zcode/cli/memory-diagnostics/<name>` and is not recency-filtered                                                                                                                  | unit  |
