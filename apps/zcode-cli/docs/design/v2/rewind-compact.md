# Rewind and Compact Collaboration Design v2

## Scope

Defines the shared state model of rewind, checkpoint and compact in ZCode v2. It is neither a UI design
nor the implementation detail of the file restore adapter. It fixes four things:

- which conversation rewinds are legal after compact;
- how file checkpoints from before compact stay usable;
- how message attachments and large-file artifacts are kept or degraded across compact, rewind and fork;
- which recoverable, auditable contracts rewind / checkpoint must enter.

Compact owns the model-visible context; rewind owns restoring session and workspace state. They share
the session event log and the message/checkpoint anchors, but neither may directly tamper with the other's
history.

The phased implementation plan of conversation rewind is in [`rewind/plan.md`](./rewind/plan.md). It
lands this contract in the runtime, session store, TUI and ZCode app-server, and records the semantic
boundaries to keep.

## Auto Compact trigger basis

The auto compact trigger must prefer the real input token usage returned by the provider over local
character estimates. After each model request the runtime records its `usage.inputTokens`, the number of
provider-visible messages at request time, the model reference and trace information. At the next auto
compact check:

1. If a usable real `usage.inputTokens` exists, it is the baseline token count.
2. If assistant, tool or user messages were appended after the previous request, estimate locally only
   for the new messages and add that to the real baseline.
3. Only without real provider usage, fall back to a full local estimate of the current active chain.

Reason: OpenAI-compatible providers can differ by an order of magnitude from local estimates because of
tokenizer, tool schema, reasoning or server-side wrapping; real server usage is the highest-priority fact
source for compact decisions.

The local estimate is a conservative watermark when provider usage is unavailable. It must count both
ordinary body text and the text of `reasoning` blocks; it must not reuse a helper that projects only
visible body text and count reasoning as 0. Provider `reasoningTokens` is already included in
`outputTokens`, so it must not be added again when the usage anchor is reused. The estimate still
approximates tokens by character count, does not promise to match any provider tokenizer, and does not
change canonical history or provider-specific reasoning replay rules.

If a provider signals context overflow through a finish reason, such as `model_context_window_exceeded`
in GLM SSE, the runtime must normalize it to `ModelContextExceeded`, trigger reactive compact or throw a
structured error; empty content must not be treated as a normal `end_turn`.

## Core principles

### 1. The event log is the source of truth

Compact, checkpoint and rewind all append events or parts and never delete old history. The UI may hide
scrollback before compact and the provider active chain may start after the compact boundary, but audit
and advanced recovery can still find old state from the event log or transcript.

### 2. The active chain is the model-visible projection

After full compact the active chain by default contains only:

```text
compact boundary
compact summary
preserved messages
attachments
hook results
messages after compact
```

So conversation rewind by default selects only messages inside the active chain. Selecting a message
before the compact boundary must not be presented as an ordinary rewind.

### 3. Workspace checkpoints are independent of conversation visibility

File-modification checkpoints are not deleted by compact. Even if the anchor message of a checkpoint is
covered by compact, a file-only rewind can still run. After it, a new `rewind_triggered` event must be
appended, and the next model context must state which checkpoint the workspace was restored to.

### 4. Conversation rewind across the compact boundary uses an append-only branch cut

When the user goes back to a conversation point before compact, the current session neither physically
deletes old messages/parts nor creates a child automatically. The session persists
`keptMessageIDs + branchCutAfterMessageID + branchGeneration`; the active branch is the kept prefix plus
new messages after the cut. Only then is the last compact boundary within the active branch selected to
build provider history. Compact summary/boundary, microcompact, context usage and read-file derived
state that were cut off must be rebuilt, and no model-visible reminder describing the old prompt may be
appended.

### 5. Attachment artifacts are independent of workspace checkpoints

Images, PDFs, binaries and large-text previews in user messages are session input artifacts, not
workspace mutation checkpoints. File-only rewind restoring workspace files must not reinterpret already
committed attachments; conversation rewind cleaning message/parts must not delete attachment artifacts
immediately. Attachment artifacts are garbage-collected lazily through reference counting or an
unreferenced scan.

## Rewind scope

`RewindScope`:

- `conversation`: restores only the model-visible message chain, no file change.
- `workspace`: restores only the file/workspace snapshot, no change to the conversation active chain.
- `both`: restores conversation and workspace together.

`RewindStrategy`:

