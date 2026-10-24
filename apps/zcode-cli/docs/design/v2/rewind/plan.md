# Rewind Implementation Plan v2

Status: initial runtime slice implemented; selector UI and ZCode app-server projection still planned.
Date: 2026-05-11.

Turns the rewind/compact/checkpoint contract into an implementation plan. Read with
`docs/design/v2/rewind-compact.md` and `docs/design/v2/compact/README.md`.

## Goals

Rewind lets users return to a previous user-authored point without making compact, checkpoint or resume
state ambiguous:

- `/rewind` opens a message selector in interactive clients.
- `/rewind <messageId>` rewinds the conversation to before that user message when it is still in the
  active chain.
- `/rewind code <messageId>` (or an equivalent picker option) restores only the workspace checkpoint of
  that message.
- `/rewind both <messageId>` restores both conversation and workspace when the target is in the active
  chain and a workspace checkpoint exists.
- If the target is covered by compact, conversation rewind becomes a fork proposal or the explicit
  `/fork <checkpointId>` path. File-only rewind may still run if the checkpoint artifact exists.

Three concepts stay separate: conversation rewind changes model-visible message state; workspace rewind
changes files from checkpoint artifacts; compact changes which historical messages the model sees.

## Target UX

State ownership stays in session/runtime contracts, not TUI-local state:

- `/rewind` is a local command that opens a message selector rather than mutating state directly.
- The selector lists user-authored messages and offers the restore modes conversation, code, both and
  summarize.
- File history snapshots are keyed by user message UUID. Tools call `fileHistoryTrackEdit()` before
  mutation and the query loop creates a snapshot for each accepted user message.
- Conversation rewind truncates messages to before the selected user message, resets transient state,
  restores the selected prompt into the input, and restores pasted images.
- Compact boundary messages slice the provider-visible context. Selectors may still show older
  scrollback, but summarize/rewind must reject or fork when the target is not in the active context.
- Non-interactive file rewind is standalone: resume a session, pass a user message UUID, restore files
  and exit.

TUI and ZCode app-server consume the same target evaluation results.

## Current ZCode baseline

Implemented:

- `CheckpointCreatedPayload`, `RewindTriggeredPayload`, `WorkspaceCheckpointArtifact` and
  `evaluateRewindTarget()`.
- Workspace checkpoint artifacts are written for successful file mutation tool results.
- New checkpoint `messageId` values are anchored to the user message that opened the turn, while
  `toolMessageId` preserves the assistant message owning the tool part. Older checkpoint events may only
  have the assistant message id.
- `/rewind latest` and `/rewind <checkpointId>` restore workspace files.
- `/fork latest` and `/fork <checkpointId>` create a child session from a workspace checkpoint.
- Compact writes standard `CompactBoundary` payloads and replaces the active provider history.
- The TUI has a generic selection list for checkpoint/session rows.

Initial slice (2026-05-11):

- Checkpoint events keep a user-message anchor and an optional tool/assistant-message anchor.
- `/rewind message <messageId>` and `/rewind conversation <messageId>` rewind the active
  provider-visible conversation to before an active user message.
- `/rewind code <messageId>` resolves the latest workspace checkpoint for that message and restores it.
- `/rewind both <messageId>` composes workspace restore and active conversation rewind when the target is
  still in the active chain.
- Resume hydration applies compact boundaries before persisted conversation rewind targets, so
  compact-covered messages cannot be reintroduced by resume.

Still missing for the full conversation rewind UX:

- Selectable user-message target summaries.
- Rich persisted tombstone/revert metadata for hidden post-rewind messages.
- TUI/ZCode app-server projection that shows conversation, workspace, both, fork and unavailable modes.
- Interactive input restoration after rewind.

## Target model

`RewindTargetKind`:

- `message`: user-authored message id.
- `checkpoint`: workspace checkpoint id.
- `latest`: latest workspace checkpoint or latest selectable message depending on the command mode.

`RewindMode`:

