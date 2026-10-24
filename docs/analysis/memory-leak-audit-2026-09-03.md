# Memory Leak Static Audit (2026-09-03)

Full history: `git show 45f808f7:docs/analysis/memory-leak-audit-2026-09-03.md`.

Background: a user reported continuously increasing desktop memory. This pass is a read-only static audit of the whole repository (about 900,000 lines excluding tests), split into 6 paths by process boundary (desktop main/host, services, UI store/hooks, UI components, agent CLI, rpc/server/shared). Each finding was verified by reading the surrounding context to confirm the missing cleanup path; pure grep hits are excluded. Items marked ✔ were double-verified by the lead reviewer against the source.

The audit only locates risks and contains no code changes. Before fixing, confirm design trade-offs at the spec level (see "Design Issues Requiring Decisions"). Fix status of individual items is not tracked here except where stated; the CLI event store item (CLI-H1) is implemented per `apps/zcode-cli/docs/design/v2/session-event-store-retention.md` (see [fix plan](./memory-leak-fix-plan-cli-event-store.md)).

## Process Perspective: Where Memory Grows

```
 Renderer (each window)                Local Host (each window)             Agent CLI (each workspace)
 ┌──────────────────────────┐   ┌──────────────────────────┐   ┌────────────────────────────┐
 │ shiki tokensCache        │   │ bots watchTaskStream     │   │ InMemorySessionEventStore  │
 │ task snapshot cache      │   │ pty / fs.watch orphans   │   │   one event per token      │
 │ rows.window only grows   │   │ per-session mirror states│   │   append copies O(n)       │
 │ workspaces buckets kept  │   │                          │   │   subagent publishers kept │
 └──────────────────────────┘   └──────────────────────────┘   │ backgroundTasks / registry │
                                                               └────────────────────────────┘
 Main (singleton)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ will-download listeners on defaultSession leak on window close           │
 │ TaskRealtimeBus.streamBatches: non-terminal runs never deleted           │
 │ cron terminal-state subscriptions / heartbeat intervals may persist      │
 └──────────────────────────────────────────────────────────────────────────┘
```

## I. High Risk (Each Can Independently Explain "Continuously Increasing")

### CLI-H1 ✔ Production sessions use in-memory event stores; per-token events stay resident and append copies the full array

- `apps/zcode-cli/packages/adapters/src/storage/index.ts:26-60`: `eventsBySession: Map<SessionId, SessionEvent[]>`; `append` does `set(id, [...events, storedEvent])` (O(n) copy); only `deleteSession` removes, and core/bootstrap have no callers.
- `bootstrap/src/zcode-protocol/server-operations.ts:3493`, `bootstrap/src/app/create-app.ts:558`: every protocol session record calls `createInMemorySessionEventStore()`.
- `core/src/runtime/methods/model-streaming-event.ts:11-12` → `events.ts:101`: every `ModelStreaming` delta and `ToolCallProgress` enters the store; compaction (`core/src/compact`, `core/src/context`) does not reference event stores and never trims.
- Growth: one event per token / tool progress, only increasing while the session is resident; `[...events, x]` creates O(n²) short-lived garbage that intensifies GC; `rebuildProjection()` (`message-persistence.ts:509`) does a full array reduction at several places within turns.
- Note: `events.ts:79-82` states live sinks rely on event-store-supplied `sequenceNumber` as the sole ordering truth, so "transient events do not enter stores" must also guarantee seq assignment (a design change).

### CLI-H2 Subagent child sessions' V4 publishers are never released

- `bootstrap/src/zcode-protocol/server-operations.ts:3225` routes child sessionIds' events to `v4Gateway.ingestDetachedLiveSession` (`v4-gateway.ts:810-816`), creating a `ConversationTopicPublisher` (complete projection + 2000 log entries), `rawSequenceStates`, `detachedLiveSessions`, and telemetry normalizers for child ids.
- The only release path `cleanupSessionRuntime(sessionId)` (`v4-gateway.ts:1988-2041`) is called with parent ids only; no parent→child mapping exists.
- Growth: each subagent run leaks a whole set of publishers that stays resident until process exit, even after the parent session closes/deactivates. Violates `docs/session-idle-deactivation.md` invariant #5.

