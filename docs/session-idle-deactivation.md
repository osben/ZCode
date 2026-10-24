# CLI session hybrid residency pool

Status: **confirmed, implemented per this spec**

## Problem

Each workspace runtime maps to one resident `zcode-cli app-server --stdio` process. Every loaded session in the process holds a full `ZCodeApp`, in-memory event store, MCP/runtime wiring, and V4 publisher. Normal task switching, pane closing, or workspace switching does not delete persistent sessions, so the more sessions a CLI process has browsed, the larger its resident memory.

This feature governs only **the idle lifecycle and burst count of loaded sessions within a single CLI process**. It is not a cross-workspace global pool and sets no RSS hard cap.

## Product contract

1. Each CLI applies a `10 minute` idle TTL to idle sessions meeting the safety conditions; on expiry the session is reclaimed regardless of the current resident count.
2. Each CLI also uses count hysteresis `highWater = 16`, `lowWater = 8`: above the high water mark, reclaim safely cold-resumable sessions by LRU without waiting for the TTL, down to the low water mark or until no candidates remain.
3. Sessions that are running, queued, waiting on interaction, subscribed, or with an in-flight protocol operation are never reclaimed. "Running" covers not just foreground turns and the background task registry, but also runtime-owned detached sidecars and the persistence, snapshot, and broadcast finalization still pending after the protocol layer releases the active lock. If such sessions alone exceed the high water mark, the resident count may stay over.
4. The idle TTL starts when all protection facts disappear; a new session operation or protection fact resets the timer. After long background work completes, timing must restart when the completion-notification drain ends, not reuse the pre-work timestamp.
5. After reclamation, the session's memory state is exactly "CLI just started, this session never loaded": no record in `context.sessions`; the persistent session and task index remain.
6. Later subscribes/reads recover via the existing cold resume; no second recovery path is added.
7. Reclamation is an internal lifecycle: no `session.removed` is sent and no "reclaimed" business notification goes to the renderer.

The high/low water marks are therefore a **safety-first burst valve**, not a hard limit that aborts tasks or rejects concurrency. They do not conflict with `crossSessionUnlimitedConcurrency`; the TTL guarantees that a few long-unused resident runtimes are eventually released too.

## State and ordering

```text
                        任一保护事实存在
                    ┌──────────────────────────┐
                    │ ACTIVE_PROTECTED         │
                    │ · runtime owned work     │
                    │   · active/queued        │
                    │   · task registry        │
                    │   · detached sidecar     │
                    │ · protocol finalization  │
                    │ · pending interaction    │
                    │ · subscriber             │
                    │ · protocol operation     │
                    │ · deferred draft         │
                    └────────────┬─────────────┘
                                 │ 保护事实全部消失
                                 v
                    ┌──────────────────────────┐
                    │ IDLE_WARM                 │
                    │ 记录 eligibleSinceAt      │
                    └───────┬──────────┬───────┘
                            │          │
                 idle>=10min│          │resident>16
                            │          │按 LRU 回收到 8
                            └────┬─────┘
                                 v
                    ┌──────────────────────────┐
                    │ DEACTIVATING             │
                    │ 同步二次校验并摘除 record │
                    │ 异步等待 app.close        │
                    └────────────┬─────────────┘
                                 v
                    ┌──────────────────────────┐
                    │ DEACTIVATED              │
                    │ 内存无 record，磁盘仍在   │
                    └────────────┬─────────────┘
                                 ├─ V4 subscribe/rows-range → cold READY flight
                                 └─ legacy resume           → legacy activation/snapshot
```

Concurrent sessions may exceed the target:

```text
highWater = 16
lowWater = 8

18 个 session 都在运行/订阅中
  -> resident = 18
  -> 可回收 = 0
  -> 不终止任何任务，暂时保持 18

其中 12 个变为空闲
  -> 已超过 highWater，按 LRU 回收 10 个
  -> resident = 8

11 个最近使用且已退订的 session
  -> resident 未超过 highWater
  -> 10 分钟内继续保持热状态
  -> 各自 TTL 到期后回收，即使 resident 已少于 8
```

## Lifecycle and release matrix

"Lifecycle" here describes only whether a session stays resident **in the current CLI process**; disk session, task index, pin/archive/unread and other product states do not change. The pool only reclaims from `IDLE_WARM`; other states either still have an owner or are already out of memory.

| Lifecycle | Entry condition | Pool-releasable | Behavior of new requests |
| --- | --- | --- | --- |
| `DEACTIVATED` | no record in this CLI's `context.sessions` | already released | existing cold resume rebuilds app/runtime and restores persistent history |
| `COLD_RESUMING` | subscribe/query/resume creating or restoring the record | no | reuse/wait for the same recovery; an operation lease protects the whole async window |
| `ACTIVE_PROTECTED` | any protection owner below exists | no | keep running/queued/subscribed per the original protocol |
| `IDLE_WARM` | record persisted and all protection owners released | candidate | requests reuse the warm record directly and clear `eligibleSinceAt` |
| `DEACTIVATING` | fresh re-check passed, record synchronously removed, `app.close()` unfinished | releasing, not repeatable | wait for close to settle, then cold resume; never hits a half-dismantled record |

