# Conversation Rendering Performance (current state)

The V4 render boundary is `snapshot.rows.window`, not the legacy `messages[]`.

```text
rows.window
  -> buildConversationTurnRenderUnits
  -> ConversationTurnGroup
  -> virtualizer visible range
  -> ConversationRowView
```

- `ConversationProjectionStore` updates rows/window by delta; unchanged rows keep a stable reference.
- `ConversationTimeline` uses `@tanstack/react-virtual` with dynamic height measurement and overscan, rendering only visible turns.
- Streaming row height changes flow back through measurement; follow-bottom is UI state and is not written to the projection.
- Performance optimizations must not merge different seqs, drop row actions, break terminal snapshot consistency or make the renderer keep a second message array.

Main entry points: `packages/ui/src/v4/ConversationTimeline.tsx`, `ConversationRowView.tsx`, `ConversationProjectionStore.ts`.