### UI-H1 ✔ shiki token cache is unbounded; streaming Edit previews write one entry per chunk

- `packages/ui/src/lib/shikiHighlighter.ts:59` `tokensCache`, written at `:173`, no delete/clear/upper bound in the file. Keys contain `code.length + first/last 100 characters`.
- Call chain: `ToolCallBlocks/renderers/edit.tsx` → `EditInlineDiffContent.tsx:77` → `highlighted-lightweight-diff-preview.tsx:66`; `fileSummaries.ts:234-238` synthesizes diffs on the fly from `input.old_string/new_string`, so each streaming projection chunk yields a new patch and key; every intermediate state is tokenized and cached forever. Entries reach 120k characters, and `tokens` is a two-dimensional ThemedToken array several times the source text.
- Two independent UI audits found the same entry.

### UI-H2 ✔ Task snapshot memory cache is unbounded

- `packages/ui/src/hooks/useZCodeTaskService.ts:15-18`: `snapshotCacheByService: WeakMap<service, Map<key, {etag, snapshot}>>`; outer keys are app-level singletons (effectively permanent) and inner values are complete `ZCodeTaskSnapshot` (with messages). Deleted only at `:276` when a snapshot is empty. The persistence layer in the same file caps at 20 entries/2MB/256KB; the memory layer has no cap.
- Growth: +1 per opened task; +1 each time the same task switches messageLimit/model/thoughtLevel.

### MAIN-H1 ✔ `will-download` listeners attach to the process-level defaultSession and leak on window close

- `packages/desktop/src/main/browserView/browserGuestManager.ts:2931-2932`, `:3651`, `:3661`. Webviews have no partition, so `guest.session` is `defaultSession`. `detachGuest` has `if (!guestDestroyed) tab.downloadCleanup?.()`, which skips cleanup when guests are already destroyed; then `finally` sets `downloadCleanup` to undefined, leaving no later chance.
- `index.ts:2388` `win.on("closed") → closeWindow()` always hits this (guests are destroyed with the embedder when windows close). Each closed window leaks N closures (N = tab count) holding tabs/owners/managers; above 10 triggers `MaxListenersExceededWarning`.
- Fix: `setupDownloadTracking` first takes `const guestSession = guest.session`, cleanup uses that reference's `removeListener`, and `detachGuest` calls it unconditionally.

### MAIN-H2 ✔ `TaskRealtimeBus.streamBatches` entries for runs ending non-terminally are never deleted

- `packages/desktop/src/main/taskRealtimeBus.ts:129`; deletion only at `:508`, `:532`, both requiring `event.terminal`; `releaseLease` (`:353`) / `releaseLeasesForHost` (`:369`) only `flushBatch`; `unregisterHost` does not touch it.
- Host side `host/index.ts:1297-1310` releases leases unconditionally in `finally`; interruptions, cancellations, `sendPrompt` errors, and remote disconnections produce no terminal event.
- Growth: each non-terminally ended run leaks one `PendingStreamBatch` (replay cap 60 batches/512KB); `registerHost`/`updateHostWorkspaceKeys` (`:739`) traverse all residual batches to replay to new hosts, so more windows snowball it.

### SVC-H1 ✔ bots `watchTaskStream` per-task state is released only by in-stream terminal events

