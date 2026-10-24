# Conversation Transcript Storage

Status: implemented. Migrations `0014_message_part_sequence` and `0015_message_part_sequence_backfill_and_guard` provide stable ordering, contracts declare `MessageSemantics` / `TimelinePart`, and V4 hydration consumes timeline parts.

## Model

The transcript model is `session -> message -> part`. A timeline entry (compact, fork, goal verification, model change) is a structured `part` of a message, not a separate table, `session_entry`, renderer-store item or text metadata:

```text
message.parts[] includes { type: "timeline", ... }
```

The timeline payload is not free-form JSON. It lives in `part.data`, but TypeScript types and Zod protocol schemas declare it; runtime writes, snapshot recovery and UI rendering consume only that structure.

| Principle | Rule |
| --- | --- |
| Timeline is a part | compact, fork, goal verification and model change are written as `part.type="timeline"`. |
| Role and product semantics are separate | `message.role` is only the provider role; real user, model-only reminder, command and timeline are declared by explicit fields. |
| Explicit order | Render order of messages and parts never depends on id lexical order. |
| Old data stays readable | New builds recover from legacy compaction parts, fork text metadata, goal `session_entry` rows. |

## Database

The existing `message` / `part` tables stay; data remains in `data` JSON. Only ordering is added.

```sql
alter table message add column sequence integer;
create index if not exists message_session_sequence_idx
  on message(session_id, sequence, time_created, id);

alter table part add column sequence integer;
create index if not exists part_message_sequence_idx
  on part(message_id, sequence, time_created, id);
create index if not exists part_session_sequence_idx
  on part(session_id, message_id, sequence);
```

- `message.sequence` is the stable render order within a session; `part.sequence` is the stable order within a message.
- A new row gets `max(sequence) + 1` of its session (message) or message (part), assigned inside the write transaction. Updating a row keeps its sequence.
- Backfill freezes the old order: `time_created, rowid` for messages; `message_id, time_created, rowid/id` for parts.
- Read order is `sequence is null, sequence, time_created, rowid|id` (parts: `id`), so unbackfilled rows fall back to the old order.

## Message semantics

`UserMessageInfo` and `AssistantMessageInfo` carry an optional `semantics` field stored in `message.data` (it describes the message itself, so no extra table).

```ts
interface MessageSemantics {
  origin: "real_user" | "agent_runtime" | "system" | "migration";
  kind:
    | "user_prompt"
    | "slash_command"
    | "system_reminder"
    | "background_notification"
    | "subagent_notification"
    | "todo_reminder"
    | "rewind_notice"
    | "fork_notice"
    | "timeline_event"
    | "compact_summary"
    | "assistant_response";
  source?: string;
  commandName?: string;
  uiVisibility: "visible" | "hidden" | "debug";
  providerVisibility: "visible" | "hidden";
  transcriptVisibility: "visible" | "hidden";
}
```

New writes must set `semantics`. The legacy fields (`synthetic`, `source`, `visibility`, text part metadata `source` / `visibility` / `runtimeMessage`) are kept during the compatibility window and used only for legacy fallback.

| Data | origin | kind | uiVisibility | providerVisibility |
| --- | --- | --- | --- | --- |
| Ordinary user input | real_user | user_prompt | visible | visible |
| Visible `/goal xxx` command | real_user | slash_command | visible | visible |
| `/compact` operation | real_user | slash_command | hidden | hidden |
| goal continuation | agent_runtime | system_reminder | hidden | visible |
| background task notification | agent_runtime | background_notification | hidden | visible |
| subagent notification | agent_runtime | subagent_notification | hidden | visible |
| todo reminder | agent_runtime | todo_reminder | hidden | visible |
| timeline carrier | system | timeline_event | visible | hidden |
| compact summary context | agent_runtime | compact_summary | hidden | visible |
| assistant text | agent_runtime | assistant_response | visible | visible |

## Timeline part

```ts
type TimelinePart =
  | ContextCompactionTimelinePart
  | GoalVerificationTimelinePart
  | SessionForkTimelinePart
  | ModelChangeTimelinePart;

interface TimelinePartBase {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "timeline";
  timelineType:
    | "context_compaction"
    | "goal_verification"
    | "session_fork"
    | "model_change";
  display: "separator" | "worklog";
  status?: string;
  anchorMessageId?: MessageId;
  anchorTurnId?: TurnId;
  time?: {
    start?: number;
    end?: number;
  };
}

interface ContextCompactionTimelinePart extends TimelinePartBase {
  timelineType: "context_compaction";
  operationId: string;
  trigger: "manual" | "auto" | "reactive" | "partial" | "session_memory";
  phase?: "standalone_turn" | "pre_request" | "mid_turn" | "reactive";
  compactReason?: string;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}

interface GoalVerificationTimelinePart extends TimelinePartBase {
  timelineType: "goal_verification";
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  verification?: {
    passed: boolean;
    reason: string;
    nextAction?: string | null;
  };
}

interface SessionForkTimelinePart extends TimelinePartBase {
  timelineType: "session_fork";
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

interface ModelChangeTimelinePart extends TimelinePartBase {
  timelineType: "model_change";
  fromModel?: {
    providerId: string;
    modelId: string;
    variant?: string;
    label?: string;
  };
  toModel: {
    providerId: string;
    modelId: string;
    variant?: string;
    label: string;
  };
}
```

