# Memory Leak Static Audit (2026-09-03)

Background: User reported continuously increasing desktop memory. This pass performs a read-only static audit of the entire repository, split across 6 paths by process boundaries (desktop main/host, services, UI store/hooks, UI components, agent CLI, rpc/server/shared), totaling approximately 900,000 lines of source code (excluding tests). Each finding has been verified by reading the surrounding context to confirm missing cleanup paths; pure grep hits not included; items marked with ✔ were double-verified by the lead reviewer against source code.

Audit conclusions only locate risks, containing no code modifications. Before fixing, design trade-offs must first be confirmed at the spec level (see "Design Issues Requiring Decisions").

## Process Perspective: Where Does Memory Grow

```
 Renderer (each window)                Local Host (each window)             Agent CLI (each workspace)
 ┌──────────────────────┐         ┌──────────────────────┐        ┌──────────────────────────┐
 │ shiki tokensCache    │         │ bots watchTaskStream │        │ InMemorySessionEventStore│
 │ task snapshot  cache │         │ pty / fs.watch orphans│        │   One event per token       │
 │ rows.window only increases │         │ per-session mirror states │        │   append O(n) copies        │
 │ workspaces buckets not deleted │         │ per-session mirror states │        │   Sub session publishers not freed │
 └──────────────────────┘         └──────────────────────┘        │ backgroundTasks / registry│
                                                                  └──────────────────────────┘
 Main (singleton)
 ┌────────────────────────────────────────────┐
 │ will-download listeners attached to defaultSession, leak on window close │
 │ TaskRealtimeBus.streamBatches non-terminal runs not deleted            │
 │ cron terminal state subscriptions / heartbeats intervals may persist  │
 └────────────────────────────────────────────┘
```

## I. High Risk (Each Can Independently Explain "Continuously Increasing")

### CLI-H1 ✔ Production sessions use memory event stores, per-token events permanently resident, append full copies

- `apps/zcode-cli/packages/adapters/src/storage/index.ts:26-60`: `eventsBySession: Map<SessionId, SessionEvent[]>`, `append` does `set(id, [...events, storedEvent])`, O(n) copies; only `deleteSession` can delete, core/bootstrap have no callers.
- `bootstrap/src/zcode-protocol/server-operations.ts:3493`, `bootstrap/src/app/create-app.ts:558`: Every protocol session record calls `createInMemorySessionEventStore()`.
- `core/src/runtime/methods/model-streaming-event.ts:11-12` → `events.ts:101`: Every `ModelStreaming` delta and `ToolCallProgress` enters the store; compacting (`core/src/compact`, `core/src/context`) does not reference eventStores, will not trim.
- Growth: One event per token / per tool progress, only increases and never decreases during session residence; `[...events, x]` creates O(n²) short-lived garbage intensifying GC; `rebuildProjection()` (`message-persistence.ts:509`) does full array reduction at multiple places within turns.
- Note: `events.ts:79-82` comments explain live sinks depend on eventStore-supplied `sequenceNumber` as the sole source of ordering truth, therefore "transient events do not enter stores" requires simultaneously guaranteeing seq assignments, a design change.

### CLI-H2 Subagent child sessions' V4 publishers never released

- `bootstrap/src/zcode-protocol/server-operations.ts:3225` routes child sessionIds' events to `v4Gateway.ingestDetachedLiveSession` (`v4-gateway.ts:810-816`), creating `ConversationTopicPublisher` (complete projection + 2000 log entries), `rawSequenceStates`, `detachedLiveSessions`, telemetry normalizers for child ids.
- The sole release path `cleanupSessionRuntime(sessionId)` (`v4-gateway.ts:1988-2041`) all callers pass parent ids, no parent→child mappings.
- Growth: Each subagent run leaks an entire set of publishers, remaining resident until process exit even after parent session closure/deactivation. Violates `docs/session-idle-deactivation.md` invariant #5.

