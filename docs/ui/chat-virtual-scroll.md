# Chat Virtual Scroll

> V4 current state: the scroll viewport, virtualization, bottom following and renderer-local scroll memory are owned by `packages/ui/src/v4/ConversationTimeline.tsx`; message facts still come from `packages/shared/src/zcode-protocol-v4/` and `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`.

## Goal

A long conversation renders only the message turns near the current viewport, reducing the renderer's DOM count and React update cost in long sessions.

## Rendering strategy

- `ConversationTimeline` uses `ConversationTurnRenderUnit` as the virtual-scroll unit rather than a single projection row.
- Each virtual row corresponds to one turn of user + assistant/tool output, so retry, fork, file-change summary and the current turn's loading are not split apart.
- Uses the project's existing `@tanstack/react-virtual`, with dynamic heights written back through `measureElement`.
- Conversation search first indexes by projection rows, then locates through the virtualizer and highlights in the already-mounted DOM.

## Bottom following during resize

`ConversationTimeline` is the only scroll owner and keeps `followingRef` and the existing user-intent decision. A user scrolling up releases following at once; scrolling back to the bottom or clicking back-to-bottom resumes it; search, turn positioning, session scroll memory and history prepend keep their original contract, and there is no forced-pinning switch.

- While following, reflow caused by viewport or content-column width changes uses pre-paint batching: read row heights -> update the virtualizer cache -> synchronously commit React placeholder heights and positions -> confirm the following right again -> pin to the bottom. It does not wait for a width-stable timer and does not leave an intermediate landing under the old placeholder heights to the next frame.
- The library observer may have updated the cache while still queueing the React commit, so the batch must trigger the layout commit explicitly and cannot rely on a repeated measurement without a delta to trigger a render. The synchronous commit runs only inside the ResizeObserver callback, and other content effects do not pin first during the batch.
- When away from the bottom the original width-change protection holds: per-row scroll compensation is paused during resize and no pinning is forced; normal measurement compensation resumes once stable. No sentence-level screen-coordinate reading anchor is added.
- The latest user intent is checked before and after each batch; an upward scroll, search or session switch during resize cannot be taken back by later measurement. The observer watches the viewport and the content column, temporarily cancels size observation of the content column and its parent message-layer mask before the synchronous commit and resubscribes on the next frame, so its own height writes do not trigger a notification loop while still covering CSS width transitions; measurement and pinning themselves are not deferred, and virtual rows are not subscribed twice. A message content getting taller keeps using the original measurement and content commit logic. The batch measures only mounted rows and does not poll or render the whole history.
- Desktop and mobile Web share this logic; an empty draft keeps the top-safe layout; the message protocol and the continuous/replayable boundary are not modified.

```text
size change -> ConversationTimeline checks the following right
  following -> batch measure -> sync commit layout -> check following right again -> pin to bottom
  away from bottom -> original width-change and reading-position protection
user scrolls up / search positioning -> release following (takes priority over layout callbacks)
back to bottom -> resume following
```

Acceptance: during repeated narrowing/widening the following landing and list placeholder height are correct; scrolling up during resize stays away from the bottom; clicking back-to-bottom follows again. The original session memory, search positioning and history prepend regressions pass. At runtime the pre-paint actual row bottom against the placeholder height error and the distance from the bottom are recorded and the visible frame is checked, allowing 1px sub-pixel rounding error; the landing after the drag stops cannot stand in for in-process verification.

Browser regression: `node --test packages/ui/test/browser/manual-review/pending/conversation-timeline-resize.test.mjs`. It covers the real timeline, message components and virtual list in desktop/mobile compact layouts, light/dark themes and an independent content-column width transition; data is a deterministic fixture, and mobile remote-control transport is outside this test. Real desktop sessions are still covered by `conversation-session-v4-scroll.test.ts` for streaming output and scroll memory.

## Scroll boundary

