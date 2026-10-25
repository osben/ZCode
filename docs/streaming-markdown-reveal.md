# Streaming Markdown Rendering (current state)

V4 does not implement word-by-word reveal based on `Intl.Segmenter`. The assistant row's current full text is passed directly to Streamdown/`MessageResponse`; the incremental Markdown appearance comes from continuous projection updates.

- Source of truth for body text: `ConversationSnapshot.rows`.
- Update entry: conversation delta.
- Render entry: `packages/ui/src/v4/ConversationRowView.tsx`.
- Final consistency: terminal snapshot text must equal the finally rendered text.

If an animation is reintroduced later, it must be a discardable visual layer only; it must not change copy, search, restore, virtual-scroll height measurement, or final row content.