- `conversation`: restore the provider-visible message chain only.
- `workspace`: restore files only.
- `both`: restore conversation and workspace in one audited turn.
- `fork`: create a child session when conversation rewind crosses compact.
- `summarize`: optional later mode performing partial compact around the selected message instead of
  restoring.

`RewindTargetSummary`: `messageId`, `checkpointId?`, `createdAt`, `preview`, `modeAvailability`,
`strategy`, `compactBoundaryId?`, `coveredByCompact`, `fileCount?`, `diffStats?`, `disabledReason?`.

### Strategy matrix

| Target | Requested mode | Checkpoint | Compact status | Strategy |
| --- | --- | --- | --- | --- |
| active message | conversation | any | active chain | `active_chain` |
| active message | workspace | yes | active chain | `active_chain` |
| active message | both | yes | active chain | `active_chain` |
| active message | workspace/both | no | active chain | `unavailable` |
| compact-covered message | conversation/both | any | covered | `fork_required` |
| compact-covered message | workspace | yes | covered | `file_only` |
| missing message | any | any | missing | `unavailable` |
| checkpoint id only | workspace | yes | any | `active_chain` or `file_only` |

`both` is not two unrelated operations. It is one runtime turn that emits one `rewind_triggered` event
with `scope=both`, records the selected message/checkpoint, restores files, then replaces the active
conversation state. If the file restore fails, conversation state must not be truncated.

## Contracts

### RewindTargetEvaluated

A reusable pure result type in `packages/contracts/src/rewind`:

```ts
export interface RewindTargetSummary {
  checkpointId?: string;
  compactBoundaryId?: string;
  coveredByCompact: boolean;
  createdAt: number;
  disabledReason?: string;
  fileCount?: number;
  messageId: MessageId;
  modeAvailability: Record<RewindMode, boolean>;
  preview?: string;
  strategy: RewindStrategy;
}
```

The runtime returns these summaries to TUI/ZCode app-server so clients do not parse raw messages, compact
parts or checkpoint events.

### Conversation rewind event

Extend `RewindTriggeredPayload` only if needed; prefer existing fields: `scope=conversation | both`,
`strategy=active_chain | fork_required | unavailable`, `targetMessageId`, `targetCheckpointId?`,
`compactBoundaryId?`, `restoredSnapshotRef?`, `createdMessageId?`, `reason`. If post-rewind hidden
history needs durable metadata, add `conversationCutMessageId` or `removedMessageCount` rather than
storing removed message bodies in the event.

### Session store

Do not hard-delete messages for conversation rewind in P0. Add a contract that lets the runtime persist a
logical active-chain override:

```ts
interface SessionConversationRewind {
  rewindId: string;
  targetMessageId: MessageId;
  keepBeforeMessageId: MessageId;
  removedMessageCount: number;
  compactBoundaryId?: string;
  createdAt: number;
}
```

Options:

- Preferred P0: store it as session-level `revert`/rewind metadata plus a `rewind_triggered` event; the
  message hydrator applies the latest rewind cut when reconstructing active messages.
- Later: add tombstone fields or an explicit message-chain table if multiple branches need first-class
  storage.

This preserves audit history and avoids deleting attachments, tool artifacts or compact summaries.

## Runtime plan

### Phase 1: message target listing

Add `listRewindTargets({ limit, includeCoveredByCompact })` to the runtime and the bootstrap app facade.

- Only user-authored, non-synthetic, non-meta messages are selectable. Tool result messages, synthetic
  rewind notices, compact summaries, queued command outputs and transcript-only messages are excluded.
- Each row is evaluated against the latest compact boundary and includes matching workspace checkpoint
  metadata when available.
- The default interactive list may hide compact-covered conversation targets but should expose them in
  advanced mode or mark them fork-required.

Tests: synthetic messages excluded; a user message with a workspace checkpoint advertises `workspace` and
`both`; a compact-covered message advertises `workspace` only if the checkpoint exists, and
`conversation` as fork-required.

### Phase 2: workspace checkpoint mapping by message

