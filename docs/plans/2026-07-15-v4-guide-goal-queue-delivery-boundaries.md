# V4 Guide and Goal Queue consumption boundaries

**Goal:** Restore the V4 "guide" submit entry and split guide and the ordinary queue into two mechanically
verifiable consumption paths. A guide is injected into the current turn only after a complete tool result
batch has landed as facts. The ordinary queue is consumed automatically only when the session is ready and the
current goal is absent or its target is already `complete`. Verifier fail-open counts as pass; a manually
terminated verifier does not.

**Architecture:** CLI/runtime keeps the single `CommandInbox` and the conversation product facts. A guide is
inline delivery into the current turn; the ordinary queue is promotion into a future turn. They share input
identity and FIFO admission but not the drain trigger. Desktop `continuous` and mobile `replayable` change only
delivery/recovery, not the consumption guards.

## Feature Summary

| Field                 | Value                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Change                | Restore V4 guide submit; the ordinary queue waits for goal verify pass (including fail-open) and the target update before it is consumed |
| User-visible surfaces | The "引导" (guide) preference in Settings, the V4 Composer, the queued prompt list, the goal status panel                          |
| Existing docs         | `docs/chat/interaction-behavior.md`, conversation protocol/state space, case catalog, E2E matrices, V4 protocol spec                |
| Existing code owners  | `packages/ui/src/v4`, CLI core runtime steering/turn loop, bootstrap V4 bridge, contracts projection                                |
| Out of scope          | Cross-device global FIFO, relay/main holding business queue, automatic replay after CLI restart, widening guide attachment capability, redesigning Stop/send-now |

## Boundary Decisions

| Boundary                | Decision                                                                                                  | Includes                                                            | Excludes / prunes                                         | Source                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Guide trigger           | Consume at most one guide, only after all sibling tool results of one model step are committed           | single tool, parallel tools, success/failed tool result              | text-only completion, one sibling finishing early         | user + protocol                 |
| Guide no-tool fallback  | If the current turn ends without a usable tool batch, the original guide intent is re-delivered in place as an ordinary queue item | Keeps original text, attachments, client, IDs, admission order | Dropping it, creating a new intent, waiting forever after terminal | user                       |
| Guide eligibility       | Model/provider independent; ineligible falls back to queue                                                | Any model/provider, no attachments, no existing queue, not Stopped, eligible running turn | Widening attachment steer capability this round | user decision + runtime architecture |
| Ordinary queue trigger  | Promote automatically only after session ready; with a target, `target.status=complete` is also required | text, goal command and compact share one FIFO gate                  | Draining at a tool result boundary, draining on the verification marker alone | user          |
| Fail-open               | Verifier infrastructure/output/tool-misuse errors return `passed=true`, then the target completes, same as an explicit pass | fail-open record, target complete, normal queue drain | A special drain branch bypassing the target update | user + code                   |
| Manual verifier stop    | cancelled/aborted, target paused, queue retained with `autoDrain=false`                                   | Existing Stop and independent pause semantics                       | Treating it as fail-open or pass                          | user                            |
| Explicit send-now       | Keep the existing explicit preemption exception                                                           | reservation, Stop barrier, selected item promotion                  | Being bound by the ordinary auto-drain goal gate          | user + existing protocol        |
| Transport               | Desktop/mobile converge on the same CLI facts                                                             | desktop-continuous, web-remote-replayable live/cold equivalence     | New relay/main business state, dual queues                | architecture docs               |

Guide is a generic runtime model-step continuation, so model/provider restrictions were removed from
eligibility (an earlier "reuse eligibility" provider clause is overridden). Accepted defaults confirmed: a
guide without a tool falls back to queue; at most one guide per batch; a non-complete goal keeps blocking all
ordinary queue kinds; parallel tool calls wait for the whole batch; a guide may be submitted before a tool
runs and waits.

## Domain Scope

