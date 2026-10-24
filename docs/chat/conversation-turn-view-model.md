# Conversation Turn View Model

The chat area must not squash real messages, user commands, runtime-only inputs and timeline lifecycle into one `ChatMessage[]` fact stream. The UI first normalizes by turn transaction, then generates render rows.

## Domain model

A `Conversation` consists of `Turn`s. A turn is one conversation transaction accepted by the main session and entered into the CLI/runtime. It is not a single user message, an assistant message or the Nth group in a UI array.

The authoritative turn identity is the CLI/runtime `turnId`. The display-only `turnOrdinal` / legacy `turnIndex` expresses "which round" and must not be a mutation target, timeline anchor or recovery source in the new protocol. Fork, edit, rewind, file summary and timeline placement should prefer `messageId`, `turnId`, `anchorTurnId` or `anchorMessageId`.

```ts
interface ConversationView {
  turns: TurnView[];
  rows: ConversationRenderRow[];
  lineageEvents: ConversationLineageEvent[];
}

interface TurnView {
  turnId: string;
  ordinal: number; // display only
  origin:
    | "user_prompt"
    | "queue_drain"
    | "turn_steer"
    | "goal_continuation"
    | "background_result"
    | "manual_compact";
  status: "running" | "settling" | "completed" | "interrupted" | "failed";
  visibleInputs: ConversationInput[];
  // Within one product turn, the original input and each accepted steer each open a visual work segment.
  // This is not a turn boundary; command target, fork/retry still anchor to the product turn's final body.
  workSegments: TurnWorkSegmentView[];
  modelOnlyInputs: RuntimeInput[];
  workLog: WorkLogItem[];
  assistantOutput?: AssistantOutput;
  postTurnEvents: PostTurnEvent[];
  actionTargets: TurnActionTargets;
}

interface TurnWorkSegmentView {
  segmentId: string;
  triggerInputId?: string;
  startedAt: number;
  endedAt?: number;
  activeMs?: number;
}
```

`status=settling` means the main assistant output is complete but the turn's completion-blocking post work has not settled (goal verifier, pre-continuation goal judgment, other foreground active work). The UI no longer shows the assistant as outputting, but the session may still have `sessionEnded=false`, and the stop button is still enabled by the session control projection.

```text
turn t1
|-- visibleInputs[]
|-- assistantOutput completed
`-- postTurnEvents[]
    `-- goal verify running

session control:
  sessionEnded = false
  canStop = true
  stopTargetKind = goalVerifier
```

## Row projection

The UI renders `rows[]`, not flat `ChatMessage[]` grouped by role + array position. `rows[]` is the product render-row index: it can reference a transcript message, timeline event, workLog item or lineage event, but is not a provider message.

```ts
type ConversationRowPlacement =
  | "inside_turn_input"
  | "inside_turn_assistant"
  | "inside_turn_worklog"
  | "after_turn"
  | "session_lineage";

interface ConversationRenderRow {
  rowId: string;
  turnId?: string;
  placement: ConversationRowPlacement;
  kind:
    | "input"
    | "assistant_output"
    | "tool"
    | "compact"
    | "goal_verification"
    | "fork"
    | "model_change"
    | "background_result";
  messageIds?: string[];
  timelineEventId?: string;
  workItemId?: string;
  anchorMessageId?: string;
  order: number;
}
```

```text
ConversationView
|-- turns
|   |-- t1 origin=user_prompt
|   `-- t2 origin=background_result
|
`-- rows
    |-- row:t1:input:user-msg-1             inside_turn_input
    |-- row:t1:assistant:assistant-msg-2    inside_turn_assistant
    |-- row:t1:compact:compact-op-1         inside_turn_worklog
    |-- row:t1:goal:target-a:1              after_turn
    |-- row:t2:input:bg-result-1            inside_turn_input
    `-- row:t2:assistant:assistant-msg-9    inside_turn_assistant
