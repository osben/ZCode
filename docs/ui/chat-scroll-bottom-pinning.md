# Chat scroll bottom pinning

> V4 current state: `ConversationTimeline` owns the bottom-follow and scroll-memory wiring; the memory module is `packages/ui/src/lib/chatSessionScrollMemory.ts`.

The V4 timeline maintains an explicit bottom-pinning state machine:

- `isPinnedToBottom=true` means the viewport is attached to the bottom of the messages; streaming output, the thinking shimmer and message layout changes follow to the bottom automatically.
- `isPinnedToBottom=false` means the user has left the bottom; streaming output must not overwrite the user's current reading position.

```text
                    user returns to bottom / clicks "back to bottom"
                    +----------------------------------+
                    |                                  v
+---------------------------+  user scrolls up, leaves bottom  +---------------------------+
| FOLLOWING                 | -------------------------------> | DETACHED                  |
| content growth/shrink     |                                  | all layout changes keep   |
| keeps sticking to bottom  |                                  | the reading position      |
+---------------------------+                                  +---------------------------+
          |                                                                 |
          | running -> terminal: live tail virtualization,                  | terminal collapse, measurement,
          | "working" history auto-collapse, dynamic measurement            | virtualizer compensation
          +-------------- stay FOLLOWING ----------------------------------+-- stay DETACHED
```

`FOLLOWING / DETACHED` expresses the user's scroll intent, not the instantaneous geometry from reading `scrollHeight - clientHeight - scrollTop` each time. A terminal transition moves the running live tail into virtual history and collapses the "working" history into "worked"; virtualizer estimation, real measurement and the collapse animation change `scrollTop` across several consecutive layout phases. These changes are not the user scrolling up and must not turn `FOLLOWING` into `DETACHED`.

## Behavior

- When opening a task, scroll memory is read first; if the memory records that the user was pinned to the bottom when leaving, switching back scrolls to the bottom once and keeps pinning; otherwise the saved history reading position is restored. With no scroll memory it scrolls to the bottom and enters the pinned state.
- After the user scrolls, if `distanceToBottom > 48px`, the pinned state is left immediately.
- When the user returns near the bottom or clicks the "scroll to bottom" button, the pinned state resumes.
- When a running assistant enters terminal, if it was pinned before the switch, the bottom keeps sticking through the live tail moving into virtual history, assistant history auto-collapse and the following dynamic measurement.
- If the user has left the bottom, or starts an upward scroll in the same frame as the terminal layout change, user input wins; the terminal transition must not restore pinning or pull the viewport back to the latest message.
- In-conversation find, global-search result highlight and fork anchors are positioning scrolls and must leave the pinned state before triggering, so the next streaming layout update does not pull the located result back to the bottom.
- The "back to bottom" button shows only when away from the bottom and render units exist; it does not show when the content has no vertical overflow.

## Scroll event priority

```text
within the same frame: user scroll intent > explicit positioning action > content/measurement/collapse layout change
```

| Event source | When FOLLOWING | When DETACHED |
| ----------------------------------------------- | --------------------- | ------------------------- |
| wheel/touch/keyboard/scrollbar upward leaving the bottom | immediately becomes DETACHED | stays DETACHED |
| user scrolls back near the bottom | stays FOLLOWING | becomes FOLLOWING |
| clicks "back to bottom" or submits a new prompt that starts at once | stays FOLLOWING and sticks to bottom | becomes FOLLOWING and sticks to bottom |
| live delta, terminal collapse, virtualizer measurement compensation | stays FOLLOWING and sticks to bottom | stays DETACHED, does not take scroll ownership |
| find, turn navigation, fork anchor positioning | becomes DETACHED first, then positions | stays DETACHED |

## Implementation boundary

- The conversation scroll viewport uses `scrollbar-gutter: stable` to reserve the native vertical scrollbar space, avoiding horizontal content shift when the scrollbar appears or disappears; desktop and mobile Web share the same rule.
- Auto-pinning uses `scrollRef.current.scrollTop = scrollHeight - clientHeight`, avoiding jitter from continuous smooth scrolls during streaming.
- When the user clicks "back to bottom" or submits a prompt that needs to locate the latest message, an instant `scrollTop` write is used and the pinned state is entered immediately; in the same handling the current session's pin memory must be committed synchronously, without waiting for a later `scroll` or scope cleanup, so switching session right after still restores as "pinned".
- A `scroll` event may change the pin intent only when associated with real user scroll input; the component's own bottom sticking and `scrollTop` changes from the virtualizer / collapse / measurement only update the geometry ledger and do not change `FOLLOWING / DETACHED`. Upward user scroll input is registered before the browser dispatches `scroll`, so it can release following first even in the same frame as a terminal commit.
- Scroll memory stores only the renderer-local reading position and pin intent; if a background task keeps streaming after switching to another task, a task that was pinned must re-pin to the bottom when switched back, so the old `scrollTop` is not treated as the user's historical reading position.
- User scroll, scope change and timeline unmount all save the current state; scope change reads the old DOM with the React before-mutation snapshot and reconciles an upward/downward scroll not yet dispatched, so a quick "scroll then switch away" is not overwritten by the new session's DOM or wrongly saved as pinned.
- On session restore, rows may arrive later than the session scope; the visibility of the "back to bottom" button must be reconciled again once rows/measurement are ready. As long as the restore intent is away from the bottom and scrollable content exists, the button must be offered; it must not be hidden forever because `rowCount=0` at the restore moment, nor may the viewport be clearly away from the bottom while the logic still shows pinned.
- Session scope, lease and rows must come from the same session: until the lease matches the target session the timeline does not consume the old projection. When a non-empty tail window or unfinished measurement clamps the away-from-bottom position to a temporary boundary, the original restore intent is kept and re-landed after history is backfilled; during that time prepend anchoring must not upgrade the temporarily clamped position to the final reading anchor. Real user scroll still has the highest priority and cancels the pending restore intent immediately.
- Memory is isolated by workspace key, pane and session/task scope, keeps at most 200 entries, lasts only until the current renderer ends, and does not cross refresh, app restart or device sync.
- This feature only affects the scroll position inside the renderer and does not change the task message semantics of desktop continuous and web remote replayable.

## Coverage decisions

- Accepted: the `following=true` running -> terminal collapse/virtualization path, and the `following=false` and "user scrolls up in the same frame as terminal" race paths.
- Desktop `desktop-continuous` uses a controlled-stream E2E to represent real streaming and terminal timing; the final body uses enough natural text so that scrollable height is produced stably even if the model ignores explicit line breaks.
- Mobile Web and desktop reuse the renderer scroll state machine, and focused tests prove input source and state priority; this fix adds no snapshot, queue, owner, relay or `web-remote-replayable` state and does not sync the desktop's renderer-local scroll position to the phone.
- The concrete content shape of reasoning/tool/subagent, theme and locale do not change who owns scrolling, so no Cartesian product; the E2E picks one collapsible assistant history as the representative.