`ACTIVE_PROTECTED` is not a single boolean but the union of these owners:

| owner / sub-lifecycle | Typical source | Releasable | Exact boundary of protection lift |
| --- | --- | --- | --- |
| foreground/background turn | prompt, model stream, tool await, compact, goal continuation | no | the runner's runtime work completes |
| runtime command | queued prompt, terminal notification, command drain | no | queue empty and drain complete |
| background task | background Bash, subagent, Workflow, MCP monitor | no | task registry no longer running and its completion notification drained |
| detached sidecar | session/goal title, MCP startup, notification ledger, goal heartbeat | no | the tracker-wrapped Promise releases in `finally` together with fallback writes |
| memory work | project-memory extraction, recall prefetch | no | scheduler has no pending/running, prefetch settled |
| protocol finalization | command fact, ensure-model, snapshot, broadcast finalization | no | `residencyFinalizationCount` reaches zero |
| pending interaction | permission, elicitation, AskUserQuestion | no | interaction answered, cancelled, or closed |
| gateway command | V4 command queue, in-flight/live inbox pin | no | command completes and pin released |
| conversation subscriber | desktop continuous, mobile replayable online subscription | no | unsubscribe completes |
| legacy subscriber | old `session/subscribe` replayable/bot stream | no | the old protocol has no unsubscribe; conservatively protected until CLI exit |
| protocol operation | subscribe hydration, rows query, resume, config read/write | no | the request dispatch's operation lease releases |
| deferred draft | session record not yet immediately persisted | no | becomes immediate persistence; otherwise cold-resume equivalence cannot be guaranteed |

The test is therefore not "is this feature called a background task" but "is there any async owner that will still read or modify the current record/runtime":

```text
存在任一 owner
  -> ACTIVE_PROTECTED
  -> 即使 resident > 16 也不能回收

所有 owner 已释放 + session 可从磁盘恢复
  -> IDLE_WARM
  -> idle TTL 到期，或 resident > 16 时按 LRU，才允许回收
```

### User operations and feature scenarios

| Scenario | Releasable | Boundary |
| --- | --- | --- |
| foreground prompt / model streaming / tool execution | no | active turn or runtime work holds an owner |
| background Bash / subagent / Workflow | not while running | do not look at the foreground turn alone; idle only after task terminal and completion-notification drain |
| goal long task / verifier / continuation | not while running or finalizing | active/runtime and finalization cover continuously; releasable when paused/completed with no continuation |
| compact / memory extraction / recall prefetch | not while pending, running, or finalizing | releasable once all settled; never reuse the pre-work idle timestamp |
| browser use | not during turn/tool await or cleanup | a merely idle browser connection is not a permanent owner; it closes with app/runtime on session reclamation |
| MCP | not during startup or running monitor | releasable when the server is connected but idle; cold resume re-establishes connections |
| permission / AskUserQuestion | no | reclamation would lose interaction state that exists only in memory |
| queued prompt / command inbox pin | no | work awaiting execution even before any model call |
| automation / scheduled / off-peak tasks | not during a triggered run; yes with only future definitions | a trigger must enter the prompt runner's unified owner chain; persistent future schedules must not pin a session forever |
| renderer visible pane / mobile online subscription | no | subscriber is a protection owner |
| renderer pane closed and keep-warm/unsubscribe done | yes | renderer projection released first, then the CLI starts its own idle TTL |
| SSH / WSL / Docker session | same rules as local | the decision runs in the remote CLI actually hosting the session; connection type or workspace type adds no special case |
| completed historical background tasks | yes | task index / persistent history remain, but terminal history itself holds no runtime owner |

Every "yes" still requires all authoritative protection facts below plus a synchronous re-check before actually removing the record. Any new request, subscription, or owner moves `IDLE_WARM` back to `ACTIVE_PROTECTED` and resets the idle TTL.

## Authoritative protection facts

A session is reclaimable only when **all** of these hold:

| Condition | Authority | Reason |
| --- | --- | --- |
| persisted | `record.persistence === "immediate"` | a deferred draft cannot cold-resume after reclamation |
| runtime has no owned work | `AgentRuntime.hasResidencyBlockingWork()` | aggregates active/queued turns, task registry, detached sidecars, and unfinished memory work |
| no protocol finalization work | `record.residencyFinalizationCount === 0` | the active lock must release before ready, but persistence/snapshot/broadcast still need the original record/runtime until done |
| no pending interaction | `V4InteractionRegistry` | permission / AskUserQuestion live only in this process's memory |
| V4 command queue / inbox pin empty | `ConversationV4Gateway` | gateway queue and in-flight/live commands are this process's runtime state |
| conversation has no subscribers | `ConversationTopicPublisher` | both desktop continuous and mobile replayable online consumers are protected |
| no legacy stream subscription | `record.legacyStreamSubscribed` | old replayable/bot streams have no unsubscribe RPC; conservatively kept alive until CLI exit |
| no in-flight protocol request | `SessionResidentPool` operation lease | await windows of subscribe hydration, rows query, resume, config writes must not be reclaimed |

`record.activeAbortController` is not the complete runtime-busy fact and must not be used alone for reclamation. `record.deliveryKind` is not a legacy subscription lease either: read paths like `session/read` write it. The compatibility layer writes `legacyStreamSubscribed` only on a real `session/subscribe`, so ordinary reads are not permanently exempt; since the old protocol has no unsubscribe, a marked stream protects and may keep resident above target temporarily.

The runtime's authoritative query must cover all its async work that touches session/runtime state:

```text
AgentRuntime.hasResidencyBlockingWork()
  = active turn / turn-start reservation
  || runtime command queue / drain
  || task registry 中 running background Bash / Agent / Workflow / MCP monitor
  || detached session title / goal title 生成与 fallback 持久化
  || MCP startup
  || detached background-notification ledger write / goal heartbeat
  || project-memory extraction schedule / drain
  || 尚未 settled 的 project-memory recall prefetch
```

Detached sidecars register a count at synchronous start and release it in the Promise's `finally` — never by scanning Promises afterwards, and never protecting only the real model call while missing fallback writes. Success, failure, or abort all balance the count.

The protocol's ready boundary needs an independent finalization lease:

```text
background prompt / compact / goal continuation
  -> acquire record finalization lease
  -> 执行模型/runtime work（activeAbortController 同时存在）
  -> clear activeAbortController       # 允许下一条输入通过 admission
  -> 持久 command fact / ensure model / snapshot / broadcast
  -> release record finalization lease
  -> 才可能进入 IDLE_WARM
```

The finalization lease cannot be replaced by delayed release of `activeAbortController`, or queued input would misjudge the old turn as active at the ready boundary. Legacy and V4 background paths must share the same counting protocol.

Scenario mapping follows the same owner rules with no per-scenario pool special cases:

- automation, scheduled, and off-peak tasks all end up in the prompt runner; the run is protected by active/runtime facts and the ready finalization by the protocol finalization lease;
- background Bash, subagent, Workflow, MCP monitor use the task registry as authority; after terminal notification enters the runtime queue, queue/drain and detached ledger writes keep protecting;
- browser use is active work during turn/tool await, and turn/session browser cleanup stays inside the runner Promise; a user keeping one idle browser session is not "a task still running" — normal cold reclamation and closing is allowed;
- an MCP server connection is not a permanent pin; only startup or a still-running MCP monitor in the registry blocks reclamation; ready-and-idle allows cold restart rebuild;
- goal verifier/continuation and long compactions use active/runtime facts, then the finalization lease after the ready lock releases;
- SSH/WSL/Docker execute the same decision inside the actual remote CLI; workspace identity and cold-resume boundaries are unchanged.

Protocol requests use a process-level operation lease and also record the hit sessionId:

```text
request admitted
  -> acquire operation lease
  -> 若该 session 正在 DEACTIVATING，等待 close 完成
  -> dispatch / hydrate / mutate / query
  -> release lease + touch LRU
  -> rebalance
```

The process-level lease means: no reclamation starts inside any protocol request's async execution slice. This also covers workspace config sync that iterates multiple sessions, avoiding a global-operation race when only explicit `{sessionId}` requests are locked. Running async tasks stay protected by the runtime/background authority facts.

## TTL, LRU, and triggers

- `eligibleSinceAt` is established only after all protection facts disappear; deleted on re-touch or re-protection.
- TTL-expired candidates ignore the current resident count but must re-read safety facts before executing.
- High-water reclamation sorts LRU by `lastUsedAt = max(record.updatedAt, pool.lastTouchedAt)`.
- One rebalance first reclaims TTL-expired items, then checks the remaining resident count against highWater; if over, reclaims down to lowWater or until no candidates.
- Every protocol request end triggers one rebalance, so create/resume/unsubscribe promptly updates timers or converges.
- The existing process resource sampler (every 60 s) is the backstop; no per-session timer is added — so the 10-minute TTL's actual reclaim window is roughly 10–11 minutes after becoming eligible.
- Default parameters are code constants; tests inject smaller values and a clock. No new env vars or user settings this cycle, and RSS is not read for reclamation decisions.
- The server assembly compatibility field `sessionResidentTargetCount` overrides only the low water; without an explicit `highWaterCount` the default high water still applies — the legacy low-water must not be written into both ends and collapse the hysteresis window. If only `targetCount` is overridden and it exceeds the default high water, the assembly layer must resolve an effective high-water at least the target so the Agent CLI does not throw at construction on default combinations; explicitly invalid high/target combinations are still rejected by pool validation.