- `packages/services/src/bots/botsService.ts:762` `streamSubscriptions`, `:777` `runningTasks`, `:778` `liveStatusProgressByTaskId`, `:772-776` `typingTargets/typingIntervals`; the only release points are `:4827-4877` (`task_complete`/`task_error`) and `:7416` overall dispose. `streamSubscriptions.delete` occurs once in the file, at `:4877`.
- Paths that skip release: `:5643-5661` prompt failures delete only `runningTasks`; remote workspace disconnection/remote host restart means terminal states never arrive; UI-side task deletion; CLI crash; `:4833` `writeContext` throws and skips dispose.
- Leaked objects: stream subscriptions plus the whole `handleStreamEvent` closure (full-turn `assistantParts`, `toolCalls` Maps, `streamingCardBlocks`). With them, the Telegram/Weixin typing `setInterval` (`:2727-2732`) sends a network request every 4s and never stops.

### SRV-H1 web server `remoteConnections` and RemoteConnection are never released

- `packages/server/src/http.ts:116, 336-355, 405-431`: `POST /api/connect-remote` starts SSH/Docker/WSL subprocesses then `set(id)`, and deletes only when `/ws/remote/:id` is consumed; no TTL. After consumption `socket.onClose` (`:109-112`) never calls `connection.dispose()` (`remote/connect.ts:295`), so remote server subprocesses, stdio ChannelClients, and stderr listeners accumulate per web remote session.

## II. Medium Risk

### Structural Root Cause A: services lack "recovery by connection ownership" ✔

`packages/rpc/src/ipc.ts:137-141` disconnect only calls `channelServer.dispose()`; nothing in services/desktop/server uses `onDidRemoveConnection`. All OS-level resources created through non-Event RPCs and stored by id in registries dangle after abnormal client disconnects:

- `terminal/terminalService.ts:325, 393-401`: `terminals` Map + node-pty shell subprocesses.
- `fileWatcher/fileWatcherService.ts:40, 108-115`: `watchers` Map + `FSWatcher` (`.git` recursive listeners) + debounce timers.

### Structural Root Cause B: services lack a "session terminal/close boundary" cleanup

Several per-session/per-task mirror states in `zcodeAgentService` / `zcodeTaskServiceAdapter` clear only on workspace client generation change or overall dispose; `closeSession`/`closeTask`/`deleteTask`/`session.removed` leave them:

- `zcode-agent/zcodeAgentService.ts:1385, 2119-2137` `sessionEventSequenceStates` (single-entry cap 10,000 ids, about 1~2MB per busy session).
- `:1388-1389` `pendingPermissions`/`pendingUserInputs` are written and never read (dead code that leaks, one entry per permission request).
- `:1333, 1879-1888, 2107-2117` `sessionEmitters` only grow, and `emitWorkspaceEvent` scans the whole table linearly; `pluginOperationProgressEmitters` in the same file already self-collects via `onDidRemoveLastListener` and can be copied.
- `:1398-1399` `runtimeModelConfigBySessionKey`, `:1444` `sessionTraceIdBySessionKey` (`listSessions` dumps the whole workspace history each time).
- `zcode-agent/zcodeTaskServiceAdapter.ts:263, 512-530, 553-575`: failed host commands stay in `runtimeCommands` forever (with content + base64 attachments) and keep tasks "always active".
- `:269, 994-1010, 4344-4353` `toolProjectionMemoryByTaskKey` holds complete tool inputs (whole Write/Edit files) and forgets them only when tool results arrive; `clearToolProjectionMemory` (`:1008`) is dead code.
- `:259-272` `taskEmitters`/`globalTaskEmitters`/`overlays`/`taskTargets`/`apiRetryByTaskKey`/`backgroundTaskControlsByTaskKey`/`legacySnapshotTaskKeys` are cleared only by disposeAll.
- `:267-268, 595-598` the adapter does not subscribe to runtime lifecycle; a CLI crash leaves `activePromptInputIds` residue, `drainRuntimeCommands` always returns early, and enqueued commands accumulate.

### Structural Root Cause C: Main→host lacks "local workspace close" messages

- `host/windowHostControllerService.ts:278-329`, `host/index.ts:1178-1210, 1370-1390, 2693-2696`, `hostRemoteWorkspaceProxyState.ts:38-70`: `removeSource/disconnectSource` are called only for remotes; local workspace sources (three sets of task meta + event subscriptions + sessions-index observers) and `taskMetaById` are never deleted.