Workspace checkpoint selection is checkpoint-id first and checkpoint events point at assistant/tool
messages, but conversation rewind needs a user-message view. Add explicit turn ownership to checkpoint
metadata: `targetMessageId` or `userMessageId` (the user-authored message the restore target appears
under) and `toolMessageId` or `assistantMessageId` (the assistant message owning the tool part and
artifact). Then add `selectCheckpointForMessage(events, messageId)`. "Latest checkpoint at or before the
selected user message" is not enough: use checkpoints whose user-message anchor equals the selected user
message, unless a later spec defines a richer turn graph. If a turn produces multiple file mutation
checkpoints, group them under one message-level restore target and restore all artifacts in stable order.

This is the biggest difference from the current P0, where each successful file mutation creates a
one-file checkpoint anchored to the assistant/tool message.

Tests: several file mutations in one turn yield one message-level target with all files; a missing
artifact makes workspace/both unavailable but still allows conversation-only active-chain rewind.

### Phase 3: conversation-only active-chain rewind

`rewindConversationToMessage({ targetMessageId })`:

1. Reject if another regular/compact/rewind turn is active.
2. Load persisted messages through `SessionStorePort.messages()`.
3. Apply the latest compact boundary and the latest prior rewind cut to get the current active chain.
4. Find the target user message in that active chain.
5. Build the kept chain as the messages before the target message.
6. Rebuild provider `messageHistory` from the kept chain.
7. Persist a synthetic user/status notice saying the conversation was rewound and the selected prompt is
   ready to edit/resubmit.
8. Append `rewind_triggered` with `scope=conversation`.
9. Persist session rewind metadata so resume applies the same cut.

The selected user prompt is returned in the command result as `restoreInput` for TUI/ZCode protocol
clients; the runtime does not mutate TUI input state directly.

Tests: rewind to a user message removes later messages from provider context; old messages stay in
storage for audit; resume after rewind reconstructs the same active chain; the permission/model/context
snapshot of the selected message can be surfaced to clients, but P0 does not silently rewrite session
permission.

### Phase 4: both mode

`rewindToMessage({ targetMessageId, mode: "both" })` order: evaluate the target; read all workspace
checkpoint artifacts of the target message; dry-parse all artifacts before touching files; restore files
through `FileSystemPort`; rebuild the active conversation chain; persist the synthetic notice and event.

Failure rule: if checkpoint read or file restore fails, do not truncate the conversation. If the
conversation rewrite fails after file restore, emit a failed event with the restored snapshot refs and
return an actionable error; no silent reverse restore in P0.

Tests: both mode restores files and truncates the active chain; file restore failure leaves the
conversation unchanged; the event payload contains both target ids and restored refs.

### Phase 5: compact-covered targets

For targets before the latest compact boundary:

- `conversation` and `both` return `fork_required`.
- Interactive clients present "Fork from here" instead of "Restore conversation".
- The runtime may expose `forkConversationFromMessage()` later; P0 reuses checkpoint fork where
  possible.
- `workspace` stays available if checkpoint artifacts exist and emits `strategy=file_only`.

Tests: compact-covered conversation rewind never mutates the current active chain; file-only
compact-covered rewind adds a synthetic notice and preserves the compact boundary; fork creates a child
session and restores files without editing the parent active context.

### Phase 6: client UX

TUI:

- Bare `/rewind` opens a message selector, not the checkpoint selector, defaulting to recent user
  messages.
- Rows show prompt preview, age, compact/fork-required marker and file-change count when available.
- Selecting a row opens a mode picker: conversation, workspace, both, fork, nevermind.
- Keep `/rewind latest`, `/rewind <checkpointId>` and `/fork <checkpointId>` as scriptable
  compatibility paths until message-id syntax is finalized.

ZCode app-server: add list/evaluate/apply methods or emit structured selection data through the existing
app facade; remote clients must not infer active-chain legality from transcript scrollback.

CLI non-interactive: add an explicit standalone file rewind command only after message-id checkpoint
mapping is stable; conversation rewind stays interactive until active-chain replacement and resume
behavior are covered by tests.

## Command syntax

