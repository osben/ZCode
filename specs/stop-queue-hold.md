# Stop holds the following queue (ISSUE-010), Steer does not (ISSUE-039)

## Scope decision (ISSUE-039, user decision: option b)

The queue hold is a user-initiated Stop effect only. Interrupting the running turn for a queued item
(Steer: `sendQueuedNow`, and `sendText` with `requestedDelivery: startNow` while busy) is not a Stop:
it never writes `autoDrain=false`, never projects `pauseReason: "stopped"`, and the remaining queue keeps
draining in FIFO order after the steered turn. A user Stop issued after a Steer holds again as before.
This reopens the ISSUE-010 wording: the earlier rule "every cancelling interruption holds" is replaced
by the rules below.

## Owners (the hold decision and where it is made)

- Renderer (`packages/ui/src/v4/SessionPane.tsx`): sends `sendQueuedNow { queueItemId }` (Steer button) or
  `sendText { requestedDelivery: "startNow" }`. It keeps only the uncommitted draft and the pending optimistic
  overlay. It never sends `stop` as part of Steer.
- Host routing (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`): one owner per session
  (window-scoped Local Host for desktop-continuous; the same Host attachment for web-remote-replayable). It
  forwards the command unchanged; it adds no hold.
- CLI `CommandInbox` / `V4CommandExecutor`: admits the command. The queue handler
  (`commands/handlers/queue.ts` `sendQueuedNow`) and the stop handler (`commands/handlers/session-flow.ts`
  `stop`) are the two decision points.
- Hold decision (`commands/input-admission.ts` `holdFollowingQueue`): called ONLY by the `stop` handler. Steer
  paths never call it.
- Preemption intent: `preemptActiveTurnAndWait` (`session-flow.ts`) calls
  `runtime.stopActiveForegroundExecution({ preserveQueueAutoDrainOnCancel: true })`. The runtime stores the
  intent on the active foreground execution (`core/src/runtime/methods/runtime-command-queue.ts`), the turn
  catch copies it to `TurnComplete.preserveQueueAutoDrainOnCancel` (`core/src/runtime/methods/turn.ts`), and
  the projection skips the held derivation when it is set (`bootstrap/.../product-projection.ts`
  TurnComplete handling, and `onTargetVerification` for the goal verifier path).
- Queue projection owner: `ProductProjection.queue` (`autoDrain`, `pauseReason`). Only `QueueAutoDrainChanged`
  and the cancelled-without-preserve `TurnComplete` change the hold.
- Auto drain (`v4-bridge.ts` `autoDrainV4QueueIfReady`, run after projection updates and on the drain retry): it
  promotes the queue head through `sendQueuedNow { autoDrainPromotion: true }` when `autoDrain=true`, the head is
  `queued`, and the session is idle.

## Event order (ISSUE-039: Steer vs Stop)

Desktop-continuous (the Desktop real-time link) and web-remote-replayable (the mobile/web recovery link) use the
same CLI path; only the transport differs. Both must show the same queue after a reconnect, because the hold
and the drain are projection facts, not transport state.

```text
Steer (sendQueuedNow queueItemId=Q1)                      owner
  Renderer optimistic overlay (Q1 row pending)            Renderer  (no stop, no hold)
  -> Host routing (no hold; desktop-continuous: local Host; web-remote: same attachment)   Host
  -> CommandInbox -> sendQueuedNow handler
       reserve(Q1) -> acquire lease(after-current)        CLI queue handler
       preemptActiveTurnAndWait
         runtime.stopActiveForegroundExecution({preserve:true})   Core runtime
           abort T0 -> turn catch -> TurnComplete(cancelled, preserve=true)
           projection: queue.autoDrain stays true, no pauseReason  ProductProjection
         waitForSessionIdle (T0 lock released)
       markPromoting(Q1) -> startPromptTurn(Q1, user_steer)
       SessionInputPromoted(Q1) -> remove Q1 (commit)
  -> T1 (Q1) runs; at TurnComplete(T1) the bridge sees Q2 head, autoDrain=true
       -> sendQueuedNow { autoDrainPromotion: true } (Q2 FIFO)   Host auto drain

User Stop after Steer (during T1)
  stop(expectedForegroundExecutionId=T1)                  CLI stop handler
    holdFollowingQueue: setQueueAutoDrain(false)          written and projected first
    runtime.stopActiveForegroundExecution (no preserve)   Core runtime
    TurnComplete(cancelled, no preserve) -> pauseReason=stopped (held)
    bridge: head Q2 autoDrain=false -> no drain           Host auto drain
```

Invariants:

- The only writer of `autoDrain=false` from a user action is the `stop` handler's hold. A Steer writes nothing
  to `autoDrain`; a Steer that runs `preemptActiveTurnAndWait` relies on `preserve=true` for the projection.
- A Stop that arrives while a Steer is between `reserve` and `startPromptTurn` sees the old foreground id and is
  rejected by the stale guard (`guard.stopTargetChanged`) or is pinned to the steered turn; it holds only if it
  cancels a turn (see rule 4 below).
- Stale-run protection and owner/lease checks are unchanged: `expectedForegroundExecutionId`, the promotion lease
  and the reservation still guard every step.

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
   turn with `preserveQueueAutoDrainOnCancel=true`. Its cancelled `TurnComplete` carries the intent and must not
   project a hold; the queue head starts, and the remaining queue drains FIFO through the auto-drain path.
10. A Steer never calls `holdFollowingQueue` and never calls `setQueueAutoDrain(false)`. Its `stop`-free path
    keeps the preemption intent on the runtime foreground execution; a Steer that finds no runtime foreground
    token keeps the earlier unpinned behavior (no hold written).
11. A user Stop after a Steer holds the queue again (rule 1). The hold belongs to the Stop, not to the earlier
    Steer, so a Steer does not suppress a later Stop.
12. Residual risk for Steer: if the preemption intent is lost (no runtime token and an already-aborted controller),
    the cancel reads as a user Stop and holds. Not reproduced: the Steer E2E cases pass on the current head, and the
    only path that aborts the bootstrap controller without the intent is the one where the foreground is already
    gone, which is also the window a user Stop would hold anyway.

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
12. ISSUE-039 Steer with queue=2 on a running turn: no `setQueueAutoDrain(false)`; the queue head starts, and the
    second item starts after it (CLI unit `ISSUE-039：steer 抢占运行中 turn 不写 stop hold`; projection unit
    `ISSUE-039：steer 抢占后剩余 queue 按序续跑`; E2E `STEER：` and `STEER 第二项：`).
13. ISSUE-039 Steer then user Stop on the steered turn: the hold is written before the abort, the queue stays
    queued and is not consumed (CLI unit `ISSUE-039：steer 之后的用户 Stop 仍写 hold`; projection unit; E2E
    `STEER 后用户 Stop：`).
14. ISSUE-039 Steer immediately after the turn enters running (no streamed output yet): the queue still drains
    in order (E2E `STEER 刚进入 running：`).
