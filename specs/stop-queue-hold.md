# Stop holds the following queue (ISSUE-010), Steer does not (ISSUE-039)

## Scope decision (ISSUE-039)

The queue hold is written only by a user `stop` command. Interrupting the running turn for a queued
item — Steer (`sendQueuedNow`, or `sendText` with `requestedDelivery: startNow` while busy) — writes
no `autoDrain=false` and projects no `pauseReason: "stopped"`; the remaining queue stays as it was
and the CLI bridge auto-drain continues it after the steered turn. A user Stop issued after a Steer
holds again.

Edit and retry (`editUserQuery`, `retryTurn`; `commands/handlers/fork-edit-retry.ts:181`) interrupt a
running turn via `preemptActiveTurnAndWait` without the preserve intent, so a cancel from edit or
retry holds the queue like a user Stop. Current behaviour, documented not changed.

Open (unconfirmed QA trigger, ledger ISSUE-039, build 54254f51): a real-model Steer on a queued item
showed the `v4-queue-paused-banner` with the queue still present 8 s later. The synthetic-fixture E2E
Steer cases do not reproduce it; the steer/stop/projection sources are byte-identical between
54254f51 and base f2e0adf1. The runtime-idle hold path (rule 12) is confirmed by a failing unit test
and fixed, but the native v4 send path does not reach it, so it may not be the trigger.

## Owners

- Renderer (`packages/ui/src/v4/SessionPane.tsx`): sends `sendQueuedNow { queueItemId }` (Steer) or
  `sendText { requestedDelivery: "startNow" }`. Keeps only the uncommitted draft and the pending
  optimistic overlay; never sends `stop` as part of Steer.
- Host (`packages/services/src/zcode-agent/zcodeAgentService.ts`): one owner per workspace runtime.
  The window-scoped Local Host (desktop-continuous) and the existing Host attachment
  (web-remote-replayable) forward the command over stdio unchanged. Host adds no hold.
