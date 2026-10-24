# Chat Scroll Events (current state)

The old "remove onScroll/ResizeObserver" plan has been superseded by the V4 virtual timeline. The current `ConversationTimeline` uses:

- `onScroll` to decide user position and follow-bottom;
- `ResizeObserver` / dynamic measurement to maintain streaming row heights;
- a virtualizer to control which turns render;
- a scroll-to-bottom button to help the user resume auto-follow.

These events maintain UI view state only and must not affect conversation seq/projection.
