# V4 Chat Layout Parity

## Background

The v4 conversation area restored the old composer look, but the parent layout of the message list and the
composer still differed from z-code-2. z-code-2 puts message content and the bottom input area in one scroll
container: the scrollbar reaches the very bottom including the input box, and the message column and composer
share one maximum width.

v4 `ConversationTimeline` owned its scroll container and `ConversationComposer` was a sibling of `SessionPane`,
so the scrollbar covered only the timeline, and rows had no unified main-column max width (text and tool
output diverged on wide screens).

## Goals

- In a session, the v4 message area and composer share one vertical scroll viewport.
- The composer stays `sticky bottom-0` inside that viewport; scrolled to the bottom, the composer bottom is
  within reach.
- The composer's bottom whitespace is carried by a transparent `padding-bottom` of the inner dock; messages
  gradually mask to transparent near the sticky composer so scrolled content does not run through the
  whitespace. In session state `chat-composer-input-surface` stays transparent with no `background`; the
  draft card with a context header still uses `bg-surface`.
- Message content, empty-message hint, back-to-bottom button and composer reuse the unified main column of
  `conversationLayout`. For a bound session: `w-full` below `conversation < 864px`; `calc(100% - 96px)` with
  `max-w-4xl` for `864px <= conversation < 1136px`; `calc(100% - 384px)` with `max-w-6xl` from `1136px`;
  drafts use `max-w-2xl`. Message turns respond to the conversation container via `@max-md/conversation:px-4`,
  while the composer dock always uses `px-4 pb-4`.
- Keep v4 virtual scrolling, row measure cache, bottom following and `loadOlder` semantics.
- Do not change the centered draft layout or the data links of remote replayable / desktop continuous.

## Layout chain

```text
SessionPane
  ConversationHeader
  body region
    ConversationStatusPanel
    shared scroll viewport
      virtual timeline content
        centered row column: conversationLayout
        viewport-aligned bottom mask: virtual history + running live tail
      sticky bottom composer dock
        centered composer column: conversationLayout
  QueuePanel
  runtime/dialog controllers
```

## Constraints

- `ConversationTimeline` keeps the virtual list and scroll anchoring but gains a `bottomDock` slot that
  renders the composer at the tail of its scroll viewport.
- The dock's bottom whitespace belongs to the dock container's own layout (responsive transparent padding, no
  spacing-only background child). The padding counts in the dock's real height so the Markdown table floating
  scrollbar keeps avoiding the full input-area height.
- The message mask wraps only the virtual history and the running live tail, not the composer, back-to-bottom
  button or pane focus ring. The fade position tracks the scroll viewport and the dock's real height (not the
  virtual content total height); desktop and mobile use a uniform 40px fade distance. The mask is off when the
  scrollbar is at the bottom and shows only when scrolled away from the bottom, where messages can pass under
  the sticky composer.
- In session state `SessionPane` no longer renders the composer outside the timeline; the draft state still
  renders it in the centered container.
- The scroll ref of `ConversationTimeline` stays the only scroll element and `useVirtualizer.getScrollElement`
  is unchanged, avoiding scroll-state crosstalk between panes.
- The row's outer absolute positioning stays `w-full`, with a new centered content column inside, so the
  virtualizer's measurement is unchanged.
- In session state `ConversationComposer` drops its own horizontal padding and the outer dock controls the
  width; draft state and the context-header card semantics are unchanged.

## Acceptance

- An SSR structure test sees the session-state composer rendered inside the timeline scroll viewport with the
  shared dock marker.
- An SSR structure test sees the timeline row content column and the bottom dock using the same
  `conversationLayout` classes.
- `pnpm vitest run packages/ui/test/v4SessionPaneLayoutParity.test.ts` passes.
- `pnpm typecheck` and `pnpm lint` pass; if unrelated failures exist in the environment, the commit note must list them.