- CLI admission (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`
  `admitCommandInput`, then `zcode-protocol-v4/commands/executor.ts` and `CommandInbox`): admits the
  command and owns auto drain (`autoDrainV4QueueIfReady`).
- The CLI `stop` handler (`commands/handlers/session-flow.ts`) owns the hold a stop writes and its
  release. Only `stop` calls `holdFollowingQueue` (`commands/input-admission.ts`, called at
  `session-flow.ts:310`; `pauseActiveGoal` also lives there). The v4 projection owns
  `queue.autoDrain`: the handler reads it through `V4CommandCoreHost.getQueueAutoDrain` and writes it
  only through `app.setQueueAutoDrain`. Resuming goes through the same ready hook as
  `setAutoDrain(true)` (`afterLegacyStateMutation(record, "queue_auto_drain_resumed")`), so an idle
  session promotes the queue head at once.
- Preemption intent: `preemptActiveTurnAndWait` (`session-flow.ts`, called by `sendQueuedNow` and
  `sendText` startNow) calls
  `runtime.stopActiveForegroundExecution({ preserveQueueAutoDrainOnCancel: true })`. The runtime
  stores the intent on the active foreground execution
  (`core/src/runtime/methods/runtime-command-queue.ts`), the turn catch copies it to
  `TurnComplete.preserveQueueAutoDrainOnCancel` (`core/src/runtime/methods/turn.ts`), and the
  projection skips the held derivation when it is set (`bootstrap/.../product-projection.ts`
  TurnComplete handling, and `onTargetVerification` for the goal verifier path).
- Second carrier (ISSUE-039 fix): when the runtime has no foreground token yet,
  `stopActiveForegroundExecution` returns `idle` and cannot store the intent.
  `preemptActiveTurnAndWait` then aborts the caller's controller with
  `createTurnCancelReason(message, { preserveQueueAutoDrainOnCancel: true })`
  (`core/src/runtime/helpers/turn-errors.ts`, exported from `@zcode/core`). The marker is
  non-enumerable, so it stays out of JSON and cause logs. The core turn catch (`turn.ts`) also
  honours `hasPreserveQueueAutoDrainCancelIntent(turnAbortSignal.reason)`; the reason reaches the
  turn through the parent abort chain. A user Stop aborts with a plain reason and never carries the
  marker.
- In-flight cancel (ISSUE-039 D1): `stop` treats any cancel already in flight (the target was aborted
  by a Steer, a goal pause, or a projection-fault termination, and has not torn down) as cancelling.
  It keeps its own hold and does not release it (`isStopCancelInFlight`,
  `commands/input-admission.ts`). The only target check is the pinned `stopTargetId`: core returns
  `idle` for an aborted active execution before the expected-id check, so `idle` alone does not prove
  the expected target is the aborted one.
- Queue projection owner: `ProductProjection.queue` (`autoDrain`, `pauseReason`). Only
  `QueueAutoDrainChanged` and a cancelled `TurnComplete` without the preserve intent change the hold.

## Event order

Steer vs Stop. Desktop-continuous and web-remote-replayable share the same CLI path; only the
transport differs. Both must show the same queue after a reconnect: the hold and the drain are
projection facts, not transport state.

```text
Steer (sendQueuedNow queueItemId=Q1)
  Renderer        optimistic overlay on Q1; no stop, no hold
  Host            services zcodeAgentService: forwards over stdio (no hold)
  CLI admission   v4-bridge admitCommandInput -> executor -> CommandInbox
  queue handler   reserve(Q1) -> acquire lease(after-current)
                  preemptActiveTurnAndWait
  Core runtime    stopActiveForegroundExecution({preserve:true})
                    runtime token present: abort T0 with the intent on the execution
                    runtime token absent (idle): abort the caller controller with the intent reason
                  turn catch -> TurnComplete(cancelled, preserve=true)
  projection      queue.autoDrain stays true, no pauseReason
  queue handler   waitForSessionIdle -> markPromoting(Q1) -> startPromptTurn(Q1, user_steer)
                  SessionInputPromoted(Q1) -> remove Q1 (commit)
  Core runtime    T1 (Q1) runs
  bridge          at T1 end, head Q2 with autoDrain=true
                  -> sendQueuedNow { autoDrainPromotion: true } (Q2, FIFO)

User Stop after Steer (during T1)
  CLI handler     stop(expectedForegroundExecutionId=T1)
                  holdFollowingQueue: setQueueAutoDrain(false)  (written and projected before abort)
  Core runtime    stopActiveForegroundExecution (no preserve) -> abort T1
  projection      TurnComplete(cancelled, no preserve) -> autoDrain=false, pauseReason=stopped
  bridge          head Q2 held -> no drain
```

Stop itself, including the compat path (ISSUE-010):

```text
stop(expectedForegroundExecutionId?)
  read activeExecutionId, legacy controller           (sync)
  willCancel && queue > 0 && projected autoDrain !== false ?
     └─ setQueueAutoDrain(false) → QueueAutoDrainChanged projected   (await; held = write succeeded)
  runtime.stopActiveForegroundExecution(expected ?? (held ? activeExecutionId : undefined))
     ├─ stopped  → abort controller → pause goal → done (queue held, pauseReason=stopped)
     └─ idle / mismatch (turn ended or was replaced during the hold write)
          └─ hold written by this stop ? setQueueAutoDrain(true) + ready hook
             → noop guard.stopTargetChanged
  compat path (no runtime token seen, held):
     controller replaced during the hold write → release + noop, no runtime stop
     controller cleared (turn ended on its own) → release, then pause goal as before
     otherwise (same controller, even if its runtime token registered meanwhile)
          → runtime stop without a pinned id, or pause goal → abort controller
```

Motivation (ISSUE-010): the turn-end auto-drain check reads the projection. If a stop aborted the
turn before writing `queue.autoDrain=false`, the check saw the old `autoDrain=true` and promoted the
queue head the user had just tried to stop.

## Product rules

1. A user-initiated stop that will cancel a turn while the queue is not empty writes
   `autoDrain=false` and waits for it to be projected before any abort. This is the only hold a user
   action writes.
2. A stop whose execution id is already stale (mismatch/idle with an expected id) writes no hold.
3. A stop never resumes a queue the user had already paused: if the projected `autoDrain` is already
   `false`, the stop neither holds nor releases.
4. The hold write yields. If the target turn ended or was replaced while the hold was being written,
   the stop cancels nothing, releases the hold it wrote, and returns the `guard.stopTargetChanged`
   noop. After a hold write, a stop without an expected id is pinned to the execution it observed
   before the hold, so it never aborts a turn that started during the hold write. A stop that wrote
   no hold keeps the earlier unpinned behavior (no await happened, so nothing could change).
5. The compat path (no runtime foreground execution token, for example compact or older clients)
   holds the queue too. If the bootstrap controller was replaced during the hold write, the stop
   releases the hold and noops without calling the runtime stop or aborting any controller. If the
   controller was cleared (the turn ended on its own), the stop releases the hold and still pauses an
   active goal, as the compat stop always did. A runtime token registered meanwhile under the same
   controller belongs to the same turn and is stopped.
6. After a stop that cancelled a turn, resuming is explicit (`setAutoDrain(true)`, the composer's
   resume action). A new Send while paused follows catalog B06 (confirm: clear the queue and send, or
   keep it paused and send). Choosing clear also releases the hold (rule 15); choosing keep keeps it.
7. A failed hold or release write is logged as a warning; the stop still proceeds. Only a hold this
   stop wrote successfully is ever released.
8. Residual risk: release writes `autoDrain=true` unconditionally. If an internal writer (a failing
   queued compact, which writes its own FIFO hold) wrote `false` during the same hold write and the
   stop then cancels nothing, the release undoes that hold. Accepted (decided 2026-10-22): the window
   is one hold write long and needs a queued compact to fail inside it; the worst case is that the
   queue drains as it would after a natural turn end. Closing it fully needs a hold owner or
   compare-and-set at the authority.
9. Steer (`sendQueuedNow`, and `sendText` with `requestedDelivery: startNow` while busy) preempts the
   running turn with the preserve intent (`preserveQueueAutoDrainOnCancel=true`). The intent travels
   on the runtime foreground execution when a token exists, and in the abort reason of the caller
   controller when it does not. The cancelled `TurnComplete` carries
   `preserveQueueAutoDrainOnCancel` and must not project a hold. The projection keeps `autoDrain`;
   the remaining queue is left in place and the CLI bridge auto-drain continues it FIFO.
10. A Steer never calls `holdFollowingQueue` or `setQueueAutoDrain(false)`, in either branch (runtime
    token or runtime idle with a caller controller). Covered by the CLI ISSUE-039 tests in
    `v4-native-queue.test.ts` (runtime idle and runtime token branches) and by the core tests
    `ISSUE-039 keeps queue auto-drain ...` and `ISSUE-039 holds the queue ...` in
    `runtime-tool-loop.test.ts`.
11. A user Stop after a Steer holds the queue again (rule 1). The hold belongs to the Stop, not to the
    earlier Steer, so a Steer does not suppress a later Stop. A user Stop with no runtime token
    aborts with a plain reason (no intent) and holds, as in rule 1.
12. Runtime-idle Steer (ISSUE-039 A-1, fixed for the Steer path): a Steer with no runtime token
    aborts the caller controller with the preserve intent (see rule 9). Known remaining holds, no
    behavior change:
    - Manual `/compact` and queued compact (`goal-compact.ts` ~171-179): a cancel with a non-empty
      queue calls `setQueueAutoDrain(false)` regardless of the intent. Core `compact.ts` ~149-152
      reads only the token flag. Steering a queued compact therefore holds.
    - Dream (`dream.ts` ~134-137) and the goal verifier (`target-completion-verification.ts`
      ~233-234) read only the token flag. They are not Steer-reachable from the desktop UI and are
      not changed.
    - Goal continuation (`goal-compact.ts` ~450-462 → `continueActiveTarget` →
      `continueActiveTargetLoop`): code read only, unverified by test. The loop runs as a runtime
      command whose foreground controller takes the caller signal as parent, so the reason should
      reach `turn.ts`. Not confirmed by a test. Reachability: the native v4 `sendText` path does not
      set `record.activeAbortController`; the caller-controller branch is reached by the legacy
      `session/send` path and by compact controllers. The E2E steer cases do not reach it; its
      regression guards are the unit and core tests.
13. Edit and retry (`editUserQuery`, `retryTurn`) call `preemptActiveTurnAndWait` without the intent
    (see Scope). A cancel from edit or retry holds the queue like a user Stop. Documented, not
    changed.
14. A user Stop always holds. If any cancel is already in flight on the target (a Steer, a goal
    pause, or a projection-fault termination has aborted it and the turn has not torn down yet), the
    Stop keeps its own hold in both branches: runtime token (`stopActiveForegroundExecution` returns
    `idle` while the pinned execution is still registered) and no token (the controller was aborted
    before the stop). The queue stays held after the steered item starts. The Stop does not release
    its hold in this window.
    - Stale expected id (ISSUE-039 D1 M1): an expected id that no longer matches the registered
      execution never counts as in flight, because `idle` can come from a different, already-aborted
      execution. Such a stop writes no hold to keep and returns the `guard.stopTargetChanged` noop,
      per rule 2 (CLI unit `ISSUE-039 D1：stale expected id ...`).
    - Teardown during the hold write (rule 4): if the pinned execution tears down before the stop's
      runtime call, the stop releases the hold it wrote and returns the `guard.stopTargetChanged`
      noop (CLI unit `ISSUE-039 D1：steer 已 abort 的执行在 hold 写入期间收口后 ...`).
    - Projection (characterization guard, not red-first): the Stop's hold lands before the Steer's
      cancelled TurnComplete, so the projection keeps `autoDrain=false` and reads
      `pauseReason: "manual"`. The UI shows the generic paused copy for `manual`
      (`ConversationQueuePanel.tsx`: only `stopped` and `error` have their own copy), so the user
      sees the same generic banner as after a plain pause.
15. Clear queue releases the hold (ISSUE-063, ZCO-52). The hold exists to keep the items that were
    queued at the Stop from running on their own. `heldQueueDisposition: clearQueueAndSend` (catalog
    B06 for `sendText`, B07 for a new `/goal`) discards those items, so the hold has nothing left to
    protect. After clearing the queue items and their in-memory queued executions,
    `applyHeldQueueDisposition` (`commands/input-admission.ts`) writes `autoDrain=true` through
    `app.setQueueAutoDrain(true)`, then calls `app.completeExternalQueueDrain()`, and only then
    starts the new input.
    - Order matters. Clear before the release, so no drain window opens while the old items still
      exist.
    - `setQueueAutoDrain(true)` flips core `queueExternalDrainActive` on (it expects the CLI to drain
      old projected items). The queue is already empty, so the release ends that drain at once with
      `completeExternalQueueDrain()`; otherwise the next turn would stop consuming Guide inputs
      inline. The release does not call the `queue_auto_drain_resumed` ready hook: there is nothing
      to promote, and the hook reads the queue head from the projection, which must not race the
      clear.
    - A failed release write is logged as a warning and the send proceeds (the queue is already
      cleared).
    - `keepQueueAndSend` writes nothing to `autoDrain`: the queue stays held until Continue.
    - Not covered (hypothesis, unverified): emptying a held queue another way (deleting or editing
      the last held item, or Steering it) may leave the same empty hold. Tracked as a follow-up.

Invariants:

- Only the `stop` handler writes `autoDrain=false` from a user action. A Steer writes nothing to
  `autoDrain`; its interruption relies on `preserve=true` for the projection.
- Stale-run protection and owner/lease checks are unchanged: `expectedForegroundExecutionId`, the
  promotion lease and the reservation guard every step (existing tests, ISSUE-010 cases).
- Not covered by tests: a Stop that arrives while a Steer sits between `reserve` and `startPromptTurn`.

## Hold flag owners and event order (ISSUE-063)

```text
                  Renderer (SessionPane)        Host (zcodeAgentService)   CLI v4 handlers + projection          Core runtime
Stop (queue=[A])  stop ─────────────────────────> forward (stdio) ───────> holdFollowingQueue
                                                                            setQueueAutoDrain(false) ──────────> queueAutoDrain=false
                                                                            projection: autoDrain=false
                                                                            TurnComplete(cancelled): pauseReason=stopped
Send while held   B06 dialog: "Clear queue"
                  sendText{clearQueueAndSend,
                           expectedHeldQueueItemIds=[A]} ─> forward ─────> applyHeldQueueDisposition
                                                                            clearQueueItems ───────────────────> queue=[]
                                                                            clearQueuedTurnExecutions
                                                                            setQueueAutoDrain(true) ──────────> queueAutoDrain=true
                                                                            projection: autoDrain=true,          (externalDrain on)
                                                                                        pauseReason removed
                                                                            completeExternalQueueDrain ────────> externalDrain off
                                                                            startPromptTurn(new input) ────────> T1 runs
Queue during T1   sendText (busy) ──────────────> forward ─────────────────> enqueue B (routing=queue, no banner)
T1 ends                                                                     bridge autoDrainV4QueueIfReady:
                                                                            head B, autoDrain=true ─> sendQueuedNow(B) ─> T2 runs B
```

The renderer only keeps the draft and the optimistic overlay; the CLI owns the queue, the hold bit
(projection `queue.autoDrain` plus the core drain gate, both written by the one `setQueueAutoDrain`
call) and the drain. Desktop (`desktop-continuous`) and mobile/web (`web-remote-replayable`) see the
same projected `autoDrain`/`pauseReason` after a reconnect, because both are projection facts.

## Acceptance scenarios

Unit tests: `apps/zcode-cli/packages/bootstrap/tests/v4-native-commands.test.ts` (ISSUE-010 cases).
E2E: `conversation-session-v4-stop-queue` B02–B04 and B02a (`docs/conversation-session-case-catalog.md`).

1. Running turn, queue=2, stop with the current id: the projected `autoDrain` is `false` when the
   abort runs; the queue stays and does not drain.
2. Compat stop without a runtime token and queue=1: the hold is projected before the controller
   aborts.
3. Stop with a stale id: no hold is written; noop.
4. The turn ends during the hold write: `setQueueAutoDrain` is called with `false` then `true`, the
   ready hook runs with `queue_auto_drain_resumed`, nothing is aborted, noop.
5. Stop without an id, turn ends during the hold write: the runtime stop is called with the id
   observed before the hold; same release and noop.
6. Queue already paused by the user: the stop proceeds without any `setQueueAutoDrain` call.
7. Compat stop whose controller is replaced during the hold write: neither controller is aborted; the
   hold is released; noop.
8. Compat stop whose turn registers its runtime token during the hold write (same controller): that
   turn is stopped; the hold stays.
9. Compat stop whose turn ends during the hold write: the hold is released and an active goal is
   paused.
10. A failed hold write is never released.
11. A stop without an id that writes no hold calls the runtime stop unpinned and keeps the compat
    fallthrough.
12. ISSUE-039 Steer with queue=2 on a running turn (runtime token branch): no `setQueueAutoDrain(false)`
    (CLI unit `ISSUE-039：steer 抢占运行中 turn（runtime 有 token）不写 stop hold`); projection keeps
    `autoDrain` (projection unit `ISSUE-039：steer 的 cancelled TurnComplete 不 hold 投影`); E2E
    `STEER：` and `STEER 第二项：`. The E2E `STEER：` case asserts no paused banner at the moment the
    steered item's reply appears.
13. ISSUE-039 Steer then user Stop on the steered turn: the hold is written before the abort, the
    queue stays queued and is not consumed (CLI unit `ISSUE-039：steer 之后的用户 Stop 仍写 hold`;
    projection unit; E2E `STEER 后用户 Stop：`).
14. ISSUE-039 runtime-idle branch (no runtime token, caller controller present): a Steer aborts the
    controller with the preserve intent reason and writes no hold; a user Stop aborts with a plain
    reason and holds (CLI unit `ISSUE-039：runtime 尚无前台 token 时 steer ...` and `... 用户 Stop ...`;
    core unit `ISSUE-039 keeps queue auto-drain when a caller abort carries the steer preserve
    intent` and `ISSUE-039 holds the queue when a caller abort is a plain user Stop reason`).
    Runtime-idle is not reachable from the E2E steer path (see rule 12).
15. ISSUE-039 Steer immediately after the turn enters running (no streamed output yet): the queue
    still drains in order (E2E `STEER 刚进入 running：`).
16. ISSUE-039 D1 (rule 14): a Stop that lands after a Steer aborted the target and before teardown
    keeps its hold, in the runtime-token branch and in the no-token branch (CLI unit
    `ISSUE-039 D1：...`). A stale expected id writes no hold to keep (CLI unit `ISSUE-039 D1：stale
    expected id ...`). A Stop whose pinned target tears down during the hold write releases (CLI unit
    `ISSUE-039 D1：steer 已 abort ...`). A Steer alone still drains (rule 10).
17. ISSUE-039 N2: the preserve marker on the cancel reason is non-enumerable (core unit `turn cancel
    reason intent` in `core/tests/turn-errors.test.ts`).
18. E2E `STEER：`: the queue reaches [Q2] (Q1 promoted) with no paused banner, and the steered reply
    has no banner.
19. ISSUE-063: held queue, `sendText` with `clearQueueAndSend`: the call order is clear queue,
    `setQueueAutoDrain(true)`, `completeExternalQueueDrain`, then start the turn (CLI unit
    `ISSUE-063 ...` in `v4-native-commands.test.ts`). The same holds for a new `/goal` with
    `clearQueueAndSend` (B07). `keepQueueAndSend` makes no `setQueueAutoDrain` call.
