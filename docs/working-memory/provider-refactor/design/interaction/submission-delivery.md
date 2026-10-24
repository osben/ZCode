# Submission Receipt and Delivery

CoreSubmission deterministically captures the complete intent of a single input:

```ts
interface CoreSubmission {
  prompt: string;
  modelSelection: ModelSelection;
  attachments?: readonly SubmissionAttachment[];
  mode?: AgentMode;
}
```

Special executions may carry additional execution context, but prompt, attachments, mode, and the single
ModelSelection are always received atomically. The Request Auth, Ticket, attribution, and Subagent override
for idle tasks are defined by the execution design; they form no second Selection, and Submissions carry no
complete ProviderConfig or ModelConfig.

## Start now

When Core is idle, the Submission directly starts a new Agent Loop:

```text
Submission B accepted
        |
        +-- Session Selection = B
        +-- Registry creates Model B
        `-- Start Agent Loop B
```

If the Model cannot be created, the Submission does not merely update Session Selection; corresponding state
changes are submitted only after creation and start succeed.

### Special start-now: Idle tasks

Idle Submissions also carry a standard ModelSelection, but the execution context marks them as applying to
the current Loop only:

```text
Idle Submission accepted while Core is idle
        |
        +-- App Recent: unchanged
        +-- Session Selection: unchanged
        +-- Registry creates idle Model
        +-- Request Auth injected during request period
        `-- Start idle Agent Loop
```

This is not a temporary Provider, nor a second ModelFactory. When Core is busy, idle Submissions are directly
rejected and do not enter the ordinary Queue; after they end there is nothing to "restore" because Session
Selection was never rewritten.

## Queue

### Todo151: Submission field fidelity

The CLI's `TurnInputIntentMetadata -> QueueItem -> TurnInputIntentMetadata` must preserve model selection,
permissions, attachments/shared context, and source association. QueueItem is a protocol projection,
simultaneously read by the elevated execution path; field omissions are not mere display issues. In-place
editing modifies only the body; reordering does not change content; automatic/manual elevation preserves the
original sourceCommandId. Compatibility with old events may preserve the same item's existing fields;
reading the current Composer or a mutable Session to fabricate new selections is not allowed. New Plan
states pass along the same path, and `false` differs from missing. Introduce no Host queues or new
scheduling/replay semantics.

When Core is busy, Queue items save the complete Submission: `prompt`, `attachments`, `mode`,
`ModelSelection`.

When entering the Queue, the App may update App Recent; Session Selection and Active Model keep their
current execution values. Session Selection is updated and the Model created only when the Queue item is
truly dequeued and starts a new Loop.

Queue reordering does not change any Submission content. If the product later allows editing queued items'
models, the operation directly modifies that Queue item's ModelSelection as a traceable explicit event.

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

Context injection, Session Selection update, and Active Model switching form a single receipt result. When
creating the Model, injecting Context, or admission fails, do not submit only part of it; the complete
Submission falls into the ordinary Queue.

Already-issued model requests continue to be completed by Model A, with Usage attributed to A. The switch
occurs at the Model Step boundary; subsequent Steps and subsequent automatic Compact use Model B.

"Immediate" can come from the current Composer or an existing Queue item. Both use the Selection already
saved by the target Submission, not the current Composer selection at the moment of clicking.

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

These two time points solve different problems: App Recent serves the next new App Session; Session
Selection serves the continued execution of the current Session. Submissions queued but not yet executed do
not prematurely change Session Selection.

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

Default inheritance of the source Selection keeps the operation independent of the current Composer state.
A future "retry with current selection" command must explicitly provide a new ModelSelection and generate a
new complete Submission.

## Receive Constraints

- The Submission's Selection is fixed at Entry submission.
- start-now, Queue, and Guide share the same Submission type.
- App Recent updates do not mean the Submission has started executing.
- Session Selection updates must be consistent with execution receipt.
- Active Model switching does not modify the old Model or re-attribute already-issued requests.
- Delivery failures retain the complete Submission, leaving no intermediate results with only partially
  updated state.
- Idle special start-now writes no App Recent or Session Selection and enters no ordinary Queue.