## Reclamation execution surface

Reclamation and explicit close/delete both release the runtime but differ in product semantics:

```text
resident eviction
  -> gateway.assertSessionRuntimeDeactivatable() # 纯校验；失败时不得产生副作用
  -> record.unsubscribe()
  -> gateway.deactivateSession()   # 清 publisher/cache/inbox，不发 session.removed
  -> context.sessions.delete()
  -> await app.close()

explicit close/delete
  -> gateway.disposeSession()      # 保持既有 removal 语义
```

The pure safety check must come before the first side effect; on rejection, the record, runtime event subscription, and gateway runtime state all stay usable. After the check passes, `unsubscribe`, gateway cleanup, and `sessions.delete` complete in one synchronous execution slice. A new request either acquires the operation lease first and blocks reclamation, or sees DEACTIVATING and waits, then cold-resumes — it never hits a half-dismantled record. `app.close()` is post-removal async finalization; its failures are isolated and logged by the pool and are not part of a rollback-able synchronous precheck transaction.

## Renderer memory boundary

The renderer mirrors no CLI residency pool and receives no reclamation notification. It already has its own projection-cache lifecycle:

```text
pane 关闭/切走
  -> release SessionDataLayer pane lease
  -> keep-warm 30s
  -> unsubscribe conversation
  -> ConversationProjectionStore.close()
  -> 从 SessionDataLayer 删除该 topic store
  -> CLI 观察到 subscriber=0
  -> 进入 CLI 10 分钟 idle TTL；突发超过 highWater 时也可参与 LRU
```

If the renderer still holds a heavy projection needing live updates, it still has a subscription and the CLI will not reclaim; if the CLI can reclaim, the renderer's heavy projection has already been released by its own lifecycle. An extra "CLI reclaimed" notification would leak internal cache policy into the UI and could race a stale notification against a fresh resubscription, so it is forbidden as a business protocol.

Task-list membership, pin/archive/unread, workspace identity, and other shell state stay in the task sqlite index and lightweight renderer state; reclamation must not delete them.

## Multi-client and remote boundaries

- Desktop keeps `desktop-continuous`. A visible pane's subscription protects the session.
- Mobile/Web remote keeps `web-remote-replayable`. A live V4 subscription protects the session; after release, reclamation requires eligibility. Replayable/bot streams still on the old `session/subscribe` are conservatively protected until CLI exit because the protocol has no unsubscribe. Both compatibility paths change no existing snapshot/gap/cold-resume.
- Mobile still attaches to the desktop window's existing shared host; no new runtime.
- The pool lives in the CLI process actually running sessions. For SSH/WSL/Docker workspaces the pool is in the corresponding remote CLI — never in the relay, desktop main, or host.
- This feature manages lifecycle by sessionId and adds no workspace key; identity isolation keeps `workspaceIdentity?.trim() || workspacePath`.

## Acceptance

Focused tests must prove:

1. First eligibility only starts the TTL; on expiry the session is reclaimed even below lowWater.
2. Touch or reappearing protection facts reset the TTL; after background work completes, the new idle window starts.
3. Equal to highWater does not reclaim; above it, LRU-reclaim down to lowWater.
4. All-protected sessions may exceed highWater.
5. active/queued runtime, background Bash/Agent/Workflow, detached title/MCP/memory sidecar, protocol finalization, pending interaction, gateway queue, subscriber, legacy stream, operation lease, and deferred draft each independently block reclamation.
6. A TTL and high-water hit in the same round does not double-close; changed candidate facts skip before execution.
7. Reclamation produces no `session.removed`.
8. Re-subscribing after reclamation creates a new app and restores real history rows, not just a snapshot shell.
9. While `app.close()` is unfinished, new requests for the session wait and then cold-resume.
10. Desktop continuous and mobile replayable share no recovery state; remote identity semantics unchanged.
11. The renderer's existing last-pane lease tests keep proving store close, unsubscribe, and cache deletion.
12. Deactivation clears the session's `CommandInbox` settled LRU/admission sequence; in-flight/live pins block reclamation until released.
13. Legacy and V4 background prompt/compact/goal continuation remain unreclaimable between active-lock release and final state-mutation completion.

No conversation GUI E2E is added this cycle. Capacity, races, and cold resume are covered by CLI/core focused tests; renderer memory lifecycle reuses the existing `v4SessionDataLayer` tests.