### UI-H1 ✔ shiki token cache unbounded, streaming Edit previews write one entry per chunk

- `packages/ui/src/lib/shikiHighlighter.ts:59` `tokensCache`, writing at `:173`, no delete/clear/upper bounds in the entire file. Keys contain `code.length + first/last 100 characters`.
- Call chain `ToolCallBlocks/renderers/edit.tsx` → `EditInlineDiffContent.tsx:77` → `highlighted-lightweight-diff-preview.tsx:66`; `fileSummaries.ts:234-238` synthesizes diffs on-the-fly using `input.old_string/new_string`, each streaming projection chunk generates new patches new keys, each intermediate state is tokenized and permanently cached. Single entries up to 120k characters, `tokens` is two-dimensional ThemedToken arrays, volumes several times the source text.
- Two independent UI audits independently identified the same entry.

### UI-H2 ✔ task snapshot memory cache unbounded

- `packages/ui/src/hooks/useZCodeTaskService.ts:15-18`: `snapshotCacheByService: WeakMap<service, Map<key, {etag, snapshot}>>`, outer keys are app-level singletons equal to permanent; inner values are complete `ZCodeTaskSnapshot` (containing messages). Only deleted at `:276` when snapshots are empty. Persistence layer at the same file has triple caps of 20 entries/2MB/256KB; the memory layer does not.
- Growth: +1 each time a task is opened; +1 each time the same task switches messageLimit/model/thoughtLevel.

### MAIN-H1 ✔ `will-download` listeners attached to process-level defaultSession, leak on window close

- `packages/desktop/src/main/browserView/browserGuestManager.ts:2931-2932`, `:3651`, `:3661`. Webviews have no partition (no `partition` in the file), `guest.session` is `defaultSession`. `detachGuest` contains `if (!guestDestroyed) tab.downloadCleanup?.()`, when guests are already destroyed, skip; then `finally` sets `downloadCleanup` to undefined, no further cleanup opportunity.
- `index.ts:2388` `win.on("closed") → closeWindow()` necessarily hits (when windows close, guests are already destroyed with embedder). Each closed window leaks N closures (N = tab count), closures hold tabs/owners/managers; >10 triggers `MaxListenersExceededWarning`.
- Fix: `setupDownloadTracking` first `const guestSession = guest.session`, cleanup uses that reference `removeListener`, `detachGuest` calls unconditionally.

### MAIN-H2 ✔ `TaskRealtimeBus.streamBatches` runs ending non-terminal never deleted

- `packages/desktop/src/main/taskRealtimeBus.ts:129`, delete only at `:508`, `:532` both requiring `event.terminal`; `releaseLease` (`:353`)/`releaseLeasesForHost` (`:369`) only `flushBatch` not delete; `unregisterHost` does not touch.
- Host side `host/index.ts:1297-1310` unconditionally releases leases in `finally`, interruptions/cancellations/`sendPrompt` errors/remote disconnections all produce no terminal events.
- Growth: Each run ending non-terminal leaks one `PendingStreamBatch` (replay cap 60 batches/512KB); `registerHost`/`updateHostWorkspaceKeys` (`:739`) traverse all residual batches to replay to new hosts, opening more windows snowballs.

### SVC-H1 ✔ bots `watchTaskStream` per-task state only released by stream-internal terminal events

- `packages/services/src/bots/botsService.ts:762` `streamSubscriptions`, `:777` `runningTasks`, `:778` `liveStatusProgressByTaskId`, `:772-776` `typingTargets/typingIntervals`; sole release points `:4827-4877` (`task_complete`/`task_error`) and `:7416` overall dispose. `streamSubscriptions.delete` occurs only once in the entire file at `:4877`.
- Non-release paths: `:5643-5661` prompt failures only delete `runningTasks`; remote workspace disconnections/remote host restarts terminal states never arrive; UI-side task deletions, CLI crashes; `:4833` `writeContext` throws skipping dispose.
- Leaked objects: stream subscriptions + entire `handleStreamEvent` closures (full rounds `assistantParts`, `toolCalls` Maps, `streamingCardBlocks`).配套 `:2727-2732` Telegram/Weixin typing `setInterval` sends network requests every 4s, never stops.

