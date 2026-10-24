# ChatLoading Running Turn Boundary

## Background

`ChatLoading` expresses that the main conversation's current turn is still executing. That the assistant has output text, reasoning, ordinary tools or Agent/SubAgent cards does not mean the turn has ended. As long as the last main turn is still running and there is no blocker waiting for the user or in a maintenance state, it shows immediately; new projection events only update the turn content and do not reset or delay loading.

## State and order

```text
latest main turn enters running
              |
              v
       blocker currently active?
              |
              +---- yes: AskUserQuestion / permission / compact / goalVerifier
              |                         |
              |                         +---- hide ChatLoading
              |                                      |
              |                                      +---- blocker resolved
              |                                                   |
              |                                                   +---- show immediately if still running
              |
              +---- no
                                        |
                                        +---- show ChatLoading immediately
              |
              v
 success / failure / cancelled / stopped
              |
              v
         hide ChatLoading
```

## Rules

- Judge only the last render turn; a running row left in a historical turn does not show `ChatLoading`.
- When a turn has a `turnHeader`, `turnHeader.state` is the authoritative running/terminal fact; a header already in a terminal state cannot be pushed back to running by leftover or late running work rows of the same turn.
- Only when an old projection lacks `turnHeader` may running be derived from work rows as a fallback; a tool/subagent with `backgrounded=true` is background-only work and takes no part in that fallback.
- `ChatLoading` visually renders only the loading animation and shows no "thinking" text or other visible copy; the accessible name uses the generic "loading" semantics.
- When the last main turn is `running` and there is no blocker, `ChatLoading` shows immediately without waiting for a quiet window.
- Assistant text, reasoning, ordinary tools, Explore, Agent/SubAgent and their descendant tools do not end loading; when a new projection revision arrives the current loading visibility is kept.
- When the current snapshot has an ordinary permission pending interaction, or a userInput pending interaction with `toolName="AskUserQuestion"`, `ChatLoading` is hidden. The permission dialog / question box already expresses "waiting for the user" and "thinking" should not be shown at the same time.
- `toolCall.status="pendingApproval"` is the row-level fallback for windows where the interaction projection is missing, recovering or out of order, and also hides `ChatLoading`.
- After the interaction is resolved, if the last main turn is still `running`, `ChatLoading` returns immediately.
- If `control.activeWorks` contains `compact` or `goalVerifier`, `ChatLoading` is hidden; both already have independent timeline/status feedback.
- `primaryTurn`, `foregroundSubagent`, `goalContinuation` and `turnSteer` are not active-work blockers and show immediately when running.
- After the main turn reaches success, failure, cancelled or stopped, `ChatLoading` is hidden.
- When a background task is still running but the main turn is already idle, `ChatLoading` is not shown. Background tasks are expressed by the background control UI and must not keep the main chat area in loading permanently.
- An ordinary assistant turn and a structured background-result turn use the same running lifecycle rules.

## Layout and scroll order

The last running turn can no longer carry `ChatLoading` as an absolutely positioned virtual row. Historical turns stay virtualized, and the last running turn renders as a live tail in normal document flow:

```text
timeline scroll viewport
├─ virtual history spacer
│  └─ completed / historical turn (absolute + measured)
├─ running live tail (normal flow)
│  ├─ streaming assistant / tool rows
│  └─ ChatLoading reserved slot
└─ sticky composer dock
```

- When a projection revision arrives, the timeline's layout effect first does one synchronous bottom pin; but Markdown, code blocks and similar subtrees may only finish real height measurement after the parent effect, so it cannot be assumed that the revision commit already contains the final height.
- The live tail's `ResizeObserver` is the final anchor for real height changes: the callback caches the height needed for the terminal-state switch and, while still `following=true`, pins to the bottom synchronously once more before paint. When the user has scrolled up, or there is an upward scroll not yet credited by a scroll event, it only caches the height and does not take back scroll control.
- During eligible running, the reserved slot and the loading animation are visible together; a projection revision does not add or remove slot height.
- After running ends, the turn returns to the historical virtual list; the terminal state does not show `ChatLoading`.

## Decisions and pruning

| Candidate state | Decision | Reason |
| --- | --- | --- |
| running + primary/foreground subagent/goal continuation/turn steer | accepted (show immediately) | The current main turn is still advancing, so loading follows the running fact directly |
| any projection revision arriving during running | accepted (keep current visibility) | A projection content update does not change the main turn running fact |
| permission / AskUserQuestion / pendingApproval | pruned | The UI is waiting for user action and does not express "thinking" |
| active work contains compact / goalVerifier | pruned | There is already dedicated maintenance/verification state feedback |
| terminal turn or background-only work | pruned | The main turn has ended, and background facts cannot keep chat loading |
| desktop continuous / web remote replayable | accepted (same UI rule) | Consume only the same V4 snapshot converged by each delivery chain, without changing the recovery protocol |

## Multi-client boundary

This rule only changes the UI display projection of V4 turn `isRunning` and does not change the ZCode Protocol, snapshot, stream mirror, queue, owner or runtime state:

- Desktop still uses `desktop-continuous` direct realtime.
- Mobile remote still uses `web-remote-replayable` snapshot / gap recovery.
- Both consume the same turn running/terminal, `control.activeWorks` and `pendingInteractions` projections; after recovery they decide whether to show `ChatLoading` directly from the current main turn state and blockers.
- A background tool/subagent may keep updating through the background control UI, the status panel and independent result turns; these updates must not revive an already terminal main turn to running, nor restore the bottom `ChatLoading` because of it.