| Domain                       | Include?               | Why it can change behavior                                                 | Primary sources                    |
| ---------------------------- | ---------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| conversation/session runtime | yes                    | guide injection and queue promotion both change turn boundaries            | CLI core turn loop/steering        |
| goal/target                  | yes                    | The queue gate depends on target terminal status                           | target verifier + bootstrap bridge |
| V4 command/projection        | yes                    | Delivery fallback and queue state must match live/cold                     | contracts + bootstrap projection   |
| UI/composer                  | yes                    | V4 `mode=guide` currently disables the button and Enter                    | `ConversationComposer` / `SessionPane` |
| tool lifecycle               | yes                    | The guide's only inline drain boundary is a complete tool batch            | runtime tool execution             |
| remote/replay                | yes, representative    | Prove the same CLI fact does not diverge across continuous/replayable      | architecture + bootstrap tests     |
| relay/main process           | no                     | Pass-through only; owns no queue/goal/stream business state                | remote architecture                |
| workspace identity           | no new behavior        | Isolated by session; no new workspace key                                  | architecture constraints           |
| model/provider eligibility   | pruned invariant       | The runtime appends unified user history at the model-step boundary and does not rely on provider-native steer | user decision + core runtime |

High-risk cross-products and handling: guide x single/parallel/failed tool result (enumerate three
representatives); guide x text-only/Stop (accepted fallback-to-queue case); queue kind x goal target status
(mixed FIFO, one shared gate); verifier result x target update (explicit pass, fail-open, manual cancel);
guide x active goal phase (output/continuation can take a guide, verifier-busy falls back to queue); delivery x
client profile (proved by live/cold projection equivalence, not a full permutation).

## Concept Map

| Concept                          | Why it matters                                                          | Source                    |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| `ConversationInputIntent`        | Input identity shared by queue/guide; fallback cannot change ID or order | V4 protocol spec          |
| `delivery.admitted`              | Decides inline guide vs future queue                                    | V4 protocol spec          |
| `CommandInbox`                   | Sole FIFO authority for desktop/mobile busy input                       | protocol declaration      |
| tool result batch                | The only commit boundary at which a guide may enter the current turn    | CLI runtime               |
| session ready                    | First guard of ordinary queue promotion                                 | conversation behavior     |
| `target.status`                  | Second guard of goal queue promotion                                    | target contracts          |
| `autoDrain`                      | Whether the ordinary queue is armed                                     | queue projection          |
| explicit send-now reservation    | The explicit user path that bypasses waiting for automatic consumption  | protocol declaration      |

## State Owners

| State / fact                       | Authority                                         | Mirrors / caches                                      | Evidence                          |
| ---------------------------------- | ------------------------------------------------- | ----------------------------------------------------- | --------------------------------- |
| queue/guide intent, admissionSeq   | CLI CommandInbox / session input ledger           | V4 QueueState, renderer projection                    | command ACK + live/cold snapshot  |
| tool batch completion              | CLI core runtime                                  | tool rows/timeline                                    | ordered runtime facts             |
| target status                      | CLI target store                                  | V4 goal projection, task meta compatibility mirror    | target changed event + snapshot   |
| session ready / active controller  | CLI/bootstrap runtime                             | V4 control projection                                 | controller lifecycle + snapshot   |
| followup preference                | app setting, synced to the CLI config for open sessions | V4 config projection                            | setting + command ACK             |

## Delivery state and event order

Guide and queue share admission but split immediately after it:

```text
sendText while running
  -> CLI admission: stable sourceCommandId + queueItemId + admissionSeq
  -> delivery decision
       |
       +-- guide eligible
       |     -> wait for next complete tool result batch
       |     -> commit every sibling ToolCallResult
       |     -> drain exactly one guide inline
       |     -> persist guided user fact
       |     -> next provider request of the same product turn
       |
       |     no usable tool batch before turn terminal
       |     -> reclassify the same intent to queue
       |
       +-- queue / guide ineligible
             -> ordinary queue
             -> wait for session ready
             -> target absent OR target.status=complete ?
                    no  -> keep FIFO unchanged
                    yes -> promote one head item by original kind
```

