# Stop holds the following queue (ISSUE-010)

## Problem

Stopping a running turn with queued input could let the queue drain on its own. The turn-end auto-drain check reads the projection, and the stop wrote `queue.autoDrain=false` only after aborting. When the abort finished the turn first, the check saw the old `autoDrain=true` and promoted the queue head the user had just tried to stop before.

## Owner

- The CLI `stop` handler (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts`) owns the hold a stop writes and its release.
- The v4 projection owns `queue.autoDrain`. The handler reads it through `V4CommandCoreHost.getQueueAutoDrain` and writes it only through `app.setQueueAutoDrain`.
- Resuming goes through the same ready hook as `setAutoDrain(true)` (`afterLegacyStateMutation(record, "queue_auto_drain_resumed")`), so an idle session promotes the queue head at once.

## Event order

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

1. A stop that will cancel a turn while the queue is not empty writes `autoDrain=false` and waits for it to be projected before any abort.
2. A stop whose execution id is already stale (mismatch/idle with an expected id) writes no hold.
3. A stop never resumes a queue the user had already paused: if the projected `autoDrain` is already `false`, the stop neither holds nor releases.
4. The hold write yields. If the target turn ended or was replaced while the hold was being written, the stop cancels nothing, releases the hold it wrote, and returns the `guard.stopTargetChanged` noop. After a hold write, a stop without an expected id is pinned to the execution it observed before the hold, so it never aborts a turn that started during the hold write. A stop that wrote no hold keeps the earlier unpinned behavior (no await happened, so nothing could change).
5. The compat path (no runtime foreground execution token, for example compact or older clients) holds the queue too. If the bootstrap controller was replaced during the hold write, the stop releases the hold and noops without calling the runtime stop or aborting any controller. If the controller was cleared (the turn ended on its own), the stop releases the hold and still pauses an active goal, as the compat stop always did. A runtime token registered meanwhile under the same controller belongs to the same turn and is stopped.
6. After a stop that cancelled a turn, resuming is explicit (`setAutoDrain(true)`, the composer's resume action). A new Send while paused follows catalog B06 (confirm: clear the queue and send, or keep it paused and send).
7. A failed hold or release write is logged as a warning; the stop still proceeds. Only a hold this stop wrote successfully is ever released.
8. Residual risk: release writes `autoDrain=true` unconditionally. If an internal writer (a failing queued compact, which writes its own FIFO hold) wrote `false` during the same hold write and the stop then cancels nothing, the release undoes that hold. Accepted (decided 2026-10-22): the window is one hold write long and needs a queued compact to fail inside it; the worst case is that the queue drains as it would after a natural turn end. Closing it fully needs a hold owner or compare-and-set at the authority.

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