- `active_chain`: the target can be rebuilt from the append-only transcript and applied directly in the
  current session; crossing a compact boundary is allowed.
- `file_only`: the target checkpoint is restorable, but the conversation target is covered by compact.
- `fork_required`: reserved for explicit fork/workspace fork results; conversation edit/retry no longer
  hits this strategy because of compact.
- `unavailable`: the target does not exist or no usable checkpoint exists.

## Where compact and rewind intersect

### Full compact

Full compact writes `CompactBoundary.lastSummarizedMessageId`, the last message before the boundary
covered by the summary. After that:

- the active chain starts at the compact boundary;
- conversation checkpoints from before compact do not appear in the ordinary message selector by default;
- file checkpoints from before compact may appear in the advanced checkpoint list, but must be labeled
  `covered_by_compact`.

### Partial compact

Partial compact must record `preservedSegment`:

- `headMessageId`
- `anchorMessageId`
- `tailMessageId`

If the target is inside the preserved segment, conversation rewind may be handled as active chain. If the
target is covered by the summary, the full compact rules apply.

Partial compact must not split a tool_use/tool_result pair, nor the thinking/tool blocks of the same
assistant message id. The segment preserved in the `up_to` direction must drop the old compact boundary
and old compact summary, so backward scans never hit an old boundary.

### Persistence and cold recovery of the recent preserved segment

The recent groups already selected by auto/reactive compact do not enter the summary and must keep the
same persisted content in live and cold recovery. The selection unit is the existing assistant-started
round: the persistence side takes the most recent groups by the same group count and then records the
original `headMessageId / tailMessageId`; the message count obtained by source filtering in the runtime
must not be used to cut another candidate list in the database. `keptMessageCount` is computed from the
actually selected persisted records, is statistical only, and must not in turn decide the range.

Within the groups, user, coordinator, sub-Agent replies, background task notifications and persisted
Runtime Attachments all keep original text, identity and presentation markers. `synthetic`, `model-only`
and `source` express input identity or UI visibility and are not grounds to drop provider context. Tool
results are restored together with the tool parts of their assistant. Compaction control records,
timeline records with `providerVisibility=hidden` and failed records without model content stay
excluded; request-local prompts add no persisted copy and are still generated per their own lifecycle.

```text
runtime recent N assistant groups ──> live kept as is
                  |
active session takes the same recent N groups ──> save range IDs ──> cold recovery of the whole range
                                                    |
                                     unified MCS / non-MCS projection
```

The existing range schema is reused and old databases are not migrated. Old ranges also restore the
synthetic/attachment content they contain; messages that were wrongly excluded from the range at that
time cannot be inferred from the historical range, so the boundary is not extended retroactively. The
preserved segment takes part only in provider history and does not change the latest message anchor of
the post-compact timeline. Desktop continuous and mobile replayable keep consuming the same CLI
authoritative history without changing their own transport and recovery boundaries.

Regression tests must go through real compact boundary persistence and cold hydration and verify, with
the MCS switch, original text, complete reminders, roles, tool batches and counts; a test that only
copies runtime entries cannot prove cold recovery correct.

### File rewind after compact

When executing a file-only rewind of a pre-compact checkpoint the runtime must:

1. Verify the checkpoint snapshot is available.
2. Restore the workspace snapshot.
3. Append a `rewind_triggered` event with `strategy=file_only`.
4. Append a synthetic user/status message that can enter the model context, stating the restored
   checkpoint, the file count and the risk.
5. Leave the compact boundary of the active chain unchanged.

### Fork rewind

`/fork latest` and `/fork <checkpointId>` create a new child session instead of deleting or rewriting
history in the current session. The first version aims at "start a new line from here" while staying
recoverable:

1. The current session keeps the full history and compact boundary.
2. The child session's `parentID` points to the current session.
3. The child session copies the parent's messages/parts from the beginning to the message of the
   checkpoint and regenerates message/part ids to avoid cross-session primary-key conflicts.
4. Attachment `FilePart` metadata is copied with the message/part; immutable attachment artifacts may
   share a URI or increment a reference count.
5. If an attachment artifact of the parent session is missing, the child session must degrade the part
   to a `[Missing attachment: ...]` fallback and record a debug event.
6. The runtime restores the workspace files from the checkpoint artifact.
7. The child session appends a synthetic user/status message stating the fork origin, checkpoint,
   restored files, attachment degradation and compact risk.
8. The current session appends a `session_forked` event; the TUI may switch the active app to the child
   session.