Current compatibility:

- `/rewind` opens the selector in the TUI or shows status in non-interactive clients.
- `/rewind latest` restores the latest workspace checkpoint for now.
- `/rewind <checkpointId>` restores that workspace checkpoint.
- `/fork <checkpointId>` forks from a checkpoint.

Message-id syntax, introduced behind tests: `/rewind message <messageId>`, `/rewind code <messageId>`,
`/rewind both <messageId>`, `/rewind fork <messageId>`. Do not overload bare `/rewind <id>` until
checkpoint ids and message ids have unambiguous prefixes in all persisted data.

## Compact coupling rules

- The compact boundary is the source of truth for the provider-visible active chain.
- Conversation rewind may only cut inside the current active chain.
- Compact-covered conversation targets must fork or return unavailable.
- Partial compact must record preserved segment fields before it can be eligible for conversation
  rewind.
- Rewind-created synthetic notices are normal active-chain messages, but the message selector must
  exclude them.
- After rewind, auto compact uses the post-rewind active chain and does not count hidden audit history.

## Checkpoint coupling rules

- Workspace checkpoints are artifacts, not conversation messages.
- Message-level restore targets aggregate all file mutation artifacts of one user turn.
- Rewinding files does not change attachment artifacts.
- Conversation rewind does not delete checkpoint artifacts.
- Rewind events include enough refs to audit which checkpoint artifacts were used.
- Large diffs stay in artifact storage; selector rows return summaries only.

## Observability

Emit structured logs/events: `rewind.targets.listed`, `rewind.target.evaluated`, `rewind.started`,
`rewind.workspace.restore.started`, `rewind.workspace.restore.completed`,
`rewind.conversation.apply.started`, `rewind.conversation.apply.completed`, `rewind.failed`.

Every operation carries the existing `traceId`, `turnId` and child span context. Errors use stable
reasons, not message text:

- `target_message_not_found`
- `target_not_user_authored`
- `target_covered_by_compact_requires_fork`
- `checkpoint_required_for_workspace_rewind`
- `checkpoint_snapshot_unavailable`
- `conversation_rebuild_failed`
- `session_store_not_configured`
- `file_system_port_not_configured`

## Test plan

- Contracts: extend `packages/contracts/tests/rewind.test.ts` for message target evaluation, mode
  availability and compact-covered fork-required cases.
- Core runtime: list rewind targets from persisted messages; rewind the conversation active chain; rewind
  both with all message-level file artifacts; resume after conversation rewind; compact then conversation
  rewind before the boundary; compact then file-only rewind before the boundary; missing checkpoint
  artifact; multiple file edits in one user turn; synthetic messages excluded from selector rows.
- CLI/TUI: bare `/rewind` opens the message selector when available; the compatibility checkpoint picker
  stays reachable through the explicit checkpoint command path; the mode picker submits explicit
  command-shaped requests; disabled rows explain fork-required or unavailable status.
- ZCode app-server/bootstrap: the app facade exposes target listing and structured apply results; remote
  clients get `restoreInput` instead of relying on terminal-only state.

## Implementation order

1. Contracts: target summary/mode types and pure evaluation helpers.
2. Core target listing: derive user-message rows and attach checkpoint metadata.
3. Runtime workspace mapping: group checkpoint artifacts by message id.
4. Conversation-only active-chain rewind with resume reconstruction.
5. Both mode with transactional ordering.
6. Compact-covered fork proposal path.
7. TUI message selector and mode picker.
8. ZCode app-server projection and non-interactive file rewind.

Each step is a separate feature-level commit with focused tests.

## Open questions

- Should message-level workspace checkpoints aggregate during tool execution or only in the rewind
  projection?
- Should conversation rewind update session permission/model state from the selected message, or only
  return it to the client as metadata?
- Should `/rewind latest` eventually mean the latest user message, or stay the latest workspace
  checkpoint for backwards compatibility?
- Do we need unrevert/redo, or is fork the recovery path for an accidental rewind?
- How much pre-compact scrollback should the selector expose by default?