### SRV-H1 web server `remoteConnections` and RemoteConnection never released

- `packages/server/src/http.ts:116, 336-355, 405-431`: `POST /api/connect-remote` launches SSH/Docker/WSL subprocesses then `set(id)`, only `delete` when `/ws/remote/:id` is consumed, no TTL. After consumption `socket.onClose` (`:109-112`) never calls `connection.dispose()` (`remote/connect.ts:295`), remote server subprocesses, stdio ChannelClients, stderr listeners accumulate with each web remote session.

## II. Medium Risk

### Structural Root Cause A: Services layer lacks "recovery by connection ownership" ✔

`packages/rpc/src/ipc.ts:137-141` disconnects only `channelServer.dispose()`; services/desktop/server full directories have no `onDidRemoveConnection` users. All OS-level resources created through non-Event RPCs, stored by id in registries, dangle after clients abnormal disconnects:

- `terminal/terminalService.ts:325, 393-401`: `terminals` Map + node-pty shell subprocesses.
- `fileWatcher/fileWatcherService.ts:40, 108-115`: `watchers` Map + `FSWatcher` (`.git` recursive listeners) + debounce timers.

### Structural Root Cause B: Services layer lacks "session terminal/close boundary" cleanups

`zcodeAgentService` / `zcodeTaskServiceAdapter` multiple groups of per-session/per-task mirror states only clear on workspace client generation changes or overall dispose, `closeSession`/`closeTask`/`deleteTask`/`session.removed` all leave untouched:

- `zcode-agent/zcodeAgentService.ts:1385, 2119-2137` `sessionEventSequenceStates` (single entry cap 10,000 ids, approximately 1~2MB/busy sessions).
- `:1388-1389` `pendingPermissions`/`pendingUserInputs` only writes, never reads (dead code leaks, one entry per permission request).
- `:1333, 1879-1888, 2107-2117` `sessionEmitters` only increase, never decrease, and `emitWorkspaceEvent` linearly scans the entire table; the same file `pluginOperationProgressEmitters` has already been self-collected using `onDidRemoveLastListener`, can be copied.
- `:1398-1399` `runtimeModelConfigBySessionKey`, `:1444` `sessionTraceIdBySessionKey` (`listSessions` dumps entire workspace history each time).
- `zcode-agent/zcodeTaskServiceAdapter.ts:263, 512-530, 553-575` Failed host commands permanently leave `runtimeCommands` (containing content + base64 attachments), and keep tasks "always active."
- `:269, 994-1010, 4344-4353` `toolProjectionMemoryByTaskKey` holds complete tool inputs (Write/Edit entire files), only forgets when tool results arrive; `clearToolProjectionMemory` (`:1008`) is dead code.
- `:259-272` `taskEmitters`/`globalTaskEmitters`/`overlays`/`taskTargets`/`apiRetryByTaskKey`/`backgroundTaskControlsByTaskKey`/`legacySnapshotTaskKeys` only cleared by disposeAll.
- `:267-268, 595-598` Adapters do not subscribe to runtime lifecycle; CLI crashes leave `activePromptInputIds` residuals, `drainRuntimeCommands` always early-returns, subsequent enqueue commands continuously accumulate.

### Structural Root Cause C: Main→host lacks "local workspace close" messages

- `host/windowHostControllerService.ts:278-329`, `host/index.ts:1178-1210, 1370-1390, 2693-2696`, `hostRemoteWorkspaceProxyState.ts:38-70`: `removeSource/disconnectSource` only called for remotes, local workspace sources (three sets of task meta + event subscriptions + sessions-index observers) and `taskMetaById` never deleted.

### Remaining Medium Risk

