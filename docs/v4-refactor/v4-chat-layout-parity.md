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
- The composer's bottom `16px` whitespace is carried by the `padding-bottom` of the timeline root container, outside the scroll viewport; the inner dock has no bottom padding. Messages no longer fade out and cannot scroll into the bottom whitespace. Session state keeps the existing input background; the draft card with a context header still uses `bg-surface`.
- Message content, empty-message hint, back-to-bottom button and composer reuse the unified main column of
  `conversationLayout`. For a bound session: `w-full` below `conversation < 864px`; `calc(100% - 96px)` with
  `max-w-4xl` for `864px <= conversation < 1280px`; `calc(100% - 384px)` with `max-w-6xl` from `1280px`;
  drafts use `max-w-2xl`. Message turns use `px-4 @md/conversation:px-6` to respond to the conversation container, and the composer dock's horizontal padding is `px-2`; the bottom whitespace comes from the outer timeline.
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
        unmasked virtual history + running live tail
      sticky bottom composer dock
        centered composer column: conversationLayout
    fixed bottom padding: 16px outside scroll viewport
  QueuePanel
  runtime/dialog controllers
```

## Constraints

- `ConversationTimeline` keeps the virtual list and scroll anchoring but gains a `bottomDock` slot that
  renders the composer at the tail of its scroll viewport.
- For ordinary sessions the existing bottom whitespace moves from the inner dock to the timeline root container; no background child is added and the input height is not measured to position the whitespace. The Markdown table floating scrollbar still avoids the input area's real geometry.
- The virtual history, running live tail and header slot use no mask; during fast scrolling the top and bottom edges are clipped by the fixed overflow viewport, with no scroll-callback compensation of edge positions. The outer bottom padding does not apply to the centered draft, floating windows or read-only timelines without a bottomDock.
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
