# Submission Receipt and Delivery

CoreSubmission deterministically captures complete intent for a single input:

```ts
interface CoreSubmission {
  prompt: string;
  modelSelection: ModelSelection;
  attachments?: readonly SubmissionAttachment[];
  mode?: AgentMode;
}
```

Special executions may carry additional execution context, but they do not change the principle that prompt, attachments, mode, and the single ModelSelection must be received atomically. The Request Auth, Ticket, attribution info, and Subagent override for idle tasks are defined by the execution design; they do not form a second set of Selection, and Submissions do not carry complete ProviderConfig or ModelConfig.

## Start now

When Core is idle, the Submission directly starts a new Agent Loop:

```text
Submission B accepted
        |
        +-- Session Selection = B
        +-- Registry creates Model B
        `-- Start Agent Loop B
```

If the Model cannot be created, the Submission does not merely update Session Selection. Corresponding state changes are submitted only after creation and start succeed.

### Special start-now: Idle tasks

Idle Submissions also carry a standard ModelSelection, but the execution context marks them as only applying to the current Loop:

```text
Idle Submission accepted while Core is idle
        |
        +-- App Recent: unchanged
        +-- Session Selection: unchanged
        +-- Registry creates idle Model
        +-- Request Auth injected during request period
        `-- Start idle Agent Loop
```

This is not a temporary Provider, nor a second ModelFactory. When Core is busy, idle Submissions are directly rejected and do not enter the ordinary Queue; after they end, there is no need to "restore" Session Selection because this state was never rewritten before execution.

## Queue

### Todo151: Submission field fidelity

The CLI's `TurnInputIntentMetadata -> QueueItem -> TurnInputIntentMetadata` must preserve model selection, permissions, attachments/shared context, and source association. QueueItem is a protocol projection, simultaneously read by the elevated execution path; field omissions cannot be treated as mere display issues. In-place editing only modifies the body; reordering does not change content; automatic/manual elevation preserves the original sourceCommandId. Compatibility with old events can preserve the same item's existing fields; reading the current Composer or mutable Session to fabricate new selections is not allowed. New Plan states are passed along the same path, and `false` differs from missing. Do not introduce Host queues or new scheduling/replay semantics.

When Core is busy, Queue items save the complete Submission:

```text
Queued Submission
├─ prompt
├─ attachments
├─ mode
└─ ModelSelection
```

When entering the Queue, the App can update App Recent; Session Selection and Active Model keep their current execution values. The Session Selection is updated and the Model is created only when the Queue item is truly dequeued and starts a new Loop.

Queue reordering does not change any Submission content. If the product allows editing the model of queued items in the future, the operation needs to directly modify the ModelSelection of that Queue item, forming a traceable explicit event.

## Guide and "Immediate"

Guide is the Core semantics for "Immediate" entering the current Agent Loop:

```text
Active Loop
├─ Session Selection A
└─ Active Model A
          +
Guide Submission B
          |
          | Create Model B and complete admission
          v
Active Loop
├─ Context adds Guide input
├─ Session Selection A -> B
└─ Active Model A -> B
```

Context injection, Session Selection update, and Active Model switching form a single receipt result. When creating the Model, injecting Context, or admission fails, do not submit only part of it; the complete Submission falls into the ordinary Queue.

Already-issued model requests continue to be completed by Model A, with Usage attributed to A. The switch occurs at the Model Step boundary; subsequent Steps and subsequent automatic Compact use Model B.

"Immediate" can come from the current Composer or from an existing Queue item. In both cases, the Selection already saved by the target Submission is used, not the current selection in the Composer at the moment of clicking.

## App Recent and Session Selection

```text
App accepts Submission
├─ start-now -> update App Recent
├─ queue     -> update App Recent
└─ Guide     -> update App Recent

Core begins executing Submission
├─ start new Loop -> update Session Selection
└─ accept Guide   -> update Session Selection
```

These two time points solve different problems: App Recent serves the next new App Session; Session Selection serves the continued execution of the current Session. Submissions that are queued but not yet executed do not prematurely change Session Selection.

## Edit and Retry

Edit and Retry take existing Submissions as their source:

```text
Source Submission
├─ prompt X
└─ ModelSelection A
        |
        ├─ Edit  -> prompt Y + ModelSelection A
        └─ Retry -> prompt X + ModelSelection A
```

Default inheritance of the source Selection ensures the operation is not affected by the current Composer state. If the product adds "retry with current selection," this command should explicitly provide a new ModelSelection and generate a new complete Submission.

## Receive Constraints

- The Submission's Selection is fixed at Entry submission.
- start-now, Queue, and Guide share the same Submission type.
- App Recent updates do not represent that the Submission has started execution.
- Session Selection updates must be consistent with execution receipt.
- Active Model switching does not modify the old Model, nor re-attribute already-issued requests.
- Delivery failures retain the complete Submission, leaving no intermediate results with only partially updated state.
- Idle special start-now does not write App Recent or Session Selection, nor enters the ordinary Queue.
