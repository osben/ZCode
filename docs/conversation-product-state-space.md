# Conversation Product State Space

Goal: combine the conversation product's compact, fork, goal, message queue, query editing, and related features into an executable product state-space model. The model enumerates the user's possible next steps in the GUI, prunes them with product rules, and outputs trace cases for human review and E2E conversion.

Basic protocol concepts live in [Conversation Behavior Protocol Declaration](./conversation-protocol-declaration.md). This document defines node types, input events, decisions, rules, invariants, and case-review semantics; the visualization page is just one view of this protocol expanded.

## Why not an ordinary flowchart

The conversation GUI is not a single-line flow. At any moment the user may keep typing, trigger `/compact`, set a goal, fork a turn, edit a query, or click a historical turn, while the system simultaneously completes a run, finishes a compact, enters goal verification, or returns an async error.

So the model's basic shape is:

```text
product context × user action × target × system phase -> guard -> effect -> next product context
```

Auxiliary conversation parameter commands are parent-scoped creation actions, not ordinary parent input:

```text
parent composer `/btw <text>`
  -> App command parser (text-only, CLI same-name wins)
  -> createSelectionSideSession(parent, firstInput=<text>)
  -> child registration + child startNow
  -> open child tab
  -> parent active turn/queue unchanged
```

This is not a pure mathematical Cartesian product. The product only enumerates candidate combinations; guards and effects are the actual product requirements.

## First-version modeling scope

State dimensions. `compacting` and `goalVerifying` are no longer top-level phases; they are completion-blocking active work inside `running`:

| Dimension         | Values                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| runPhase          | draft, prewarming, running, completed(success/interrupted), error                               |
| activeWork        | none, primaryTurn, foregroundSubagent, compact, goalVerifier, goalContinuation, turnSteer       |
| queue             | empty, text, goal, compact, mixed                                                               |
| queueAutoDrain    | true, false                                                                                     |
| queueAuthority    | cliCommandInbox (shared by desktop/mobile; other values pruned as invalid)                      |
| followupDelivery  | queue, guide, guideFallbackQueue                                                                |
| deliveryProfile   | desktopContinuous, mobileReplayable                                                             |
| forkTarget        | completedSuccessFinalAssistant, middleAssistant, streamingPartial, failedPartial, nonAssistant  |
| compactMemory     | never, compactable, justCompacted, notNeeded                                                    |
| canCompactAgain   | true, false                                                                                     |
| goal              | none, active, paused, budgetLimited, complete                                                   |
| verifierTerminal  | none, explicitPass, failOpenPass, failedContinue, manualCancel                                  |
| selectedTurn      | latest, old                                                                                     |
| toolShape         | none, singleReadonlyTool, parallelTools, activeTool, completedTool, failedTool, interactionTool |
| toolResultBatch   | none, pending, committed                                                                        |
| modelConfig       | native, customProvider, sameModelDifferentProvider                                              |
| modelMarkerSource | adjacentTurnSwitch, explicitSourceLessBoundary, none                                            |
| collaborationMode | build, edit, plan, yolo                                                                         |

User actions:

| Action        | Target                                |
| ------------- | ------------------------------------- |
| sendText      | current input box                     |
| slashCompact  | typing `/compact` in the input box    |
| setGoal       | goal control or prompt                |
| compact       | compact button/command                |
| fork          | latest turn, old turn                 |
| editQuery     | latest turn, old turn                 |
| sendQueuedNow | queue item                            |

System events:

| Event             | Applicable phase                          |
| ----------------- | ----------------------------------------- |
| assistantComplete | running                                   |
| compactComplete   | activeWork=compact                        |
| compactNoop       | activeWork=compact                        |
| goalVerifyPass    | activeWork=goalVerifier                   |
| goalVerifyFail    | activeWork=goalVerifier                   |
| goalVerifyFailOpen| activeWork=goalVerifier                   |
| goalVerifyCancel  | activeWork=goalVerifier                   |
| toolBatchComplete | activeWork=primaryTurn/goalContinuation  |

## First batch of product rules

These rules come from current product expectations. In the model they are executable guards, not comments.

