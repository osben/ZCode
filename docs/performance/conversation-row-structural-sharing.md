# Conversation Row Structural Sharing

## Background

A renderer stress run on 2026-09-29 (isolated HOME, mock provider) found a JS heap of about 200MB after
foreground GC, of which large strings were 138MB. These strings had only 36 distinct values but 730
copies; for example the same 200KB tool `inputText` was stored 112 times, and the `input.content`
parsed from it just as many.

Two factors combine:

1. **Historical snapshots are held by a closure chain.** `SessionPane` reuses one instance when
   switching tasks (the mount point has no `key={sessionId}`). Its `useCallback` closures share the V8
   Context of each render, so they chain alternately and keep the `state` (projection snapshot) of
   every historical render alive: 220 render scopes and 134 states measured.
2. **Whole replacement shares no row objects.** `ConversationProjectionStore` replaces everything on a
   `snapshot` frame per "rule 1", so all row objects come from a freshly deserialized result;
   `row.upserted` also swaps in new objects. Every historical snapshot therefore owns its own set of
   large strings even when the content is identical.

Point 1 decides how many snapshots are kept; point 2 decides how big each is. This design fixes point
2: identical data is kept once, so a retained historical snapshot costs only array and row-shell
overhead.

## Design

```
host frame ──► ConversationProjectionStore.handleFrame
                 │
   snapshot      │  each row of rows.window ──► rowPool.shareRow(topic, row)
   deltas        │  rows hit by row.upserted / row.appended ──► shareRow
                 │  rows hit by row.delta ──► remember (register only, no comparison)
   rows/range    │  earlier rows merged in ──► shareRow
                 ▼
          ConversationRowPool (held by SessionDataLayer, outlives the store)
            Map<topic␀rowId, WeakRef<row>> + FinalizationRegistry cleanup
                 │
                 ├─ old row GC'd or absent → register the new row, return it as is
                 └─ old row alive → shareStructure(old, new)
                        deeply equal    → return the old row (reference unchanged)
                        partially equal → new shell + reuse unchanged children (including old string references)
```

- **The pool lives in `SessionDataLayer`, not in the store.** After keep-warm (default 30s) expires the
  store is closed and a cold open creates a new store, but old snapshots may still be held by the
  closure chain; the pool must span stores so that rows of a cold open can reuse the still-alive old
  rows.
- **Only `WeakRef`.** The pool itself extends no row's lifetime. After a row is GC'd,
  `FinalizationRegistry` deletes its entry, first confirming the entry is still the same `WeakRef` to
  avoid deleting a newer row registered later.
- **Key is `topic + rowId`.** No sharing across sessions. After a rewind a rowId may be reused with
  different content, but sharing happens only where values are deeply equal, so the semantics are safe.
- **`shareStructure(prev, next)`:**
  - Recurses only into plain objects, arrays and Maps; other types return `next` directly. The Map
    branch serves UI-derived join tables (`useStructurallySharedMemo`, for example SessionPane's
    workflow table), key order counts as part of equality; conversation rows themselves contain no Map.
  - Primitives compare with `Object.is`. A string with equal content but a different reference returns
    prev's string, so next's copy can be GC'd.
  - It never mutates `next`: `next` may come from apply.ts structural reuse and be referenced
    elsewhere.
- **Snapshot frame:** every row is shared. If every shared row is `===` the corresponding row of the
  current window and the length is equal, the window array is reused as well.
- **`row.delta` does no comparison.** Strings appended while streaming are new anyway and per-frame deep
  comparison would only burn CPU; the new row is only registered in the pool and is shared with it when
  the final `row.upserted` arrives.
- **Semantics unchanged.** Sharing only reuses references and values remain deeply equal. The sharing
  logic lives in the UI store layer and does not change `applyConversationDelta` of `@zcode/shared`,
  because apply.ts is contracted to add no semantic branch on the client.

## Impact

- Desktop `desktop-continuous` and mobile `web-remote-replayable` use the same
  `ConversationProjectionStore`; delivery semantics are unchanged, only object identity is more stable.
- Reference-equal rows let memoized row components skip rendering, which is expected because the data
  really did not change.
- The closure chain itself (point 1) is out of scope; `key={sessionId}` or splitting SessionPane can be
  assessed separately.

## Verification

- Unit: `packages/ui/test/conversationRowSharing.test.ts` (shareStructure and the pool) and the
  store/layer cases in `packages/ui/test/v4SessionDataLayer.test.ts` (repeated snapshot, upsert, cold
  open after keep-warm expiry, cross-topic isolation).
- Runtime: stress with an isolated HOME, only switching tasks 18 times, then count large-string copies
  from a heap snapshot against the baseline (144 states, 790 copies / 150MB, heap 213MB).

## Verification result (2026-09-30)

A/B conditions: same seed data (isolated HOME, mock provider); cold start -> send 2 rounds of large-file
tool calls -> switch each of 9 tasks 2 rounds -> GC -> heap snapshot.

| Metric                                | Before          | After                     |
| ------------------------------------- | --------------- | ------------------------- |
| JS heap after GC                      | 93.3MB          | 68.1MB                    |
| >=20KB large-string copies (37 values) | 216 / 39.3MB   | 89 / 14.9MB               |
| Max copies of a single inputText      | 32              | 10                        |
| States held by the closure chain      | 37              | 37 (not handled here)     |

Remaining copies mostly come from the UI derivation layer (sliced strings for rendering,
`assistantWorkRows`, ...), not projection rows, and are out of scope. The more states the closure chain
holds, the more this design saves: in a long session states can reach over a hundred, so memory saving
scales with the count.