Goal verification commits one way only:

```text
explicit verifier pass ─┐
                        ├-> verification passed=true
verifier fail-open ─────┘        -> target.status=complete
                                      -> session ready
                                      -> ordinary queue may drain

manual verifier Stop/abort
  -> verification cancelled/failed
  -> target.status=paused
  -> queue retained, autoDrain=false
  -> no automatic drain
```

The guide fallback is a durable, explicit delivery-changed fact (not a repeated "queued" event) carrying
`queueItemId/sourceCommandId/requested/admitted/reasonCode`, strictly schema-validated; the reducer updates the
intent in place keeping admissionSeq, payload, attachments, clientId and FIFO position, and live projection,
cold hydration and the session-input ledger converge on the same result.

## Dimensions

| Dimension         | Values / equivalence classes                                   | Include?            | Reason                         |
| ----------------- | -------------------------------------------------------------- | ------------------- | ------------------------------ |
| delivery          | queue, guide, guide->queue fallback                            | yes                 | Core change                    |
| tool batch        | none, single, parallel, failed-result                          | yes                 | Guide boundary                 |
| guide count       | one, 2+                                                        | yes                 | One per batch, FIFO            |
| goal status       | none, active, paused, budget_limited, complete                 | yes                 | Ordinary queue gate            |
| verifier terminal | explicit pass, fail-open, fail/continue, manual cancel         | yes                 | Distinguish pass from cancel   |
| queue kind        | sendText, sendGoalCommand, compact, mixed                      | yes                 | The gate must not cover only text |
| queue action      | auto drain, resume, send-now                                   | yes                 | send-now is the explicit exception |
| client profile    | desktop-continuous, web-remote-replayable                      | representative      | No business Cartesian product  |
| provider/tool name | eligible provider; readonly representative tool               | representative      | Does not widen product support |

## Candidate combinations

| Candidate ID | State                                                 | Event                              | Expected guard/effect                                                         | Status        |
| ------------ | ----------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- | ------------- |
| GDQ-01       | running + followupMode=guide + eligible               | Composer submit/Enter              | Button and Enter submit; cleared only after accepted (V4 composer currently treats guide as disabled) | bug-candidate |
| GDQ-02       | eligible guide waits + single tool                    | tool result committed              | After the result inline-drain one guide, then the next provider request       | accepted      |
| GDQ-03       | eligible guide waits + parallel tools                 | last sibling result committed      | All sibling results land first, then at most one guide                        | accepted      |
| GDQ-04       | 2+ guide intents + repeated batches                   | each batch completes               | One per batch, in admission FIFO; not all guides at once                      | accepted      |
| GDQ-05       | guide admitted + text-only terminal                   | turn completes without tool        | The same intent falls back to queue in place (IDs/order kept)                 | accepted      |
| GDQ-06       | guide requested but ineligible                        | admission/runtime reject           | The same intent falls back to queue + reason (provider/attachment/existing queue/Stop/compact/verifier) | accepted |
| GDQ-07       | active goal output/continuation + eligible guide      | guide submitted, tool batch completes | Inline guide; target is not Stopped/paused and does not wait for verifier pass; the verifier request itself is not steered | accepted |
| GQD-01       | queue>0 + target active/paused/budget_limited         | session otherwise ready            | All kinds retained; no provider/goal/compact start (current ready drain lacks a target gate) | bug-candidate |
| GQD-02       | queue>0 + explicit verifier pass                      | target becomes complete            | After ready, promote in FIFO (the marker alone is not enough)                 | accepted      |
| GQD-03       | queue>0 + verifier fail-open                          | target becomes complete            | Same end state and drain as an explicit pass; no special bypass               | accepted      |
| GQD-04       | queue>0 + manual verifier cancel                      | target becomes paused              | Queue held; no automatic drain; cancel is not fail-open                       | accepted      |
| GQD-05       | mixed text/goal/compact queue + active goal           | target complete                    | The three kinds share the gate, then keep original order and semantics (compact creates no user row) | accepted |
| GQD-06       | queue>0 + no target                                   | session ready                      | Consumed by existing ready/autoDrain rules (no-goal regression)               | accepted      |
| GQD-07       | non-complete target + queued item                     | explicit send-now                  | reservation + Stop barrier + promote (explicit exception, not auto-drain)     | accepted      |
| GQD-08       | queue>0 + autoDrain=false + non-complete target       | user resumes queue                 | Only sets autoDrain=true; still waits for target complete ("resume" is not send-now) | accepted |