| Scenario                                                        | Result                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| running + sendText                                              | enters the message queue                                                                                                                                                  |
| running + `/compact`                                            | enters the CLI FIFO as a compact maintenance intent; does not interrupt the current active work                                                                            |
| running + setGoal                                               | enters the message queue                                                                                                                                                  |
| running + fork completedSuccessFinalAssistant                   | allow, conversation-only fork; parent keeps running, shared workspace does not rewind                                                                                      |
| running + fork middle/streaming/failed/nonAssistant             | reject, the target is not a stable logical turn boundary                                                                                                                   |
| running + edit latest query                                     | allow, stop the current active work first, then rerun from the last turn's query                                                                                           |
| running + edit old query                                        | reject, only the last turn's real user query may be edited                                                                                                                 |
| completed + fork                                                | allow                                                                                                                                                                      |
| completed + compact                                             | allow, enters compacting                                                                                                                                                  |
| completed + compact after fork                                  | allow                                                                                                                                                                      |
| activeWork=goalVerifier + compact                               | enqueue; execute by FIFO after the whole goal completion chain ends                                                                                                        |
| activeWork=goalVerifier + fork stable                           | allow, may fork an earlier stable history; does not copy the verifier                                                                                                      |
| activeWork=compact + compact                                    | reject, a compact is in progress                                                                                                                                           |
| activeWork=compact + sendText/setGoal                           | enqueue to the CLI FIFO; does not interrupt the compact                                                                                                                    |
| activeWork=compact + fork                                       | reject, compact operation lock                                                                                                                                             |
| justCompacted + compact + canCompactAgain                       | allow, enters compacting                                                                                                                                                  |
| justCompacted + compact + !canCompactAgain                      | reject, notify that a compact just finished and none is needed                                                                                                             |
| completedTool + compact                                         | allow, tool history participates in the compaction context as an ordinary completed assistant turn                                                                         |
| completedTool + fork                                            | allow, the fork point must include the tool call blocks and tool result projections                                                        |
| completedTool + setGoal                                         | allow, a goal update does not rewrite existing tool history                                                                                                                |
| activeTool + sendText/setGoal                                   | enqueue, the current tool call belongs to the original active turn                                                                                                         |
| sameModelDifferentProvider + session switch                     | allow, restore provider + model identity by session, never echo by model name alone                                                                                        |
| running + apiRetry                                              | consume `control.apiRetry` only at the bottom of the current live turn; `attempt<=2` reads as ordinary loading, `attempt>=3` shows the retry count and replaces loading; cleared by real progress or a terminal state; not restored by a CLI cold start |
| modelMarkerSource=explicitSourceLessBoundary                    | an explicit `∅→X` generates a source-less `modelChange`; a fresh child persists that boundary; ordinary Main first turns and old children do not generate one                                                |
| desktop/mobile busy + accepted input                            | enter the same FIFO in the CLI's serial admission order; no dual-queue race exists                                                                                          |
| guide ineligible/attachment/compact/verifier                    | keep the full Submission (including ModelSelection) and fall back to the CLI queue; compact does not enter a guided row; model/provider play no role in eligibility          |
| guide + ordinary queue nonempty                                 | the guide enters the current active turn; the ordinary queue keeps its future-turn FIFO and is not a guide eligibility guard                                                |
| guide + toolResultBatch=committed                               | all sibling tool results land as facts first, then at most one guide is consumed inline; the same product turn continues, and Session Selection plus the Active Model of the next model step switch to that Submission's Selection |
| accepted guide + current visual work segment                    | close the previous segment and open a new one in the same product turn as a guided user entity; each segment's work time and folding are independent                        |
| guide + parallelTools + toolResultBatch=pending                 | not consumed; a single finished sibling cannot form a guide boundary                                                                                                       |
| guide + turn terminal + toolResultBatch=none                    | fall back in place to the queue with the same intent; IDs, payload, and admission order preserved                                                                          |
| ordinary queue + session ready + goal=none/complete + autoDrain | promote one queue head by FIFO and execute it per its original text/goal/compact kind                                                                                      |
| ordinary queue + goal=active/paused/budgetLimited               | keep the full FIFO; neither a verification marker nor an assistant terminal may consume early                                                                              |
| verifierTerminal=explicitPass/failOpenPass                      | first target→complete, then re-evaluate the ordinary queue guard                                                                                                           |
| verifierTerminal=manualCancel                                   | target→paused, autoDrain=false; the queue is not consumed automatically                                                                                                    |
| activeWork=goalVerifier + stop                                  | cancel the same goal execution via the projection's `foregroundExecutionId`; a verifier→continuation phase switch does not change the execution identity; noop if already switched to an unrelated new execution |
| CLI restart + admitted nonterminal input                        | explicit discarded; `queue/guide` settle silently; only `startNow`/`unknown` inputs that never entered the transcript prompt a resend confirmation; no automatic replay      |
| `sendText`/`editUserQuery` accepted input ACK + projection silent | after a grace period, single-flight resync of the currently owned subscription; closes when the authoritative queue/user row arrives; an edit whose branch cut was committed also fabricates no UI facts, restores no old branch, and resends nothing automatically |
| edit/retry preflight passed + branch cut committed + Registry changed | Core does not re-run the mutable catalog admission; on model creation failure the ordinary-turn lifecycle first lands a replacement `TurnStarted`/user row, then `TurnError(model_creation)`; if persisting fails, the original creation error is still reported, the Stop is `completed(cancelled)`, hook interception follows the ordinary turn; guide falls back to the queue; the workspace rewind may be kept, but the replacement must not be lost |
| `/compact` + Registry changed                                   | no `TurnStarted` published, no `/compact` user row landed; publish `TurnError(model_creation)` directly                                                                      |
| sendQueuedNow                                                   | reserve -> stop barrier -> promote; remove only on success, keep in place on failure                                                                                        |
| collaborationMode=plan + goal command                           | UI admission reject; toast; keep the composer text; no session created, no command sent                                                                                     |