```

For new data the UI must not use "latest assistant", "latest user" or `Math.floor(index / 2)` to decide row ownership. For old data without an anchor the compatibility layer may generate a fallback row, marked as compatibility recovery and never a new-protocol fact.

## User input rules

Every explicitly submitted user command is a conversation event; the command's state side effect cannot replace the user input itself.

- First `/goal <objective>`: persist a visible user query and set the goal.
- Replace `/goal <objective>`: persist a visible user query and update the goal.
- Queued `/goal <objective>`: stays a queue item; when consumed, persist a visible user query and update the goal.
- Goal continuation reminder: runtime `modelOnlyInputs`, never rendered as a user bubble.
- Turn steering accepted: belongs to the current turn's `visibleInputs`, shown as a user addition to the current turn. Each accepted steer also opens a new visual work segment; the previous segment closes at the injection boundary, but both share the same `turnId` / `productTurnId`.
- Turn steering rejected or fallback queue: pending input of a future turn, not written into the current turn early.
- Background result returning to the main session: a new `origin=background_result` turn. The provider side may show `role=user`, but the product layer keeps `humanAuthored=false` and the background source, and opens no ordinary user edit semantics.

## Timeline classification

A timeline is not the parent of business data and must not pose as an ordinary assistant message. It is positioning information for a render row plus a product lifecycle event. Each timeline row declares a stable identity, fold policy, placement and anchor.

```ts
type TimelineFoldPolicy = "worklog" | "never";

interface TimelineRenderRow {
  key: string;
  timelineEventId: string;
  placement: "inside_turn_worklog" | "after_turn" | "session_lineage";
  foldPolicy: TimelineFoldPolicy;
  anchor:
    | { type: "inside_turn"; turnId: string }
    | { type: "after_turn"; turnId: string; assistantMessageId?: string }
    | { type: "after_message"; messageId: string }
    | { type: "session_start" };
}
```

| Timeline | placement | foldPolicy | Note |
| --- | --- | --- | --- |
| context compact | `inside_turn_worklog` | `worklog`, or visible while running | assistant worklog, does not split the turn |
| goal verification | `after_turn` | `never` | post-turn judge event of the verified turn |
| session fork | `session_lineage` | `never` | conversation lineage event, not assistant worklog |
| model change | `session_lineage` or `after_turn` | `never` | depends on whether a turn is anchored; new data must set placement explicitly |

### Compact

Context compaction is an intermediate step of an assistant turn and belongs to `workLog`:

- A completed auto compact may be folded by "worked for xxx".
- A running / retrying compact stays visible so the user sees the current state.
- Stable identity prefers `operationId`; local optimistic and agent lifecycle merge by `inputId` / `operationId`.

### Goal verify

A judge event after assistant output, in `postTurnEvents`:

- Must appear after the verified assistant output and never enters the "worked for xxx" fold.
- UI row key is `goal:${targetId}:iteration:${goalIteration}`. `verificationId` is a verifier attempt id for attempt details only, never a row key.
- started / completed / failed / cancelled of the same `targetId + goalIteration` update the same row.
- Verifier returning `passed: false` shows "not passed". Verifier JSON parse failure is a judge-chain fault: fail-open to `passed: true` by default, but the reason must keep the format-error cause for troubleshooting.

### Fork

A conversation lineage event, not assistant worklog:

- Never folded by "worked for xxx".
- With `targetMessageId`, can jump back to the parent session's source message.
- Old data with only `parentSessionId` recovers a non-navigable fallback row.

## History recovery

New data provides strong anchors:

- message: `turnId`, or unambiguously attributable by projection to a `turnId`
- timeline: `timelineEventId`, `anchorTurnId`, optional `anchorMessageId`
- goal verify: `anchorTurnId`, optional `anchorAssistantMessageId`
- fork: `targetMessageId`, optional current-session `anchorTurnId`

Old data without an anchor may use time and the nearest assistant as fallback, only for legacy history and never as a source of fact for new data.

## Invariants

- `turnId` is the CLI/runtime authoritative identity; `turnIndex` / `ordinal` are display only.
- History targets in the new protocol prefer `messageId` or `turnId`; fall back to `turnIndex` only for old data.
- Timeline placement comes from projection; the UI must not infer it from array index or recent message.
- A row has exactly one placement; started/completed/failed/cancelled updates of one timeline identity land on the same row.
- Background work does not block the current turn's completion; a background result returning to main opens a new foreground turn.

## Multi-end boundary

This model does not change task realtime ownership:

- Desktop keeps `desktop-continuous` direct realtime.
- Mobile Web remote keeps `web-remote-replayable` snapshot / gap recovery.
- The relay and main process own no session, stream, queue, snapshot or timeline business state.
