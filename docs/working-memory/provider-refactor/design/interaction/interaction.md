# How Model Selection Enters an Execution

The input box's model selection expresses the user's intent for the next submission. On submit, the
selection is fixed with the Submission; when execution starts, the Session records the Selection for
subsequent continuation; the Agent Loop creates and holds the Model that truly initiates requests.

```text
Composer Selection
        |
        | submit
        v
Submission ModelSelection
        |
        | start Agent Loop
        v
Session Selection
        |
        | ModelFactory (Registry lookup / validate)
        v
Active Model
```

This chain separates "which one we want to use next" from "which one is currently being used." The model
selector always serves the next submission; the running model is expressed by an independent execution
state.

## A Normal Path for a Message

Session last used model A; the user selects model B and sends a message:

```text
Session Selection = A
Active Model = A

User selects B in the Composer
        |
        v
Submit prompt + ModelSelection B
        |
        v
Core receives full Submission
        |
        v
Start new Agent Loop
├─ Session Selection: A -> B
├─ Registry creates Model B based on B
└─ Active Model = B
        |
        v
This Loop's model requests use Model B
```

If Provider Config or Registry changes during the Loop, the already-created Model is not modified. The
current Registry is re-read when creating the next Model, so new configurations take effect from the next
segment of execution.

## Three Core States

| State              | Meaning                                            | Owner            | Lifecycle                                                     |
| ------------------ | -------------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| Composer Selection | Which model we want to use for the next submission | Entry's Composer | Editable before submission                                    |
| Session Selection  | Which model the Session continues to use           | Session Store    | Updated when submission starts executing or Guide is received |
| Active Model       | The model truly called by the current Loop         | Agent Loop       | Held within Loop; switchable at Step boundary by Guide        |

Draft is the persistent carrier of the Composer state. Workspace App Recent and Host `preferredSelection`
only provide the initial Selection for the Composer; they do not participate in current model requests;
`preferredSelection` already includes the Host's atomic resolution of Configured Default and Fallback
Policy.

```text
Draft / workspace Recent / Host preferred
                 |
                 | initialize
                 v
        Composer Selection
                 |
                 | submit
                 v
       Submission Selection
                 |
                 | accepted for execution
                 v
         Session Selection
                 |
                 | create
                 v
            Active Model
```

Persistence scope per state and initialization rules for App, TUI, and Prompt CLI:
[`selection-state.md`](./selection-state.md).

## Receive Method Determines Update Time

The same Submission can start immediately, enter the Queue, or enter the current Loop as a Guide. Selection
always belongs to the Submission; the receive method only changes when it becomes Session and execution
state.

```text
CoreSubmission B
├─ start now
│  └─ Start Loop B, Session Selection and Active Model updated to B
│
├─ queue
│  └─ Save B completely; update Session and Model only when truly dequeued and started
│
└─ Guide / Immediate
   └─ After current Loop receives, Session updates to B, subsequent Model Step uses Model B
```

The diagram above describes normal user Submissions. Idle tasks are a special `start-now`: the Submission
still carries a standard `ModelSelection`, but the execution context explicitly applies it to this Loop only.
Core uses the same Registry and ModelFactory to create an idle Model, writes no App Recent, changes no
Session Selection, and enters no ordinary Queue; Core directly rejects when busy.

App state changes:

| Event                                           | App Recent | Session Selection | Active Model                                                 |
| ----------------------------------------------- | ---------- | ----------------- | ------------------------------------------------------------ |
| Loop A is executing, user selects B in Composer | A          | A                 | A                                                            |
| Submission B is received and enters Queue       | B          | A                 | A                                                            |
| B in Queue starts executing                     | B          | B                 | B                                                            |
| Guide C is received by current Loop             | C          | C                 | Current request keeps original Model, subsequent Steps use C |

App Recent updates when the App confirms the Submission is received as start-now, queue, or Guide. Session
Selection updates when the Submission truly starts the Loop, or when the current Loop receives it as a
Guide. Prompt CLI and TUI do not read/write App Recent.

Complete timing for Queue, Guide, and derived submissions: [`submission-delivery.md`](./submission-delivery.md).

## Composer's Initial Selection

When creating or restoring a Composer, the Entry takes the initial value from states it owns:

| Scenario                   | Initialization Order                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| App new Session            | Draft -> Workspace App Recent still selectable in current Host View -> Host preferred |
| TUI new Session            | Draft -> domain preferred                                                             |
| App / TUI restore Session  | Draft -> Session Selection                                                            |
| Prompt CLI new Session     | Explicit model parameter -> domain preferred                                          |
| Prompt CLI restore Session | Explicit model parameter -> Session Selection                                         |

Initialization happens only when creating or restoring a Composer. While the Composer is alive, the editing
memory state prevails; Provider Registry updates can mark the current selection as unavailable but will not
silently replace a user's unsubmitted selection.

## Queue and Guide

Queue items save the complete Submission, including the ModelSelection determined at that time. Reordering
the Queue does not change Selection; clicking "Immediate" uses the Queue item's own Selection, not the
current Composer value.

Guide and the product's "Immediate" use the same Core semantics. After a Guide is received, Context
injection, Session Selection update, and Active Model switching form an atomic change. Already-issued
requests continue on the old Model; the new Model is used from the next Model Step. When creating the new
Model or injecting fails, the complete Submission is retained as an ordinary Queue item.

## Edit, Retry, and Runtime Display

Edit and Retry derive from existing Submissions and default to inheriting the source Submission's
ModelSelection. They do not read the current Composer Selection; a future "retry with current model" must
explicitly carry a new Selection in the new Submission.

The model selector keeps displaying the Selection for the next submission. The current execution model, idle
task model, and Guide switch results are runtime states displayed in execution details or a dedicated
banner; they do not write back to the model selector to simulate runtime state.

## Stable Constraints

- prompt, attachments, mode, and ModelSelection are received as one Submission.
- Queue and Guide use the Selection already fixed in the Submission.
- Sessions persist only ModelSelection, never Model.
- Usage, Trace, and errors read the Model that truly initiated the request.
- Composer Selection, Session Selection, and Active Model have independent write events; they are not
  projections of each other.
- Idle tasks still carry only a standard ModelSelection; Request Auth, Ticket, attribution, and Subagent
  override are execution context (see [`../execution/execution.md`](../execution/execution.md)). They form
  no second set of Execution Model, Selection, or temporary Provider static config.

## Sub-documents

- [`selection-state.md`](./selection-state.md): ownership, memory and persistence carriers of Selection
  states, and initialization rules per Entry.
- [`submission-delivery.md`](./submission-delivery.md): receipt and state-update timing for CoreSubmission,
  start-now, Queue, Guide, Edit, and Retry.