## Pruning decisions

| ID   | Pruned combinations                              | Guard/invariant                  | Product reason                                                           | Representative coverage                             |
| ---- | ------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| P-01 | every concrete tool name x guide                 | guideAfterCompletedToolBatch     | The boundary depends only on batch terminal, not tool business           | readonly success + failed result + parallel batch   |
| P-02 | desktop/mobile x all business states             | trustedDeliveryBoundary          | Both share CLI facts; transport recovery is a separate dimension         | desktop E2E + bootstrap live/cold equivalence       |
| P-03 | active/paused/budget_limited each x every queue kind | incompleteGoalBlocksQueueDrain | All are the same `status !== complete` guard                             | mixed FIFO + status reducer/unit representatives    |
| P-04 | each low-level fail-open exception               | verifierFailOpenCompletesTarget  | Format/network/tool misuse share the `passed=true` contract              | one deterministic fail-open E2E + contract unit cases |
| P-05 | every model/provider x guide                     | guideIsModelAgnostic             | The runtime does not rewrite the in-flight request; it appends user history at the model-step boundary | non-GLM bootstrap representative regression |
| P-06 | relay/main queue state                           | cliOwnsConversationProjection    | Business state must not sink into relay/main                             | architecture/static review                          |
| P-07 | guide extended to attachments                    | guideModeEligibilityGuard        | This round does not widen attachment steer capability                    | attachment fallback case                            |

## Accepted Cases

| Case ID | Setup                                                         | Action                                  | Assertions                                                                          | Evidence layers                  | E2E status       |
| ------- | ------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------- | ---------------- |
| GDQ-01  | eligible running V4 session, setting=guide                    | button/Enter send                       | command accepted; composer clears after ACK; guide fact appears                     | UI + command                     | missing          |
| GDQ-02  | provider step returns one readonly tool call, guide admitted  | commit tool result                      | `ToolCallResult < TurnSteerDrained < next provider request`                         | runtime + protocol + network     | missing          |
| GDQ-03  | provider step returns parallel tool calls                     | complete siblings in varied order       | every sibling result precedes one drain; no second guide drain                      | runtime + protocol               | missing          |
| GDQ-04  | two guide intents and two tool batches                        | complete both batches                   | exactly one per batch; source IDs and FIFO preserved                                | runtime + projection             | missing          |
| GDQ-05  | guide admitted, provider returns text-only terminal           | finish turn                             | delivery changes to queue in place; later obeys the ordinary queue gate             | runtime + live/cold projection   | missing          |
| GDQ-06  | attachment/existing queue/verifier busy representative        | submit guide preference                 | accepted as ordinary queue with fallback reason; payload preserved                  | command + projection             | partial          |
| GDQ-07  | active goal continuation uses a tool                          | submit guide and complete batch         | guided row in the same turn; target stays active; no Stop                           | UI + runtime + network           | missing          |
| GQD-01  | active target + mixed FIFO queue                              | active work settles without target completion | no queue promotion/provider request                                           | runtime + projection + network   | missing          |
| GQD-02  | same setup                                                    | verifier explicitly passes              | target complete precedes FIFO promotion                                             | runtime + protocol + UI          | missing          |
| GQD-03  | same setup + deterministic malformed verifier result          | trigger fail-open                       | passed=true; target complete; FIFO promotion                                        | runtime + protocol + logs        | missing          |
| GQD-04  | verifier streaming + queue                                    | user Stop                               | verifier cancelled; target paused; autoDrain=false; no promotion                    | UI + runtime + network           | missing          |
| GQD-05  | queue order text -> goal -> compact                           | target completes                        | each item starts by original kind and original order                                | protocol + timeline + network    | missing          |
| GQD-06  | no target + normal queue                                      | session becomes ready                   | existing FIFO auto-drain unchanged                                                  | regression E2E                   | partial          |
| GQD-07  | active target + queued item                                   | click send-now                          | target/current work stops; selected item starts once; others keep order             | UI + runtime                     | covered adjacent |
| GQD-08  | paused queue + paused/active target                           | click queue resume                      | autoDrain becomes true but no promotion; drains only after target complete          | UI + runtime + projection        | missing          |