The transport dimension is not a free variable of the product guards. The host injects a trusted profile per attachment and routes by connection-owned subscription:

```text
desktop attachment / continuous ── sub-a ──┐
                                            ├─> same terminal projection
mobile attachment  / replayable ── sub-b ──┘

slow/gapped sub-b -> resync sub-b only -> sub-a unchanged
```

The final invariant: every committed input must land in exactly one of `queue / guided row / transcript / explicit rejected|failed|discarded`, keeping its original `sourceCommandId` across the whole chain.

The state layering of guide versus ordinary queue must not collapse into one generic round-trip drain:

```text
Guide inline path
  admitted -> wait complete tool batch -> one guided drain -> same product turn
       \-> no batch before terminal -> same intent becomes ordinary queue

Ordinary queue path
  queued -> autoDrain -> session ready -> target absent/complete -> future turn
                                      \-> target noncomplete -> stay queued
```

`deliveryProfile` only affects how facts reach the client. Desktop continuous and mobile replayable are no longer business-crossed with `followupDelivery × toolResultBatch × goal`; live/cold equivalence tests of the same CLI terminal projection stand in for that dimension.

Model/provider plays no role in guide eligibility; no model-name allowlist or provider cross-product exists. ModelSelection belongs to the Submission: after a guide is accepted, the runtime appends user history at the model-step boundary, updates Session Selection, and creates the corresponding Model for the next ordinary provider request; requests already sent before acceptance keep the original Model.

Combinations not covered by a rule must land in `undefined`, for humans to judge as new requirement, invalid state, ignorable path, or bug.

## Review output

Every leaf case contains at least:

- Initial context.
- User action or system event.
- Guard hit.
- Effect: allow, reject, enqueue, system-transition, undefined.
- Next context.
- Suggested E2E assertions.

Human review states:

| State      | Meaning                                    |
| ---------- | ------------------------------------------ |
| accepted   | product expectation correct, can go to test |
| undefined  | needs a product definition                 |
| invalid    | this combination must be pruned from product entry points |
| ignored    | combination exists but is not covered yet  |
| bug        | current implementation violates expectations |

## Vite visualization

Run:

```sh
pnpm --filter @zcode/formal-proof dev
```

Open:

```text
http://127.0.0.1:4176/
```

The page uses a large-canvas-first layout: a fixed left panel carries parameter enumeration, semantic statistics, and rule hits; the remaining space on the right is entirely for the state-space graph and its toolbar. Node details take no separate column — clicking a node shows an overlay on the canvas, avoiding shrinkage of the graph area.

The visualization is not an ordinary mind map but a layered state-space DAG:

- Horizontally expanded as `State -> Action -> Guard -> Effect -> Case/Next State`; the next enumeration round appends the same semantic columns further right.
- `State`, `Guard`, and `Effect` nodes merge by semantic equivalence; `×N` on a node means N traces hit the same semantic node.
- User actions and system events both appear in the `Action` layer, system events using the same protocol entry, so async long tasks are not hidden in comments.
- The `Guard` layer shows product-rule pruning, the `Effect` layer shows side effects or state transitions, and the `Case` layer keeps leaves needing human review or E2E conversion.
- `Reject`, `Undefined`, `Queue`, `Allow`, `System` remain filterable by rule and outcome; what gets highlighted is the protocol path, not a layout branch.