| Location                                                                                   | Issue                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host/windowRemoteConnectionRegistry.ts:390-411`                                           | Remote unexpected disconnection, `handleConnectionClosed` does not call `disposeEntry`, entire ServiceCollection/SSH backend held until users close tabs                                                                                        |
| `host/index.ts:791-840, 552-578`, `host/cronRunLifecycle.ts:40-58`                         | Cron/off-peak terminal subscriptions only released when `inputId === traceId`; session deletions, agent crashes, concurrent prompt overwrites inputId never hit; manual runs additionally have one 60s SQLite heartbeat interval                |
| `main/browserView/browserPlaywrightLocatorExecutor.ts:1114-1155` etc.                      | Each CDP command `Page.createIsolatedWorld` creates new V8 contexts and fully re-injects Playwright runtime, SPAs without navigation continuously accumulate (guest renderer memory)                                                            |
| `main/browserView/electronBrowserWebmRecorder.ts:286`                                      | Each screen recording `session.fromPartition(random names)`, Electron partitions have no destroy API                                                                                                                                            |
| `main/cuaPermissionDragPanel.ts:128-183`, `desktopCuaPermissionIpc.ts:194-222`             | `destroy()` after-late `show()` rebuilds BrowserWindow + 150ms intervals, nobody destroys                                                                                                                                                       |
| `main/appTelemetryRuntime.ts:34,85`                                                        | `rendererContexts` only increase, never decrease, by webContents.id                                                                                                                                                                             |
| `main/desktopHostProcess.ts:695-731`                                                       | Reload-respawn old host exit callbacks registered by shared keys, accidentally deletes new hosts (correctness defect)                                                                                                                           |
| `bots/botRemoteWorkspaceBridge.ts:56, 208-244, 268-276`                                    | `runtimeServicesByWorkspaceKey` disconnections/reconnections do not invalidate, pending never settle, dispose directly clears without resolving                                                                                                 |
| `ui/v4/conversationProjectionStore.ts:696-704` + `shared/zcode-protocol-v4/apply.ts:78-83` | `rows.window` only increases during live, never decreases, each delta full array copies + O(N) findIndex; `loadAllOlder` (`:1018-1150`) merges full history into window when wide-screen                                                        |
| `ui/store/zcodeSessionStore.ts` + `tabStore.ts:346`                                        | `workspaces[workspaceKey]` buckets have no deletion paths throughout; `remoteTimelineTaskStore`/`remotePinnedTaskStore` have `clearWorkspace` but no callers                                                                                    |
| `ui/store/taskQueryCacheStore.ts:472`, `hooks/useWorkspaceTaskLists.ts:320-322`            | queryKey contains `limit::version`, each bump/explore more adds new keys without deleting old                                                                                                                                                   |
| `ui/v4/windowControllerTaskListRegistry.ts:78, 218-228`                                    | `queryCache` caches entire results with search-term keys, search box keystrokes +1 each                                                                                                                                                         |
| `ui/feedback/feedbackSubmissionJob.ts:115, 410`                                            | Failed jobs never deleted, hold screenshots base64 ×2                                                                                                                                                                                           |
| `ui/v4/telemetry/ConversationTelemetryAttachment.tsx:222-240`                              | `useMemo` acquires side effects inside, discarded renders have no corresponding releases, refCounts forever >0, supervisors cannot release                                                                                                      |
| `ui/terminal/sidePaneTerminalSessionRegistry.ts:58`                                        | Permanent xterm instances without caps, detached state PTY output still writes scrollback (by design, but continuously consumes memory)                                                                                                         |
| `rpc/src/channelServer.ts:224-248, 270-277`                                                | Unregistered channel `pendingRequests` (containing parameters) timeouts not deleted; remote hosts not registering `cuaPermissionService` etc. channels each call +1                                                                             |
| `rpc/src/channelClient.ts:151-178` + `proxy-channel.ts:131-132`                            | Event handlers registered at creation time, Proxies each access to `service.onXxx` create new ones; simultaneously has correctness bugs "events not received after unsubscribing then re-subscribing"                                           |
| `rpc/src/ipc.ts:119-145`                                                                   | `IPCServer.disposables` only increase, never decrease, per connection (no production callers currently, latent)                                                                                                                                 |
| `web/src/main.tsx:1865-1881, 2200-2232` + `client/src/websocket.ts:102-105`                | Web-side bridge switching ChannelClients have no handles for dispose, in-flight RPCs never settle; desktop-side similar issues already fixed (`messageport.ts:19-24` comments), web not synchronized                                            |
| `rpc/src/remote.ts:294-321` + `persistent-protocol.ts:151-162, 274-285`                    | Reconnections do not close old sockets, can concurrently establish multiple reconnection chains, two intervals still run after failures (no production callers currently)                                                                       |
| `shared/zcode-protocol-v4/wire-assembler.ts:146, 465-491`                                  | `settledByRoute` tombstones without caps, callers never `discard()`                                                                                                                                                                             |
| `cli adapters/src/exec/node-execution-adapter-base.ts:32`                                  | `backgroundTasks` never deleted, each holding complete stdout (30K–150K characters) + AbortControllers                                                                                                                                          |
| `cli core/src/runtime-task/registry.ts:97-137`                                             | Terminal state subagents/Workflows preserve complete `output` + `prompt`; `removeRuntimeBackgroundTask` returns undefined for `Agents` so `local_agent` never removed                                                                           |
| `cli core/src/tool/executor/background-tasks.ts:311, 250-301`                              | Each background task has one 1s `setInterval`, emits infinitely retry on failure; `ToolExecutorImpl` has no dispose, sessions closing can pin entire runtimes                                                                                   |
| `cli core/src/tool/executor/impl.ts:57` + `handlers/read.ts:366` etc.                      | `readFileState` stores full text, keys = path+offset+limit, only cleared during compaction                                                                                                                                                      |
| `cli bootstrap/src/zcode-protocol-v4/persistent-command-index.ts:41,97`                    | `sessions` not cleaned during close/deactivation, comments stating LRU do not exist                                                                                                                                                             |
| `cli v4-gateway.ts:1955-1960`                                                              | `disposeSession` passes `clearCommandInbox: false`, each closed session leaves 512 ack buckets                                                                                                                                                  |
| `cli server-operations.ts:1861` + `session-residency.ts:79`                                | `legacyStreamSubscribed` set bit never cleared (no unsubscribe RPC), desktop still goes through this path (`services/.../zcodeTaskServiceAdapter.ts:3306`), hitting makes entire records never deactivate,叠加 CLI-H1 becomes continuous growth |

## III. Low Risk (Summary)

- main: `closedTabIds` tombstones without caps; `closeWindow()` bypassing `closeTab()` leaving downloads/scope tables; `sessionRoutes` sessions not deleted on closure; `desktopRemoteSessions` `PendingConnect` without timeouts; `webRemoteControlManager.stopWindowRuntime` not deleting `availableTasksByWindowId`; `promptAttachmentTransferService` unsubscribed emitters persist; host→main pending requests without timeouts; `hostLogRelay.rawLogs` unbounded before first structured log; `fetchRemoteAppConfig` without timeouts and size caps; `applicationIcons` permanently caches nulls.
- services: `ZCodeAgentProcessManager.ownedProcesses` cleanup failures permanently retained; `attachmentFlowRoutes` commit/aborts not deleted; syncer per-workspace states without release entries; `workspaceProviderRegistryByKey` only increases; feedback `uploadOssForm` missing error listeners, Promises never settle; feishu `typingReactionIds` module-level only deleted after DELETE successes, `userDisplayNameCache` not evicted; `bindCodes`/`recentRemoteReconnectAtByKey` not pruned; `cuaOperationTurnTracker.lastSeqBySession` not cleared session-closed; `featureGates` accumulate by apiKey.
- ui: `useComposerAttachments` three Map refs without unmount cleanups (in-flight uploads do not abort); `conversationProjectionStore.close()` does not clear listeners/snapshots; `optimisticCommands` non-sendText without TTLs; `useRemoteConnectionLogs` without caps; `workspaceHomePathCache`/`statusCache` keys contain reconnection ids; `ToolLayout.toolLayoutOpenState` without bounds; `ConversationRowView` PDF preview blobs/Aborts without unmount cleanups.
- cli: `sleep()` normal wake-ups do not remove abort listeners; protocol records `seqBySourceEventKey`/`streamedToolCallIdsWithInput` without bounds; `RawSequenceState.seenEventIds/appliedEventIds` without bounds; `waitForBackgroundTask` residue continuations after aborts; `requestClient` replays approximately 360 pending keys per hour; MCP telemetry sampling failure records not released; `node-repl` closures pin first contexts.
- rpc/shared: `getChannel` filters listeners hung when no matches; `EventMultiplexer.disposables` not removed on connections disconnecting; `CancellationTokenSource` only cancels, does not dispose.

## IV. Areas Confirmed Clean (Coverage Descriptions)

- main: Window-level Maps uniformly deleted in `browser-window-created → closed`; per-host listeners expire with UtilityProcess lifetimes; BroadcastHub claims TTL+caps; TaskRealtimeBus remaining tables have timeouts/caps; telemetry family samples have caps; autoUpdater/OAuth/CUA/webRemoteControl transports paired; preload 36 `on*` all return cancellation functions; full-scope no `setMaxListeners`, no `fs.watch`.
- services: `zcodeStdioTransport`/`zcodeProtocolClient` pending all-path deletes; `zcodeAgentProcessManager` main tables cleanly cleaned; `zcodeAgentConnectionScope` 1024 frames/32MiB dual caps; coalescers bounded; git/process/repo-snapshot/repo-wiki/telemetryCore/settings-sync/plugin-sync/model-provider all finally cleaned; `node.ts` disposeAll coverage complete.
- ui: `logger.ts` does not buffer; streaming text as string concatenation leaves no chunk arrays; `removeTaskState` completely deletes 7 sub-tables; timeline virtualization + 4000-entry LRU row-height caching; all Observers disconnect; createObjectURL paired revoke except PDF previews; streamdown caches 100 entries; `v4` registries keep-warm then dispose; `pendingCommandRegistry` 24h TTLs.
- cli: `SessionResidentPool` four deletion paths complete (but eligible conditions pinned by legacy subscriptions, see medium risk table); providers stream without leaving SSE chunks, abort listeners/linked controllers finally cleaned; http `maxResponseBytes` + `reader.cancel`; telemetry `maxActiveCalls=1000`, OTLP queues 2000, trace writers 5000; MCP per-session leases zero close 30s; foreground Bash output bounded, `activeExecutions` finally cleaned; subagent runner abort/watchdog all-path disposes.
- rpc/server/shared: `ChannelClient`/`ChannelServer` main tables four-path deletes; Logging/NetworkTelemetry middlewares stateless; `PersistentProtocol` replays 8MiB/45s dual caps; server `hostCapability` TTLs; `remote/connect.ts` dispose complete; web remote control 6 timers paired, `pairedWaiters` all-path deletes; renderer bootstrap all return cleanup.

## V. Design Issues Requiring Decisions (Confirm Before Fixing)

1. **CLI event store responsibilities**: Should `ModelStreaming`/`ToolCallProgress` enter stores? If not, live sink's `sequenceNumber` needs另行 allocation (`events.ts:79-82` comments explicitly state seqs must only come from stores). Alternatives: enter stores then discard transient events at `ModelComplete`/`ToolCallResult` times, and change append to in-place pushes.
2. **Legacy `session/subscribe` pinning permanent residence**: Requires adding legacy unsubscribe RPCs, or clearing marks when consumer connections disconnect, otherwise `SessionResidentPool` is meaningless for sessions opened on desktop.
3. **Main→host local workspace close messages**: `HostMessageTypes` needs a new message, once clearing controller sources, `workspaceProxyState`, `workspaceTaskTracker`, simultaneously adding `forgetSessionState(sessionKey)` / `forgetTaskState(taskKey)` boundaries to services.
4. **RPC recovery by connections**: Whether services uniformly subscribe to `IPCServer.onDidRemoveConnection` for recovering pty/fs.watch, or add idle timeouts to resources without subscribers.

## VI. Suggested Fix Order

1. One-line fixes, always leak on each occasion: MAIN-H1 (will-download), MAIN-H2 (streamBatches), UI-H1 (shiki LRU), UI-H2 (snapshots LRU).
2. bots `releaseTaskWatch` uniform release + typing interval caps (SVC-H1).
3. CLI-H2 parent→child publisher mappings; CLI M5/M6 letting close/deactivation truly leave no residuals.
4. Design decisions 1, 2 (CLI event store + legacy subscribe), the primary root causes of "continuous growth" in long sessions.
5. One unified boundary for each of structural root causes A/B/C.
6. Remaining medium/low risks handled module-by-module.

## VII. Verification Suggestions

- Before fixing, capture runtime evidence: renderers use DevTools heap snapshots comparing `TokenizedCode`/`ZCodeTaskSnapshot` instance counts; hosts/CLIs use `process.memoryUsage()` periodic sampling + `--heapsnapshot-signal`, comparing `SessionEvent`, `PendingStreamBatch`, `streamSubscriptions` sizes.
- Reproduction scripts: open/close windows 20 times to watch main process `defaultSession.listenerCount("will-download")`; run one session continuously 30 turns streaming output to watch CLI RSS curves; bot scenarios disconnect remote workspaces to observe whether typing requests stop.

## VIII. 2026-09-04 Real Machine Log Observations (After Diagnostic Logs Go Online)

- **Event store retention strategy verified**: Amount of eviction at the start of parent session's next turn exactly matches the previous turn's transient count; subagent child sessions are cleared by 2-minute time fallback in a single turn (7554 lines → 254 lines). Child session records are pooled and recycled after approximately 3~7 minutes.
- **`v4.detachedLive` increments by +1 per subagent run and does not回落**: Audit CLI-H2 confirmed, pending fix.
- **Host process RSS repeatedly peaks to 1.5GB, externalKb 1.3GB,回落s after several minutes**: Timestamps match repo snapshot (checkpoint) captures. The cause is `repoSnapshotFilter.ts` unconditionally allowing `.git/` internal files (bypassing 1MB per-file caps and all exclusion rules), this repository's `.git` is 1.2GB, so **every prompt send and each turn end** packages, sha256, AES-encrypts and attempts to upload a 1.3GB `.tar.gz.enc`; this workspace `failureCount=9`, `~/.zcode/v2/checkpoints/*/pending` has backlogs of 1.77GB (from 8/27), 1.26GB, 0.66GB unuploaded products, `~/.zcode/v2` totals 7.6GB. This is a product/spec-layer issue (`repo-snapshot-sidecar.md` requires complete Git metadata), not a leak; decisions needed: exclude `.git/objects/pack` or set total caps for `.git`, or skip captures when workspaces exceed thresholds.
- **Remote control relay mutual-kick infinite loops**: Two desktop instances connect to relay using the same account, each approximately 22 reconnections/minute, no backoff (the other instance 6000+ reconnections that day). Corresponding audit `webRemoteControlTransport` reconnection without backoff items.
- **Renderer periodic ~25s bursts of 10 `listTaskList` calls** (1189 total per round), corresponding to audit UI M6 version number invalidity amplification.
- **Main `taskBus.sessionRoutes` 2565 entries** only increase, never decrease (approximately 250KB), corresponding to audit L4.
