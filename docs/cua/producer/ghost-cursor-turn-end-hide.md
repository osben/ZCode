# Ghost cursor: hide on conversation turn end

## Problem

The ghost cursor faded out only after the 20s activity lease (`kPointerActivityLeaseMs`) expired. When the
conversation had ended and the user moved the target app away, the cursor still sat at the last action's
position during the lease, looking like a leftover ghost and contradicting "the Agent is no longer operating
the computer".

## Decision

Reuse the PiP session lifecycle events the host already sends; no new protocol:

- The host (`packages/services/src/cua-permission-broker/cuaPipSessionService.ts`) sends `turn-started` /
  `turn-ended` at each turn start/end and `session-closed` on session close; the Helper's PiP session
  coordinator (`createPipSessionCoordinator`) updates session state first, then calls the side effects.
- The Helper wraps those side effects with `withGhostCursorTurnEndHide`: `turnEnded` / `sessionClosed` are
  forwarded to the PiP scheduler as before, then, if **no session is running**, native `ghostHide()` is
  called.
- `ghostHide()` is a session-level hide: clear the target, stop timers, `orderOut` the overlay, but do not
  turn off the enabled switch; the next CUA action restores display through the normal feedback path, with no
  extra signal.

### Multiple sessions

When several conversations use CUA at once, only the end of the last still-running turn hides the cursor, so
conversation A ending does not hide the cursor of a still-operating conversation B. The criterion is the
coordinator snapshot (`status === "running"` in `snapshot().sessions`); the coordinator has already put the
session in a terminal state before calling `turnEnded`, so the snapshot reflects the post-end state.

### Not done

- The 20s activity lease is not shortened: it serves thinking gaps between cells within a turn, and
  shortening it would make the cursor flicker within one turn.
- No proactive show on `turn-started`: showing the cursor without an action is meaningless; the first action
  shows it naturally.

## Verification

- Unit: `withGhostCursorTurnEndHide` calls `hideGhost` once when the last running turn ends or the session
  closes; it does not call it while other sessions run; the original side effects are always forwarded and
  run before the hide.
- Real machine: after a conversation operating Maps ends the cursor disappears immediately; the first action
  of the next turn shows it again.
