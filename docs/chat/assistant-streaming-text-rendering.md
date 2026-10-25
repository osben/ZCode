# Assistant Streaming Text Rendering (Current Facts)

Assistant text comes from the V4 `assistantText` row. The CLI reducer produces row deltas, `ConversationProjectionStore` applies them, and `ConversationRowView` hands the current complete `row.text` to `MessageResponse`/Streamdown for rendering.

There is no old `useTaskStreamEvents` 50ms batch and no word-by-word reveal queue maintained by the UI. Pacing is determined by the arrival of authoritative deltas and React rendering; the final state must match the row text in the snapshot character for character.

```text
CLI text event -> ProductProjection row delta -> SessionDataLayer
  -> ConversationProjectionStore -> ConversationRowView -> MessageResponse
```

When optimizing the streaming experience the UI must not generate a second copy of the text or rewrite the final text with a timer; batching must keep the seq, rowId and snapshot/delta convergence semantics.