Matrix backfill targets: `docs/conversation-session-case-catalog.md` (H08/H12, M06a-g),
`docs/testing/conversation-session-e2e-coverage-matrix.md` (old guide "covered" downgraded to a real gap,
M06a-g split, H08/H11/H12 aligned), `docs/testing/conversation-session-goal-specific-coverage-matrix.md`
(G1-10/G1-13/G1-14), `docs/testing/conversation-session-tool-cross-product-matrix.md` (guide x tool-batch
representatives), `docs/conversation-protocol-declaration.md` (guide batch, fallback identity, incomplete goal
queue gate invariants), `docs/conversation-product-state-space.md` (delivery/toolBatch/verifier terminal
dimensions).

## Implementation contract (summary)

- V4 Composer: `inputRouting.mode=guide` keeps normal composer/button/Enter submission with no second input box; keeps the existing attachment readiness, Plan-mode, held queue choice and ACK-before-clear guards; when a guide does not apply the CLI returns a queue fallback for the same intent and the UI creates no second queue.
- Runtime: the generic round-trip no longer inline-drains the ordinary queue. After a complete tool result batch is committed, check the guide at the head of the queue and drain at most one; parallel siblings must all finish first; failed and successful tool results share the same terminal boundary. Guides not drained before text-only/Stop/terminal are reclassified in place to the ordinary queue. High-frequency tool/steer order logs use `debug` only.
- Ordinary queue gate: one unit-testable helper decides promotion (head queued + autoDrain + no active controller + session ready + (`target=null` or `target.status=complete`)); `sendText/sendGoalCommand/compact` all go through it with no kind-specific bypass; re-evaluate after target update and controller cleanup so a finished pass is never left without a wake-up; fail-open adds no special drain (reuses `passed=true -> target complete`); manual cancel/Stop keeps target paused, queue retained, autoDrain=false; `sendQueuedNow` keeps its reservation + Stop barrier exception.

## E2E Handoff Notes

- Provider fixture: controlled SSE must stably produce text-only, single tool, parallel tool, failed tool result, goal verifier explicit pass and malformed fail-open.
- File-system fixture: the readonly tool uses case-local temp files; no real network or user directories.
- Timing strategy: barriers are command ACK, runtime fact and provider request marker; no fixed sleeps to guess tool/verify terminal.
- Docker preset: if the provider fixture needs replay isolation, reuse the conversation E2E Docker preset; real mobile network is not widened this round.
- Evidence: runtime debug log/provider capture prove ordering; CDP proves the Composer's disabled state is restored; desktop formal E2E proves interaction while bootstrap live/cold tests prove mobile replayable does not change the business end state.
- Review risks: parallel tool result commit order, race between target complete and active controller cleanup, guide->queue live/cold projection, regressions of the existing paused queue choice/send-now.