## Write rules

Every timeline part hangs on a message.

| Case | message | part |
| --- | --- | --- |
| manual compact | synthetic assistant carrier | `timeline/context_compaction` |
| auto compact | current or synthetic assistant carrier, per existing worklog semantics | `timeline/context_compaction` |
| fork notice | synthetic user or assistant carrier in the fork child (legacy fork notice kept during compat window) | `timeline/session_fork` |
| goal verifier | synthetic assistant carrier anchored to the verified assistant | `timeline/goal_verification` |
| model change | synthetic assistant carrier inserted before the next accepted user input | `timeline/model_change` |

- started -> completed/failed/interrupted updates the same timeline part. `part.id` is identity, `part.sequence` is position; an update never changes sequence.
- Stable identity per kind:
  - compact: `operationId`
  - goal verification: `targetId + goalIteration`, or `verificationId` when there is no iteration
  - fork: `parentSessionId + targetMessageId + targetCheckpointId`
  - model change: `task/session + createdAt + requestId`
- Model change is first recorded as pending and written only before the next accepted user input. Switching without sending does not pollute the transcript.
- Timeline payloads are created through contracts types; business paths do not hand-write JSON. A runtime persistence helper creates the carrier message, assigns part identity and sequence, and upserts.

## Compatibility

New builds reading old data canonicalize on the read side only:

1. Missing message/part sequence: fall back to the old order (optionally backfill in the background).
2. Missing `semantics`: derive from `synthetic/source/visibility/part.metadata/runtimeMessage`.
3. Legacy compaction part -> projected as `timeline/context_compaction`.
4. Legacy fork text metadata -> `timeline/session_fork`.
5. Legacy goal verifier `session_entry` -> `timeline/goal_verification`.
6. Legacy model change existed only in renderer memory; no history recovery.

Downgrade window: during the compatibility period compact keeps dual-writing the old `compaction` part, fork keeps the old synthetic notice metadata, goal verifier keeps writing `session_entry`, and `semantics` writes keep the old `synthetic/source/visibility` fields. Old builds that do not know `part.type="timeline"` may display the new timeline incompletely; that is display loss only and does not affect new-build reads. Removing legacy writes needs a separate compatibility-window decision.

Guaranteeing that old builds never meet an unknown part type would require first shipping a transition build that tolerates unknown parts; otherwise only "new reads old" is guaranteed.

## Read path

1. Messages are read by `sequence`; parts by `message_id, sequence`.
2. `mapMessagePart` recognizes `type="timeline"` and maps it directly to the protocol.
3. Compact recovery recognizes both timeline and legacy compaction parts. Goal verification cold start prefers the timeline part and falls back to `session_entry`.
4. Desktop continuous and web remote replayable both recover from the same session snapshot; timeline state is never pushed down to relay/main.
5. Legacy compaction/`session_entry`/text-metadata fallbacks stay until UI projection consumes timeline parts as the primary source and that is verified.

## Code map

| Layer | Files |
| --- | --- |
| migration | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` |
| rows/repositories | `apps/zcode-cli/packages/adapters/src/storage/session-store/rows.ts`, `repositories/messages.ts` |
| contracts | `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts` |
| runtime writes | `apps/zcode-cli/packages/core/src/runtime/methods/message-persistence.ts`, `compact-persistence.ts`, `session-fork.ts`, `events.ts`, model set path |
| protocol | `packages/shared/src/zcode-protocol/index.ts`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts` |
| shared read compatibility | `packages/shared/src/zcode-session-visible-content.ts`, `packages/shared/src/zcodePersistedMessageMerge.ts` |
| V4 transcript hydration | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`, `product-projection.ts` |
| UI projection | `packages/ui/src/v4/conversationProjectionStore.ts`, `packages/ui/src/v4/sessionDataLayer.ts` |

## Required tests

- Old DB without sequence: order unchanged after startup.
- Old same-millisecond messages: sequence/fallback freezes the old `rowid` order; same-millisecond parts keep a stable order.
- Legacy compact part, fork notice and goal verifier `session_entry` are recognized by the CLI/shared read path without breaking the snapshot.
- New compact/fork/goal/model writes appear in the snapshot as `part.type="timeline"`.
- Desktop continuous and web remote replayable recover only from the agent/session snapshot; no timeline state in relay/main.

## Open questions

- Whether full binary downgrade compatibility is required (needs the unknown-part-tolerant transition build first).
- Whether model change persistence stays fixed at "before the next accepted user input". Persisting at switch time would let mere trial selections pollute the history timeline.
- Whether the compact worklog/boundary classification only affects UI projection or must also be persisted. Current design persists `display` so the UI does not infer it.
