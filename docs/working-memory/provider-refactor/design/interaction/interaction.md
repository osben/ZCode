# How Model Selection Enters an Execution

The model selection in the input box expresses the user's intent for the next submission. After the message is submitted, this selection is fixed with the Submission; when the Submission starts executing, the Session records the Selection for subsequent continuation, and the Agent Loop creates and holds the Model that truly initiates requests.

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

This chain separates "which one we want to use next" from "which one is currently being used." The model selector always serves the next submission; the running model is expressed by an independent execution state.

## A Normal Path for a Message

Assume the Session last used model A, the user selects model B in the input box, and then sends a message:

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

If Provider Config or Registry changes during Loop execution, the already-created Model is not modified. The current Registry is re-read when creating the next Model, so new configurations take effect from the next segment of execution.

## Three Core States

| State              | Meaning                                            | Owner            | Lifecycle                                                     |
| ------------------ | -------------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| Composer Selection | Which model we want to use for the next submission | Entry's Composer | Editable before submission                                    |
| Session Selection  | Which model the Session continues to use           | Session Store    | Updated when submission starts executing or Guide is received |
| Active Model       | The model truly called by the current Loop         | Agent Loop       | Held within Loop; switchable at Step boundary by Guide        |

Draft is the persistent carrier of the Composer state. Workspace App Recent and Host `preferredSelection` are only responsible for providing the initial Selection for the Composer; they do not participate in current model requests; `preferredSelection` already includes the Host's atomic resolution of Configured Default and Fallback Policy.

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

The persistence scope of each state and the initialization rules for App, TUI, and Prompt CLI are documented in [`selection-state.md`](./selection-state.md).

## Receive Method Determines Update Time

The same Submission can start immediately, enter the Queue, or enter the current Loop as a Guide. Selection always belongs to the Submission; different receive methods only change when it becomes Session and execution state.

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

The diagram above describes normal user Submissions. Idle tasks are a special `start-now`: the Submission still carries a standard `ModelSelection`, but the execution context explicitly specifies it only applies to this Loop. Core uses the same Registry and ModelFactory to create an idle Model, does not write App Recent, does not change Session Selection, and does not enter the ordinary Queue; Core directly rejects when busy.

Taking the App as an example, state changes are as follows:

| Event                                           | App Recent | Session Selection | Active Model                                                 |
| ----------------------------------------------- | ---------- | ----------------- | ------------------------------------------------------------ |
| Loop A is executing, user selects B in Composer | A          | A                 | A                                                            |
| Submission B is received and enters Queue       | B          | A                 | A                                                            |
| B in Queue starts executing                     | B          | B                 | B                                                            |
| Guide C is received by current Loop             | C          | C                 | Current request keeps original Model, subsequent Steps use C |

App Recent updates when the App confirms the Submission is received as start-now, queue, or Guide. Session Selection is updated when the Submission truly starts the Loop, or when the current Loop receives it as a Guide. Prompt CLI and TUI do not read/write App Recent.

The complete timing for Queue, Guide, and derived submissions is documented in [`submission-delivery.md`](./submission-delivery.md).

## Composer's Initial Selection

When creating or restoring a Composer, the Entry obtains the initial value from states it has authority over:

| Scenario                   | Initialization Order                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| App new Session            | Draft -> Workspace App Recent still selectable in current Host View -> Host preferred |
| TUI new Session            | Draft -> domain preferred                                                             |
| App / TUI restore Session  | Draft -> Session Selection                                                            |
| Prompt CLI new Session     | Explicit model parameter -> domain preferred                                          |
| Prompt CLI restore Session | Explicit model parameter -> Session Selection                                         |

Initialization only occurs when creating or restoring a Composer. While the Composer is alive, the editing memory state prevails; Provider Registry updates can mark the current selection as unavailable, but will not silently replace a user's unsubmitted selection.

## Queue and Guide

Queue items save the complete Submission, including the ModelSelection determined at that time. Reordering the Queue does not change Selection; clicking "Immediate" also uses the Queue item's own Selection, not the value in the current Composer.

Guide and the "Immediate" in the product use the same Core semantics. After a Guide is received, Context injection, Session Selection update, and Active Model switching form an atomic change. Already-issued requests continue to be completed by the old Model; the new Model is used from the next Model Step. When creating a new Model or injection fails, the complete Submission is retained as an ordinary Queue item.

## Edit, Retry, and Runtime Display

Edit and Retry are derived from existing Submissions, defaulting to inheriting the source Submission's ModelSelection. They do not read the current Composer Selection; if the product supports "retry with current model" in the future, a new Selection must be explicitly carried in the new Submission.

The model selector continues to display the Selection for the next submission. The current execution model, idle task model, and Guide switch results are runtime states that can be displayed in execution details or a dedicated banner; they do not write back to the model selector to simulate runtime state.

## Stable Constraints

- prompt, attachments, mode, and ModelSelection are received as one Submission.
- Queue and Guide use the Selection already fixed in the Submission.
- Sessions only persist ModelSelection, not Model.
- Usage, Trace, and errors read the Model that truly initiated the request.
- Composer Selection, Session Selection, and Active Model each have independent write events; they do not serve as projections of each other.
- Idle tasks still only carry a standard ModelSelection; Request Auth, Ticket, attribution info, and Subagent override are execution context, see [`../execution/execution.md`](../execution/execution.md). They do not form a second set of Execution Model, Selection, or temporary Provider static config.

## Sub-documents

- [`selection-state.md`](./selection-state.md) explains the ownership, memory and persistence carriers of Selection states, and initialization rules for different Entries.
- [`submission-delivery.md`](./submission-delivery.md) explains the receipt and state update timing for CoreSubmission, start-now, Queue, Guide, Edit, and Retry.
