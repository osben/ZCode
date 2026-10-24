# Provider Pre-Request History Read Performance

## Background

Before sending each model step, the Agent Runtime reads the same `MessageHistory` several times. With a
long history, if every read-only point deep-copies all entries through `toRuntimeEntries()`, messages,
content blocks and metadata objects are allocated repeatedly; a further full deep copy at the provider
projection entry amplifies synchronous CPU and GC cost.

This change only narrows the history read and provider projection copy boundary inside the Runtime. It
does not change message order, microcompact results, cache control, the persistence format, the protocol
or UI behavior.

## Ownership contract

`MessageHistory` is the single authoritative owner of message history inside the Agent Runtime. Once an
entry is written into history it is used as an immutable value; changing history content must add an
entry, replace as a whole, or copy-on-write only the modified entry. In-place modification of a borrowed
entry/message/content is forbidden.

History offers three reads with different lifetimes:

| Read                                  | Cost            | Scope                                           | Contract                                                                                   |
| ------------------------------------- | --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `borrowReadOnlyRuntimeEntries()`      | O(1)            | synchronous, immediate read-only                | returns the current authoritative entries directly; callers must not write or hold across an async boundary |
| `[...borrowReadOnlyRuntimeEntries()]` | O(n) pointer copy | async tasks or compact boundaries needing a fixed member set | fixes the array members at that time; entries still share immutable references |
| `toRuntimeEntries()`                  | O(n) content clone | a mutable independent copy or external defensive snapshot | callers may modify the result without polluting history                          |

No revision, version cache or invalidation protocol is introduced. The Runtime calls borrow again at each
immediate read point to get the authoritative array of that moment. Only code that explicitly crosses an
`await` and must keep the scheduling-time boundary takes a shallow array snapshot at that read point.

## Sequence

```text
one model step

microcompact
  borrow current history A
  -> projection read-only
  -> if tool results are cleared, replaceMessages with new entry/message

reminder decision
  borrow current history B                # re-borrow, do not reuse A
  -> may addAttachment

final provider projection
  borrow current history C
  -> only with a memory update create the request array as [...C, update]
  -> reorder / system projection          # does not mutate input entries
  -> render clone message                 # the only content-clone boundary per projection
  -> media/cache-control/request
```

The background memory agent and active compact keep using the scheduling-time member set in later async
steps, so they take a shallow array snapshot at the entry. After the shallow snapshot, an append or
replacement of `MessageHistory` does not change the entry set selected by that task.

These two shallow snapshots only fix the array member boundary and do not deep-freeze entry/message/
content:

- Project Memory Extraction/Dream may consume `providerEntries` after other turns, compacts or rewinds
  following scheduling. The scheduling-time array snapshot excludes messages appended later, and the
  actual Memory provider request is built with render cloning message/content.
- Active compact keeps `activeEntries` across summary requests, retries and persistence. Selection,
  provider render and the final `replaceMessages` each clone the data they need to own.
- Both chains rely on the same immutability constraint: once an entry is in `MessageHistory` its
  entry/message/content must not be modified in place; later change goes only through append, whole
  replacement or copy-on-write of the modified entry. Violating it lets an already scheduled async
  snapshot observe content changes after scheduling.
- If history entries ever need in-place change, scheduling-time content-level defensive cloning or an
  equivalent immutable snapshot mechanism must be restored first; the current shallow-snapshot contract
  must not be reused.

## Projection copy boundary

- attachment reorder, mid-conversation system projection and legacy reminder moves only reorder
  references or create synthetic entries and must not mutate input entries.
- `renderProjectedEntryToModelMessage` creates an independent message/content for each message actually
  requested, isolating later media, cache-control and serialization.
- When microcompact does not fire it returns the read-only input directly; when it fires it shallow-
  copies the array and creates new entries and messages only for tool results that were actually
  cleared.
- `toRuntimeEntries()` keeps its original defensive deep-copy semantics and is not used as an ordinary
  read-only API inside the Runtime.

## Complexity and boundaries

After optimization, a history read is O(1), a member snapshot across an async boundary is an O(n)
pointer copy, and provider message render is still a necessary O(n) content clone. The microcompact
check and the final request each need one render but no longer re-clone runtime entries before each
render; one model step no longer re-clones the whole history for each reminder read.

Not handled here: token estimation, context-usage string concatenation, SQLite cold restore or the
`ModelRequest` event payload; these costs need separate measurement and must not be assumed gone.

## Verification

- Unit tests first lock defensive clone, provider projection isolation and microcompact not polluting
  its input.
- borrow API tests cover re-reading the authoritative value after append, an old borrow no longer being
  the authoritative array after replacement, and the defensive clone staying independently mutable.
- Copy-on-write tests cover that only cleared tool entries change reference while other entries stay
  shared.
- Targeted tests, `pnpm typecheck` and `pnpm lint` must pass.
- Compare the pre-send projection time before and after on a long-history benchmark; the benchmark is
  performance evidence only, not a hard-coded cross-machine product threshold.