### Remaining Medium Risk

| Location                                                                                   | Issue                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host/windowRemoteConnectionRegistry.ts:390-411`                                           | On remote unexpected disconnect, `handleConnectionClosed` does not call `disposeEntry`; the whole ServiceCollection/SSH backend is held until the user closes the tab                                                                                     |
| `host/index.ts:791-840, 552-578`, `host/cronRunLifecycle.ts:40-58`                         | Cron/off-peak terminal subscriptions are released only when `inputId === traceId`; session deletion, agent crash, and a concurrent prompt overwriting inputId never hit; manual runs also keep a 60s SQLite heartbeat interval                            |
| `main/browserView/browserPlaywrightLocatorExecutor.ts:1114-1155` etc.                      | Each CDP command's `Page.createIsolatedWorld` creates a new V8 context and fully re-injects the Playwright runtime; SPAs without navigation accumulate continuously (guest renderer memory)                                                               |
| `main/browserView/electronBrowserWebmRecorder.ts:286`                                      | Each screen recording uses `session.fromPartition(random name)`; Electron partitions have no destroy API                                                                                                                                                  |
| `main/cuaPermissionDragPanel.ts:128-183`, `desktopCuaPermissionIpc.ts:194-222`             | A `show()` after `destroy()` rebuilds a BrowserWindow + 150ms interval that nobody destroys                                                                                                                                                               |
| `main/appTelemetryRuntime.ts:34,85`                                                        | `rendererContexts` (by webContents.id) only grows                                                                                                                                                                                                         |
| `main/desktopHostProcess.ts:695-731`                                                       | On reload-respawn, the old host's exit callback registered under a shared key deletes the new host (correctness defect)                                                                                                                                   |
| `bots/botRemoteWorkspaceBridge.ts:56, 208-244, 268-276`                                    | `runtimeServicesByWorkspaceKey` is not invalidated on disconnect/reconnect, pending never settles, and dispose clears without resolving                                                                                                                   |
| `ui/v4/conversationProjectionStore.ts:696-704` + `shared/zcode-protocol-v4/apply.ts:78-83` | `rows.window` only grows live and never shrinks; each delta copies the full array + O(N) findIndex; `loadAllOlder` (`:1018-1150`) merges the whole history into the window on wide screens                                                                |
| `ui/store/zcodeSessionStore.ts` + `tabStore.ts:346`                                        | `workspaces[workspaceKey]` buckets have no deletion path; `remoteTimelineTaskStore`/`remotePinnedTaskStore` have `clearWorkspace` but no callers                                                                                                          |
| `ui/store/taskQueryCacheStore.ts:472`, `hooks/useWorkspaceTaskLists.ts:320-322`            | queryKey contains `limit::version`; each bump/explore adds new keys without deleting old ones                                                                                                                                                             |
| `ui/v4/windowControllerTaskListRegistry.ts:78, 218-228`                                    | `queryCache` caches whole results keyed by search term; each keystroke adds one                                                                                                                                                                           |
| `ui/feedback/feedbackSubmissionJob.ts:115, 410`                                            | Failed jobs are never deleted and hold screenshot base64 ×2                                                                                                                                                                                               |
| `ui/v4/telemetry/ConversationTelemetryAttachment.tsx:222-240`                              | `useMemo` acquires side effects internally; discarded renders have no matching release, so refCounts stay >0 and supervisors cannot release                                                                                                               |
| `ui/terminal/sidePaneTerminalSessionRegistry.ts:58`                                        | Permanent xterm instances without caps; PTY output in detached state still writes scrollback (by design, but consumes memory continuously)                                                                                                                |
| `rpc/src/channelServer.ts:224-248, 270-277`                                                | `pendingRequests` (with parameters) for unregistered channels are not deleted on timeout; remote hosts that do not register `cuaPermissionService` etc. add +1 per call                                                                                   |
| `rpc/src/channelClient.ts:151-178` + `proxy-channel.ts:131-132`                            | Event handlers are registered at creation; each Proxy access to `service.onXxx` creates new ones; also a correctness bug: "events not received after unsubscribe then re-subscribe"                                                                       |
| `rpc/src/ipc.ts:119-145`                                                                   | `IPCServer.disposables` only grows per connection (no production callers now, latent)                                                                                                                                                                     |
| `web/src/main.tsx:1865-1881, 2200-2232` + `client/src/websocket.ts:102-105`                | The web bridge switching ChannelClients has no dispose handle and in-flight RPCs never settle; the desktop side fixed similar issues (`messageport.ts:19-24` comments), web not synchronized                                                              |
| `rpc/src/remote.ts:294-321` + `persistent-protocol.ts:151-162, 274-285`                    | Reconnection does not close old sockets, can start several reconnection chains concurrently, and two intervals keep running after failure (no production callers now)                                                                                     |
| `shared/zcode-protocol-v4/wire-assembler.ts:146, 465-491`                                  | `settledByRoute` tombstones are uncapped and callers never `discard()`                                                                                                                                                                                    |
| `cli adapters/src/exec/node-execution-adapter-base.ts:32`                                  | `backgroundTasks` never deleted, each holding complete stdout (30K–150K characters) + AbortControllers                                                                                                                                                    |
| `cli core/src/runtime-task/registry.ts:97-137`                                             | Terminal-state subagents/Workflows keep complete `output` + `prompt`; `removeRuntimeBackgroundTask` returns undefined for `Agents`, so `local_agent` is never removed                                                                                     |
| `cli core/src/tool/executor/background-tasks.ts:311, 250-301`                              | Each background task has a 1s `setInterval` and emits retry forever on failure; `ToolExecutorImpl` has no dispose, so closing a session can pin the whole runtime                                                                                         |
| `cli core/src/tool/executor/impl.ts:57` + `handlers/read.ts:366` etc.                      | `readFileState` stores full text keyed by path+offset+limit and is cleared only during compaction                                                                                                                                                         |
| `cli bootstrap/src/zcode-protocol-v4/persistent-command-index.ts:41,97`                    | `sessions` is not cleaned on close/deactivation; the comment mentions an LRU that does not exist                                                                                                                                                          |
| `cli v4-gateway.ts:1955-1960`                                                              | `disposeSession` passes `clearCommandInbox: false`, so each closed session leaves 512 ack buckets                                                                                                                                                         |
| `cli server-operations.ts:1861` + `session-residency.ts:79`                                | The `legacyStreamSubscribed` bit is never cleared (no unsubscribe RPC) and the desktop still uses this path (`services/.../zcodeTaskServiceAdapter.ts:3306`), so the whole record can never deactivate; combined with CLI-H1 it becomes continuous growth |

## III. Low Risk (Summary)

- main: `closedTabIds` tombstones uncapped; `closeWindow()` bypassing `closeTab()` leaves download/scope tables; `sessionRoutes` sessions not deleted on close; `desktopRemoteSessions` `PendingConnect` without timeouts; `webRemoteControlManager.stopWindowRuntime` does not delete `availableTasksByWindowId`; `promptAttachmentTransferService` unsubscribed emitters persist; host→main pending requests without timeouts; `hostLogRelay.rawLogs` unbounded before the first structured log; `fetchRemoteAppConfig` has no timeout and size cap; `applicationIcons` caches nulls permanently.
- services: `ZCodeAgentProcessManager.ownedProcesses` retained forever on cleanup failure; `attachmentFlowRoutes` not deleted on commit/abort; syncer per-workspace state has no release entry; `workspaceProviderRegistryByKey` only grows; feedback `uploadOssForm` lacks error listeners and Promises never settle; feishu `typingReactionIds` is module-level and deleted only after DELETE succeeds, `userDisplayNameCache` not evicted; `bindCodes`/`recentRemoteReconnectAtByKey` not pruned; `cuaOperationTurnTracker.lastSeqBySession` not cleared on session close; `featureGates` accumulate by apiKey.
- ui: `useComposerAttachments` three Map refs have no unmount cleanup (in-flight uploads not aborted); `conversationProjectionStore.close()` does not clear listeners/snapshots; `optimisticCommands` other than sendText have no TTL; `useRemoteConnectionLogs` uncapped; `workspaceHomePathCache`/`statusCache` keys contain reconnection ids; `ToolLayout.toolLayoutOpenState` unbounded; `ConversationRowView` PDF preview blobs/Aborts lack unmount cleanup.
- cli: `sleep()` normal wake-ups do not remove abort listeners; protocol records `seqBySourceEventKey`/`streamedToolCallIdsWithInput` unbounded; `RawSequenceState.seenEventIds/appliedEventIds` unbounded; `waitForBackgroundTask` leaves continuations after aborts; `requestClient` replays about 360 pending keys per hour; MCP telemetry sampling failure records not released; `node-repl` closures pin first contexts.
- rpc/shared: `getChannel` filter listeners hang when nothing matches; `EventMultiplexer.disposables` not removed on connection disconnect; `CancellationTokenSource` only cancels and does not dispose.

## IV. Areas Confirmed Clean

- main: window-level Maps are uniformly deleted in `browser-window-created → closed`; per-host listeners expire with UtilityProcess lifetimes; BroadcastHub has TTL+caps; the other TaskRealtimeBus tables have timeouts/caps; telemetry family samples are capped; autoUpdater/OAuth/CUA/webRemoteControl transports are paired; preload's 36 `on*` all return cancel functions; no `setMaxListeners` or `fs.watch` in scope.
- services: `zcodeStdioTransport`/`zcodeProtocolClient` pending deleted on all paths; `zcodeAgentProcessManager` main tables clean; `zcodeAgentConnectionScope` has 1024 frames/32MiB dual caps; coalescers bounded; git/process/repo-snapshot/repo-wiki/telemetryCore/settings-sync/plugin-sync/model-provider all clean up in finally; `node.ts` disposeAll coverage complete.
- ui: `logger.ts` does not buffer; streaming text is string concatenation without chunk arrays; `removeTaskState` deletes all 7 sub-tables; timeline virtualization + 4000-entry LRU row-height cache; all Observers disconnect; createObjectURL is paired with revoke except PDF previews; streamdown caches 100 entries; `v4` registries keep-warm then dispose; `pendingCommandRegistry` has a 24h TTL.
- cli: `SessionResidentPool` four deletion paths complete (but eligibility is pinned by legacy subscriptions, see the medium-risk table); providers stream without leaving SSE chunks, abort listeners/linked controllers cleaned in finally; http `maxResponseBytes` + `reader.cancel`; telemetry `maxActiveCalls=1000`, OTLP queues 2000, trace writers 5000; MCP per-session leases close after 30s at zero; foreground Bash output bounded, `activeExecutions` cleaned in finally; subagent runner abort/watchdog disposes on all paths.
- rpc/server/shared: `ChannelClient`/`ChannelServer` main tables delete on four paths; Logging/NetworkTelemetry middlewares are stateless; `PersistentProtocol` replay has 8MiB/45s dual caps; server `hostCapability` has TTLs; `remote/connect.ts` dispose is complete; web remote control's 6 timers are paired and `pairedWaiters` deleted on all paths; renderer bootstrap all return cleanup.

## V. Design Issues Requiring Decisions (Confirm Before Fixing)

1. **CLI event store responsibilities**: should `ModelStreaming`/`ToolCallProgress` enter stores? If not, the live sink's `sequenceNumber` needs separate allocation (`events.ts:79-82` states seqs must come only from stores). Alternative: enter stores, discard transient events at `ModelComplete`/`ToolCallResult`, and make append an in-place push.
2. **Legacy `session/subscribe` pins permanent residence**: add a legacy unsubscribe RPC, or clear the mark when the consumer connection disconnects; otherwise `SessionResidentPool` is meaningless for sessions opened on desktop.
3. **Main→host local workspace close message**: `HostMessageTypes` needs a new message that clears controller sources, `workspaceProxyState`, and `workspaceTaskTracker`, with `forgetSessionState(sessionKey)` / `forgetTaskState(taskKey)` boundaries added to services.
4. **RPC recovery by connection**: whether services uniformly subscribe to `IPCServer.onDidRemoveConnection` to recover pty/fs.watch, or add idle timeouts to resources without subscribers.

## VI. Suggested Fix Order

1. One-line fixes that leak every time: MAIN-H1 (will-download), MAIN-H2 (streamBatches), UI-H1 (shiki LRU), UI-H2 (snapshots LRU).
2. bots `releaseTaskWatch` uniform release + typing interval caps (SVC-H1).
3. CLI-H2 parent→child publisher mapping; CLI M5/M6 so close/deactivation truly leaves no residue.
4. Design decisions 1 and 2 (CLI event store + legacy subscribe), the main root causes of continuous growth in long sessions.
5. One unified boundary for each of structural root causes A/B/C.
6. Remaining medium/low risks module by module.

## VII. Verification Suggestions

- Capture runtime evidence before fixing: renderers use DevTools heap snapshots comparing `TokenizedCode`/`ZCodeTaskSnapshot` instance counts; hosts/CLIs use periodic `process.memoryUsage()` sampling + `--heapsnapshot-signal`, comparing `SessionEvent`, `PendingStreamBatch`, and `streamSubscriptions` sizes.
- Reproduction: open/close windows 20 times and watch the main process `defaultSession.listenerCount("will-download")`; run one session for 30 streaming turns and watch the CLI RSS curve; for bots, disconnect remote workspaces and observe whether typing requests stop.

## VIII. 2026-09-04 Real-Machine Log Observations (After Diagnostic Logs Went Online)

- **Event store retention strategy verified**: the eviction amount at the start of the parent session's next turn matches the previous turn's transient count; subagent child sessions are cleared by the 2-minute time fallback in a single turn (7554 lines → 254 lines). Child session records are pooled and recycled after about 3~7 minutes.
- **`v4.detachedLive` increases by +1 per subagent run and does not fall back**: confirms CLI-H2; fix pending.
- **Host process RSS repeatedly peaks at 1.5GB (externalKb 1.3GB) and falls back after several minutes**: timestamps match repo snapshot (checkpoint) captures. Cause: `repoSnapshotFilter.ts` unconditionally allows `.git/` internal files (bypassing the 1MB per-file cap and all exclusion rules); this repository's `.git` is 1.2GB, so **every prompt send and every turn end** packages, sha256s, AES-encrypts, and tries to upload a 1.3GB `.tar.gz.enc`. This workspace has `failureCount=9`, and `~/.zcode/v2/checkpoints/*/pending` holds backlogs of 1.77GB (from 8/27), 1.26GB, and 0.66GB of un-uploaded artifacts; `~/.zcode/v2` totals 7.6GB. This is a product/spec-layer issue (`repo-snapshot-sidecar.md` requires complete Git metadata), not a leak. Decision needed: exclude `.git/objects/pack` or cap the total `.git` size, or skip capture when the workspace exceeds a threshold.
- **Remote control relay mutual-kick infinite loop**: two desktop instances connect to the relay with the same account, each reconnecting about 22 times per minute without backoff (the other instance made 6000+ reconnections that day). Corresponds to the audit item `webRemoteControlTransport` reconnection without backoff.
- **Renderer bursts of 10 `listTaskList` calls about every 25s** (1189 per round), corresponding to audit UI M6 (invalid version number amplification).
- **Main `taskBus.sessionRoutes` has 2565 entries** that only grow (about 250KB), corresponding to audit L4.