If the anchor message of the checkpoint is covered by compact, fork is still allowed; this is the default
path for conversation rewind before compact. It does not pretend to return to an old message inside the
original session; it explicitly opens a new session.

### Attachment artifacts after rewind

The cleanup of conversation rewind only changes the active chain or deletes message/part references after
the target point and never deletes attachment artifacts immediately. This supports:

- forking back to the old branch after an accidental rewind;
- a compact summary that can still explain attachments that once existed;
- later GC of the artifact store by reference scan or retention period.

File-only rewind restores only the workspace checkpoint. Even if a restored workspace file path equals the
original `file://` path of an attachment, a committed attachment is still defined by the artifact
snapshotted at commit time and must not be overwritten by re-reading the current workspace file.

For a part-level rewind whose target is inside the same user message, `FilePart.source.text` decides
which attachment placeholders were deleted. After a placeholder is deleted, the matching `FilePart` no
longer enters the model projection, so orphan attachments are not sent to the provider.

## Contract

### CheckpointCreatedPayload

Fields:

- `checkpointId`
- `messageId`
- `scope`
- `snapshotRef`
- `diffRef?`
- `fileCount?`
- `compactBoundaryId?`
- `coveredByCompact?`

`coveredByCompact=true` means the message anchor of the checkpoint is no longer in the current active
chain, but the snapshot may still be restorable file-only.

### RewindTriggeredPayload

Fields:

- `rewindId`
- `scope`
- `strategy`
- `targetMessageId?`
- `targetCheckpointId?`
- `compactBoundaryId?`
- `restoredSnapshotRef?`
- `createdMessageId?`
- `reason?`

An event with `strategy=fork_required` may serve as the UI/SDK intent record; the real fork is done by
the session service appending `session_forked`.

### SessionForkedPayload

Fields:

- `originalSessionId`
- `forkedSessionId`
- `targetMessageId?`
- `targetCheckpointId?`
- `restoredSnapshotRef?`
- `restoredFileCount?`
- `strategy`
- `attachmentArtifactRefs?`
- `missingAttachmentRefs?`

### CompactBoundary attachment fields

The compact boundary records attachment summary fields for debug, fork and rewind decisions:

- `attachmentMessageIds?`
- `strippedAttachmentCount?`
- `strippedAttachmentBytes?`
- `strippedAttachmentRefs?`
- `missingAttachmentRefs?`

These fields describe only the attachments stripped or degraded at compact time; they do not mean the
attachments are still in the active model context.

## First implementation batch

- runtime schema: checkpoint payload, rewind payload.
- workspace checkpoint artifact schema: `workspace_file_before_change`, containing per file the path,
  whether it existed, the pre-change content and a structured diff.
- `evaluateRewindTarget()`: decides the strategy from the message list, target id, scope and checkpoint
  availability.
- Event payload types wired into `SessionEventPayload`.
- Projection records `lastCheckpoint` and `lastRewind`.
- After a successful file mutation write a checkpoint artifact and append `checkpoint_created`.
- `/rewind` shows recent checkpoints; `/rewind latest` or `/rewind <checkpointId>` executes a workspace
  file-only restore.
- `/fork latest` or `/fork <checkpointId>` creates a child session, copies the message chain and restores
  the workspace snapshot.
- Restore goes only through the `ToolArtifactStorePort.readToolResultArtifact()` and
  `FileSystemPort.writeTextFile/removeFile()` adapters and never touches the underlying fs directly.
- Attachment artifacts are first only retained and referenced; rewind cleanup does not delete them
  immediately.
- Unit tests cover: active target after compact, file-only before compact, conversation fork-required
  before compact, missing target, fork attachment fallback, rewind not deleting artifacts by mistake.

Not done: TUI message selector; partial compact runtime.

## Follow-up milestones

1. `contracts: rewind checkpoint payloads`: schema, event payload, projection, pure functions.
2. `core: create checkpoints around file mutations`: build snapshots before/after file writes through the
   file-system adapter, events carry the traceId.
3. `core: file-only rewind`: restore the snapshot and append a synthetic context message.
4. `tui: checkpoint selector`: for now shown through the `/rewind` command and live events; the active
   chain target selector follows later, with compact-covered checkpoints in the advanced list.
5. `core: fork-required conversation rewind`: conversation rewind before compact creates a fork instead
   of polluting the current active chain. The first version triggers it explicitly via `/fork`; later the
   message selector can automatically turn compact-covered conversation rewind into a fork proposal.
