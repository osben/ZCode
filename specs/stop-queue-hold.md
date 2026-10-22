# Stop holds the following queue (ISSUE-010), Steer does not (ISSUE-039)

## Scope decision (ISSUE-039, user decision: option b)

The queue hold is written by a user `stop` command. Interrupting the running turn for a queued item
(Steer: `sendQueuedNow`, and `sendText` with `requestedDelivery: startNow` while busy) does not write
`autoDrain=false` and does not project `pauseReason: "stopped"`; the remaining queue stays as it was and the
CLI bridge auto-drain continues it after the steered turn. A user Stop issued after a Steer holds again, as before.

Edit and retry (`editUserQuery`, `retryTurn`; `commands/handlers/fork-edit-retry.ts:181`) also interrupt a running
turn and call `preemptActiveTurnAndWait` without the preserve intent. A cancel from edit or retry therefore holds
the queue like a user Stop. This is the current behaviour and is kept; it is documented here, not changed.

ISSUE-010 wrote the hold for a stop that will cancel a turn while the queue is not empty. The queue doc
(`docs/ui/chat-message-queue.md`) also described Steer as going through the stop barrier. This spec separates
the two: only the `stop` command holds.

Repro record (ledger ISSUE-039, `docs/qa/issue-ledger.md` on `claude/qa-run-20261022`, build 54254f51): a long
real-model run ("Count from 1 to 800 ... Do not use tools"), queue A and B, press Steer on A. Observed: the
banner `v4-queue-paused-banner` present right after Steer while A runs; queue `[B]` still present 8 s later.
Status on this branch (base f2e0adf1): the synthetic-fixture E2E Steer cases do not reproduce it, and the
steer/stop/projection source files are byte-identical between 54254f51 and f2e0adf1. The QA trigger is still
unconfirmed. The runtime-idle hold path (rule 12) is confirmed by a failing unit test and is fixed, but the native
v4 send path does not reach it, so it may not be the QA trigger.

## Owners (the hold decision and where it is made)

- Renderer (`packages/ui/src/v4/SessionPane.tsx`): sends `sendQueuedNow { queueItemId }` (Steer button) or
  `sendText { requestedDelivery: "startNow" }`. It keeps only the uncommitted draft and the pending optimistic
  overlay. It never sends `stop` as part of Steer.
- Host (`packages/services/src/zcode-agent/zcodeAgentService.ts`): one owner per workspace runtime. The window-scoped
  Local Host (desktop-continuous) and the existing Host attachment (web-remote-replayable) both forward the command
  over stdio to the workspace CLI unchanged. Host adds no hold.
