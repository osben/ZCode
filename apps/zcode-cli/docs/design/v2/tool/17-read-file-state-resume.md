# Read File State Resume

## Background

User feedback on `ZCT-202606-B2299F52`: on Win11, editing an existing HTML file was repeatedly blocked by `File has not been read yet. Read it first before writing to it.`. The log shows that in the same session the model did several `Read limit` calls and then `Write` still failed, until a full `Read` succeeded.

The root cause is a flaw in two layers of semantics:

- ZCode's `readFileState` existed only inside the current `ToolExecutor` runtime; `resume` restored only provider-visible message history and did not rebuild read-state from the historical tool transcript.
- ZCode treated an `offset` / `limit` read as `isPartialView`, and `Write` accepted only a strict full read; the correct same-runtime guard rejects a file that was not read or is `isPartialView`, and `offset` / `limit` by themselves are not `isPartialView`.

## Resume contract

An ordinary `resume` adds no standalone persistence table and does not write read-state into provider-visible history. It rebuilds the runtime-local `readFileState` from the current active transcript. Read state contains at least the `content` the model saw, `offset`, `limit`, `isPartialView` and a timestamp for the stale guard; the only allowed recovery source is the structured read-state persisted in the completed tool part metadata, where the timestamp uses `mtimeMs`, and the `revisionId` exposed by the filesystem adapter is kept too:

- Scan only messages still active after compact / rewind.
- A successful full `Read` is restored; if that full `Read` was truncated by the token cap it is restored as the latest state with `isPartialView: true`. A historical `Read` with an explicit `offset` or `limit` is not restored and does not clear an earlier restored full `Read` state of the same file.
- A successful `Write` is restored as the current file state using the full `content` of the tool input and the end time of the completed tool part.
- A successful `Edit` re-reads the file content and mtime from the current disk and is restored as the current file state; if the file was deleted or is unreadable, that restore is skipped and does not block session resume.
- The restore process only affects this runtime's file mutation guard and produces no new model messages, stream events or app protocol fields.

Same-runtime read semantics:

- `isPartialView` means the content the model saw is incomplete or truncated by the tool, for example by the token cap.
- An explicit `offset` / `limit` is a range view and is not automatically equivalent to `isPartialView`.
- Before modifying an existing file, `Write` / `Edit` must find the latest read-state of the same file and reject `isPartialView`.
- In the stale fallback only a strict full read may pass when mtime advanced but the content is identical; a range read whose mtime advanced must require a re-read.

## ZCode implementation boundary

`AgentRuntime` holds a `ReadFileStateMap` shared for the lifetime of a session and passes the same map when constructing `ToolExecutor`. `resumeFromStore` clears and rebuilds this map in the same stage as restoring the provider-visible history, so the recovery boundary stays consistent with message history hydration.

The read-state hydrator must be independent of the UI, the desktop service and the remote-control replayable stream. It reads only the tool parts returned by `SessionStorePort.messages()` and the current `FileSystemPort`; it adds no `@zcode/protocol` field and does not change the message flow of desktop continuous or web remote replayable.

The completed tool part metadata of a successful full `Read` must additionally save a versioned `readFileState` snapshot:

- `tool: "Read"`, so other tools' metadata is not misused.
- `schemaVersion`, for later compatibility evolution.
- `path`, `content`, `offset`, `limit`, `isPartialView`, `mtimeMs`, `sizeBytes`, `revisionId`, corresponding to the recoverable fields of the runtime `ReadFileStateEntry`; `mtimeMs`, `sizeBytes` and `revisionId` must be completely present, otherwise this metadata does not take part in recovery.
- `readAtMs`, using the tool completed time as the watermark time after recovery.

Resume recovery priority:

1. When `metadata.readFileState` exists, the schema matches and the freshness metadata is complete, restore the structured snapshot directly.
2. When `metadata.readFileState` is missing or lacks `mtimeMs` / `revisionId` / `sizeBytes`, skip that historical `Read` and do not parse the cat-n text from the `state.output` string.
3. A successful `Write` / `Edit` can still restore the current file state; `Write` from the full `content` of the tool input, `Edit` from a filesystem read at resume time.

Code comments must explain two easily misjudged points:

- A historical range `Read` not being restored and not clearing old state is resume semantics; it does not mean a same-runtime range `Read` cannot serve as a mutation guard watermark.
- `isPartialView` means "the model view is incomplete", not an alias of `offset` / `limit`.

## Verification requirements

- After resume following a full `Read`, the next `Write` of an existing file no longer reports unread.
- After resume of a history with only a range `Read`, the next `Write` still reports unread.
- After resume of a history with a full `Read` followed by a range `Read`, the range `Read` neither overrides nor clears the restored full `Read`.
- After resume of a history with a full `Read` followed by a token-truncated full `Read`, the latter is restored as `isPartialView` and overrides the old full `Read`.
- After a same-runtime range `Read`, when the file is unchanged, `Write` can pass the unread guard.
- An `isPartialView` read-state is still rejected by `Write` and `Edit`.
- After compact / rewind, only tool results in active messages restore read-state.
- Windows drive-letter path normalization keeps its existing behavior.