- The old multi-flag auto-follow state machine `useChatAutoFollow` was deleted; only one small bottom-lock state and an ordinary manual scroll container remain.
- `ConversationTimeline` uses one small bottom-lock state: a new session without scroll memory enables it by default, and message appends, markdown/tool detail growth and ResizeObserver changes keep writing the latest bottom `scrollTop`.
- The bottom-right "scroll to bottom" button is controlled only by the current scrollbar position: shown when the scroll container is not at the bottom and hidden at the bottom; the user scrolling back near the bottom manually or clicking the button re-enables bottom-lock, so the lock is not missed as generating content keeps growing. The bottom overlay holding the button uses an upward gradient mask of the `background` token, avoiding a hard edge when it covers the last message.
- When the message content is too short for a vertical scrollbar, the viewport has no historical reading position to keep, and ChatView treats it as a state where bottom-lock can be enabled; thus when later streaming content creates a scrollbar it can keep pinning.
- In the normal conversation state the composer renders in the same scroll viewport as the timeline through `bottomDock`, sticking with `sticky bottom-0`; the "back to bottom" button is anchored above the dock.
- Session switch reads renderer-local scroll memory first. The memory key is composed of `workspaceIdentity?.trim() || workspacePath`, `paneId` and the session/task scope; different panes of one renderer do not share reading positions, and neither do different desktop windows or mobile Web renderers share memory.
- If bottom-lock held when the memory was saved, switching back scrolls to the **current** latest bottom and keeps bottom-lock enabled; otherwise the saved pixel `scrollTop` is restored, clamped to the legal range for the current content height and kept away from the bottom. With no memory, opening positions to the bottom and enables bottom-lock.
- Restore first writes once in the layout phase, then corrects once more in the next animation frame after the virtualizer's first measurement; if the user has already scrolled, the second correction must yield write ownership.
- Search results, highlight find, fork source and turn navigator jumps are all positioning scrolls and stay away from the bottom afterwards; that position can be remembered by a later task switch.
- After older history is backfilled, the scroll position is restored by the added height, so the viewport does not jump to the top of history.
- When the conversation content width keeps changing, dynamic rows are re-measured in batches as text wraps. The away-from-bottom reading state must keep the current `scrollTop`, and the virtualizer must not compensate row by row for each row above the viewport, which would cause up-and-down jitter; the pinned state uses the synchronous measurement batch above, pinning by the committed new heights at every viewport resize. After the width stabilizes ordinary dynamic measurement compensation resumes, and normal bottom-lock for new messages and streaming content is unaffected.
- bottom-lock is not written to localStorage, relay, main process, host process or task runtime; scroll memory exists only for the current renderer lifetime and is reclaimed by a 200-entry LRU.

## Lazy rendering of history details

- The history area of `AssistantMessage` calls `renderHistoryParts` only when expanded, and keeps only the summary row when closed by default.
- `ToolLayout` supports `renderContent`; tool details are constructed only when expanded or force-expanded, so closed tools do not mount large markdown, diff and sub-tool DOM early.
- The expansion state of history and tool areas is kept in renderer memory by message/tool key, so details the user just expanded are not lost when virtual scrolling unmounts and remounts the component.
- Streaming, interrupted and settling states still force the history area open, so content in progress is not hidden; after streaming ends it returns to the summary state automatically.

## Render cache and memo boundary

- Completed markdown messages always use `Streamdown` static mode; only a real streaming animation enters the streaming/block path, avoiding an internal Streamdown update loop when virtual scroll and lazy history rendering repeatedly remount completed messages.
- `DiffViewer`, edit inline diff, `ToolLayout`, `ToolCallBlock`, `AssistantMessage`, `ChatMessage` and the turn group boundary use `memo`, reducing repeated commits of history messages when the parent updates.
- The retry, file-switch, feedback and fork callbacks passed to a single message inside the turn group are stabilized with `useCallback`, so memo is not defeated by inline functions in map.
- Diff only stabilizes options and viewer input and does not cache the actual DOM; theme, font size, wrapping and line-number setting changes still re-render normally.

## Remote-control boundary

This change only affects UI-layer rendering and does not change the ZCode task message stream, snapshot, queue or recovery semantics:

- Desktop `desktop-continuous` keeps the direct continuous main chain.
- Mobile remote control `web-remote-replayable` still shows messages through the replayable snapshot/gap recovery boundary.
- Full remote history is still controlled by explicit loading and virtual scrolling does not re-trigger implicit full-snapshot transfers.