- CLI admission (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` `admitCommandInput`, then
  `zcode-protocol-v4/commands/executor.ts` and `CommandInbox`): admits the command and owns auto drain
  (`autoDrainV4QueueIfReady`).
- Decision points (CLI handlers): `commands/handlers/queue.ts` `sendQueuedNow` (Steer) and
  `commands/handlers/session-flow.ts` `stop` (Stop). Only `stop` calls `holdFollowingQueue`
  (`commands/input-admission.ts`, called at `session-flow.ts:310`).
- Preemption intent: `preemptActiveTurnAndWait` (`session-flow.ts`, called by `sendQueuedNow` and by `sendText`
  startNow) calls `runtime.stopActiveForegroundExecution({ preserveQueueAutoDrainOnCancel: true })`. The runtime
  stores the intent on the active foreground execution (`core/src/runtime/methods/runtime-command-queue.ts`), the
  turn catch copies it to `TurnComplete.preserveQueueAutoDrainOnCancel` (`core/src/runtime/methods/turn.ts`), and
  the projection skips the held derivation when it is set (`bootstrap/.../product-projection.ts` TurnComplete
  handling, and `onTargetVerification` for the goal verifier path).
- Second carrier (ISSUE-039 fix): when the runtime has no foreground token yet, `stopActiveForegroundExecution`
  returns `idle` and cannot store the intent. `preemptActiveTurnAndWait` then aborts the caller's controller with
  `createPreserveQueueAutoDrainCancelReason(...)` (`core/src/runtime/helpers/turn-errors.ts`, exported from
  `@zcode/core`). The core turn catch (`turn.ts`) also honours `hasPreserveQueueAutoDrainCancelIntent(turnAbortSignal.reason)`.
  The reason reaches the turn through the parent abort chain. A user Stop aborts with a plain reason and never carries
  the marker.
- Queue projection owner: `ProductProjection.queue` (`autoDrain`, `pauseReason`). Only `QueueAutoDrainChanged`
  and a cancelled `TurnComplete` without the preserve intent change the hold.

## Event order (ISSUE-039: Steer vs Stop)

Desktop-continuous (the Desktop real-time link) and web-remote-replayable (the mobile/web recovery link) share the
same CLI path; only the transport differs. Both must show the same queue after a reconnect, because the hold and
the drain are projection facts, not transport state.

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

Invariants:

- Only the `stop` handler writes `autoDrain=false` from a user action. A Steer writes nothing to `autoDrain`; its
  interruption relies on `preserve=true` for the projection.
- Stale-run protection and owner/lease checks are unchanged: `expectedForegroundExecutionId`, the promotion lease
  and the reservation still guard every step (existing tests, ISSUE-010 cases).
- Not covered by tests: a Stop that arrives while a Steer sits between `reserve` and `startPromptTurn`.

## Problem

Stopping a running turn with queued input could let the queue drain on its own. The turn-end auto-drain check reads the projection, and the stop wrote `queue.autoDrain=false` only after aborting. When the abort finished the turn first, the check saw the old `autoDrain=true` and promoted the queue head the user had just tried to stop before.

## Owner

- The CLI `stop` handler (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts`) owns the hold a stop writes and its release.
- The v4 projection owns `queue.autoDrain`. The handler reads it through `V4CommandCoreHost.getQueueAutoDrain` and writes it only through `app.setQueueAutoDrain`.
- Resuming goes through the same ready hook as `setAutoDrain(true)` (`afterLegacyStateMutation(record, "queue_auto_drain_resumed")`), so an idle session promotes the queue head at once.

## Stop event order (ISSUE-010, compat and runtime-token paths)

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

## Product rules

1. A user-initiated stop that will cancel a turn while the queue is not empty writes `autoDrain=false` and waits for it to be projected before any abort. This is the only hold a user action writes.
2. A stop whose execution id is already stale (mismatch/idle with an expected id) writes no hold.
3. A stop never resumes a queue the user had already paused: if the projected `autoDrain` is already `false`, the stop neither holds nor releases.
4. The hold write yields. If the target turn ended or was replaced while the hold was being written, the stop cancels nothing, releases the hold it wrote, and returns the `guard.stopTargetChanged` noop. After a hold write, a stop without an expected id is pinned to the execution it observed before the hold, so it never aborts a turn that started during the hold write. A stop that wrote no hold keeps the earlier unpinned behavior (no await happened, so nothing could change).
5. The compat path (no runtime foreground execution token, for example compact or older clients) holds the queue too. If the bootstrap controller was replaced during the hold write, the stop releases the hold and noops without calling the runtime stop or aborting any controller. If the controller was cleared (the turn ended on its own), the stop releases the hold and still pauses an active goal, as the compat stop always did. A runtime token registered meanwhile under the same controller belongs to the same turn and is stopped.
6. After a stop that cancelled a turn, resuming is explicit (`setAutoDrain(true)`, the composer's resume action). A new Send while paused follows catalog B06 (confirm: clear the queue and send, or keep it paused and send).
7. A failed hold or release write is logged as a warning; the stop still proceeds. Only a hold this stop wrote successfully is ever released.
8. Residual risk: release writes `autoDrain=true` unconditionally. If an internal writer (a failing queued compact, which writes its own FIFO hold) wrote `false` during the same hold write and the stop then cancels nothing, the release undoes that hold. Accepted (decided 2026-10-22): the window is one hold write long and needs a queued compact to fail inside it; the worst case is that the queue drains as it would after a natural turn end. Closing it fully needs a hold owner or compare-and-set at the authority.

9. Steer (`sendQueuedNow`, and `sendText` with `requestedDelivery: startNow` while busy) preempts the running
   turn with the preserve intent (`preserveQueueAutoDrainOnCancel=true`). The intent travels on the runtime
   foreground execution when a token exists, and in the abort reason of the caller controller when it does not.
   The cancelled `TurnComplete` carries `preserveQueueAutoDrainOnCancel` and must not project a hold. The projection
   keeps `autoDrain`; the remaining queue is left in place and the CLI bridge auto-drain continues it FIFO.
10. A Steer never calls `holdFollowingQueue` or `setQueueAutoDrain(false)`, in either branch (runtime token or
    runtime idle with a caller controller). Covered by the CLI ISSUE-039 tests in `v4-native-queue.test.ts`
    (runtime idle and runtime token branches) and by the core tests `ISSUE-039 keeps queue auto-drain ...` and
    `ISSUE-039 holds the queue ...` in `runtime-tool-loop.test.ts`.
11. A user Stop after a Steer holds the queue again (rule 1). The hold belongs to the Stop, not to the earlier
    Steer, so a Steer does not suppress a later Stop. A user Stop with no runtime token aborts with a plain reason
    (no intent) and holds, as in rule 1.
12. Residual (fixed, ISSUE-039 A-1): before this fix a Steer with no runtime token aborted the caller controller
    without the intent, so the cancelled `TurnComplete` projected `pauseReason: "stopped"`. The fix is rule 9.
    Reachability note: the native v4 `sendText` path does not set `record.activeAbortController`; the caller-controller
    branch is reached by the legacy `session/send` path and by compact controllers (`goal-compact.ts`). The E2E
    cases do not reach it, so the regression guard for it is the unit and core tests.
13. Edit and retry (`editUserQuery`, `retryTurn`) call `preemptActiveTurnAndWait` without the intent (see Scope).
    A cancel from edit or retry holds the queue like a user Stop. This is documented, not changed.

## Acceptance scenarios

Unit tests: `apps/zcode-cli/packages/bootstrap/tests/v4-native-commands.test.ts` (ISSUE-010 cases). E2E: `conversation-session-v4-stop-queue` B02–B04 and B02a (`docs/conversation-session-case-catalog.md`).

1. Running turn, queue=2, stop with the current id: the projected `autoDrain` is `false` when the abort runs; the queue stays and does not drain.
2. Compat stop without a runtime token and queue=1: the hold is projected before the controller aborts.
3. Stop with a stale id: no hold is written; noop.
4. The turn ends during the hold write: `setQueueAutoDrain` is called with `false` then `true`, the ready hook runs with `queue_auto_drain_resumed`, nothing is aborted, noop.
5. Stop without an id, turn ends during the hold write: the runtime stop is called with the id observed before the hold; same release and noop.
6. Queue already paused by the user: the stop proceeds without any `setQueueAutoDrain` call.
7. Compat stop whose controller is replaced during the hold write: neither controller is aborted; the hold is released; noop.
8. Compat stop whose turn registers its runtime token during the hold write (same controller): that turn is stopped; the hold stays.
9. Compat stop whose turn ends during the hold write: the hold is released and an active goal is paused.
10. A failed hold write is never released.
11. A stop without an id that writes no hold calls the runtime stop unpinned and keeps the compat fallthrough.
12. ISSUE-039 Steer with queue=2 on a running turn (runtime token branch): no `setQueueAutoDrain(false)`
    (CLI unit `ISSUE-039：steer 抢占运行中 turn（runtime 有 token）不写 stop hold`); projection keeps `autoDrain`
    (projection unit `ISSUE-039：steer 的 cancelled TurnComplete 不 hold 投影`); E2E `STEER：` and `STEER 第二项：`.
    The E2E `STEER：` case asserts no paused banner at the moment the steered item's reply appears.
13. ISSUE-039 Steer then user Stop on the steered turn: the hold is written before the abort, the queue stays
    queued and is not consumed (CLI unit `ISSUE-039：steer 之后的用户 Stop 仍写 hold`; projection unit; E2E
    `STEER 后用户 Stop：`).
14. ISSUE-039 runtime-idle branch (no runtime token, caller controller present): a Steer aborts the controller with
    the preserve intent reason and writes no hold; a user Stop aborts with a plain reason and holds (CLI unit
    `ISSUE-039：runtime 尚无前台 token 时 steer ...` and `... 用户 Stop ...`; core unit `ISSUE-039 keeps queue
auto-drain when a caller abort carries the steer preserve intent` and `ISSUE-039 holds the queue when a caller
abort is a plain user Stop reason`). Runtime-idle is not reachable from the E2E steer path (see rule 12).
15. ISSUE-039 Steer immediately after the turn enters running (no streamed output yet): the queue still drains
    in order (E2E `STEER 刚进入 running：`).
