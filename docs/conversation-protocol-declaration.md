# Conversation Behavior Protocol Declaration

Goal: declare the "conversation product behavior protocol" clearly before discussing entry and generation tooling. The declaration lets product, QA, and development align on one semantics: where a case comes from, what the tree nodes mean, which paths product rules prune, and which paths are not yet defined.

## Protocol layers

The protocol is neither a JSON file nor a flowchart. It is a combination of product-semantic layers.

| Layer | What it declares | Example |
| ----- | ---------------- | ------ |
| State dimensions | the observable product context at a moment | `runPhase=running`, `queue=empty`, `goal=active` |
| Input events | what the user or system may do next | user sends `/compact`; system returns `assistantComplete` |
| Target objects | which object the action acts on | latest turn, old turn, composer, goal control |
| Rule guards | whether a combination may proceed | no compact while running; forking a stable assistant target while running may be allowed |
| Effects | the product result after allow or reject | enqueue, reject toast, entering compacting |
| Invariants | product principles that may never be broken | a running edit must pass a stop barrier first; fork copies only stable assistant history, never queue/background work |
| Trace cases | a reviewable, test-convertible path | Given running, when `/compact`, then reject |

## Trace Tree node types

The Trace Tree is a view of the expanded protocol. It is not the protocol itself, but it must express the protocol semantics faithfully.

| Node type | Meaning | Responsibility | E2E-convertible |
| --------- | ------- | -------------- | --------------- |
| `state` | a product context snapshot | state the values of all state dimensions | no |
| `candidate` | a candidate input | a user action or system event entering the Cartesian enumeration | no |
| `guard` | the product rule hit | state which rule adjudicates this combination | no |
| `effect` | the rule's result | state the side effects and next context after allow/reject/enqueue/system/undefined | partially |
| `case` | a leaf needing human review | summarize the full path, assertions, review state | yes |
| `summary` | a canvas-budget folding node | means only "many nodes are not expanded here" | no |

Basic node order:

```text
state -> candidate -> guard -> effect -> state ...
                                 |
                                 -> case
```

## Input event types

Input events come in two kinds; do not mix them.

| Type | Meaning | Examples |
| ---- | ------- | -------- |
| `user-action` | GUI behavior the user triggers | sendText, slashCompact, setGoal, forkOld, editLatest |
| `system-event` | an event the system advances asynchronously | assistantComplete, compactComplete, autoCompactNeeded |

Every input event declares at least:

- `id`: a stable identifier, e.g. `slashCompact`.
- `actor`: `user` or `system`.
- `surface`: which product entry it happens in — composer, toolbar, turn actions.
- `target`: the object acted on — latest turn, old turn, current session.
- `payload class`: the input content category — normal text, slash command, goal text.
- `applicability`: in which contexts this event should be enumerated.

## Decision types

A `guard` result must land in an explicit decision type.

| Decision | Meaning | Example |
| -------- | ------- | ------- |
| `allow` | the action takes effect immediately and enters the next context | fork an old turn after completed |
| `reject` | the action is explicitly rejected; the path is pruned | `/compact` while running |
| `enqueue` | the action does not execute now but is queued | sending text while running |
| `system` | a system event advances the state | entering completed after assistantComplete |
| `undefined` | product expectation not declared | a combination nobody has defined |

`reject` is not an error fallback. It requires explicit product feedback — toast, disabled reason, inline error — and must declare which side effects cannot occur.

`undefined` is the most important review entry: the model enumerated a genuinely possible combination, but the protocol has not defined how to handle it.

## Command ACK declaration

Session actions the user triggers on renderer/web must not directly rewrite authoritative conversation state. They enter as command intent first; the CLI/runtime adjudicates by the current projection revision, guards, and idempotency keys; the owner host only provides the trusted connection context, owned-subscription and owner/lease routing, and never keeps a second conversation queue. The ACK together with subsequent projection/events converges the UI.

```text
user action
  -> ConversationCommand
     |-- commandId
     |-- clientId
     |-- sessionId
     |-- baseRevision?
     |-- type
     `-- payload
  -> host injects {connectionId, trusted clientMode}
  -> CLI guard / dedupe / execute
  <- CommandACK
  -> projection revision update
```

| ACK | Meaning | Side effects that must be declared |
| --- | --- | --- |
| `accepted` | the command was received by the authority; it may already have executed or be in the command queue | recoverable command state; the UI waits for projection convergence |
| `rejected` | a guard explicitly rejected the command | reason, user feedback, forbidden side effects |
| `stale` | `baseRevision` is behind; the current state may have changed | the UI must refresh the projection first; non-idempotent actions must not be silently replayed |
| `duplicate` | the same `commandId` was already processed | return the existing result; do not execute twice |
| `failed` | execution failed after the command was accepted | fault catalog, recovery entry, whether queue/command state is kept |

`@zcode/rpc` carries only call/listen, connections, timeouts, logging, and telemetry; `commandId`, `baseRevision`, `projectionRevision`, `eventSeq`, `deliveryKind`, and `accepted/rejected/stale/duplicate` are conversation protocol semantics.

Desktop windows (including SSH/WSL/Docker) are trusted-marked `desktop-continuous` by the host; mobile `/remote` and Web remote are marked `web-remote-replayable`. The UI-facing subscribe cannot choose a profile; each attachment has an independent `connectionId`, subscription registry, and cleanup lifecycle.

```text
desktop A / continuous ── owned sub-a ──┐
                                        ├─> one CLI projection / CommandInbox
mobile  B / replayable ── owned sub-b ──┘

sub-a frame -> port A only        sub-b overflow/resync -X-> port A
```

On ACK loss or reconnect, `commands/query` looks up at most 64 `{sessionId, commandId}` per call. The CLI lookup order is fixed: in-memory LRU, transcript/message anchor, timeline marker, fork child metadata, discarded input ledger, `unknown`; same-key queries and executions must be single-flight.

The shared strict schemas of `turn.steerQueued` and `turn.steerDrained` must fully cover the additive facts the CLI runtime emits. The queued payload includes optional `delivery`, `intent`, and `toolDisallowlist`; the drained payload includes optional `drainedInputs[]`, each keeping `pendingInputId`, the persisted `messageId`, text, and the same delivery metadata. The Agent Service must not raise `unrecognized_keys` over these declared fields and drop the events; the authoritative queue/guide state still lives only in the CLI runtime.

`SessionResumed` is an explicit runtime epoch boundary in the raw event sequence. Even if the gateway already holds the old runtime's continuous publisher, on a new `SessionResumed` it must clear the old epoch's pending gaps and re-establish the contiguous cursor from that event's raw sequence. Tail events missed by the old runtime during an unsubscribe/rebuild window can no longer be backfilled; those gaps must not block the new epoch's `TurnStarted` projection authority. This local desktop-continuous rule must also not be substituted for mobile `web-remote-replayable`'s snapshot/gap recovery protocol.

For `fault.command.inputDiscardedOnRestart`, `commands/query` must also return the persisted input's `delivery=startNow|queue|guide`. The renderer's submission-recovery ledger covers only the short "was the uplink received by the authority" window — it is not a second cross-runtime queue: as soon as a snapshot shows a queue/guided item with the same `sourceCommandId`, the matching localStorage record is removed; if the App/CLI restarts exactly between ACK and projection, a query returning `queue|guide` also settles silently; when the authority returns `unknown`, the renderer recovery clues are deleted without a UI error. Only a `startNow` that still has not entered the transcript after restart keeps an explicit resend entry; automatic replay is forbidden.

```text
renderer pre-uplink journal
  |-- queue/guided projection -------------> settle + remove localStorage
  |-- restart query: delivery=queue|guide --> settle silently
  |-- transcript sourceCommandId ----------> settle + remove localStorage
  |-- restart query: unknown ---------------> settle silently
  `-- restart query: delivery=startNow -----> show explicit resend decision
```

The recovery prompt renders fixedly in the conversation sticky bottom dock, reusing the chat area's error-banner default `surface + border + foreground` colors, radius, spacing, and wrapping; no warning-yellow background and no added shadows.

`v4/conversation/plans` is a read-only, stateless per-session query for the currently effective plan catalog: the request is `{ sessionId }` and the response `{ plans, atSeq, atLogEpoch }`. The CLI must first build the complete projection via conversation cold-resume/hydration, then filter the current branch for `ToolCallRow`s with `toolName=ExitPlanMode`, status in `success/error/cancelled`, and non-empty body, returning them ordered by `rowId` descending. It must not scan only the wire snapshot's tail window, nor send the full ordinary history to the renderer. The renderer uses `atLogEpoch` plus the local catalog revision to drop late reads; `row.removed` must invalidate the old catalog. The query passes through the existing workspace attachment; the identity key stays `workspaceIdentity?.trim() || workspacePath`; desktop-continuous and web-remote-replayable subscription, owner, queue, and snapshot/gap semantics are unchanged.

## Rule declaration

A rule has four parts.

| Field | Role |
| ----- | ---- |
| `match.context` | match the product context |
| `match.input` | match the user action or system event |
| `decision` | allow/reject/enqueue/system/undefined |
| `assertion` | the result later E2E must verify |

Example:

```text
rule runningCompactQueues
when:
  context.runPhase = running
  input.id in [slashCompact, compact]
then:
  decision = enqueue
  feedback = queued
  forbidden side effects:
    - not sent as an ordinary message
    - does not interrupt the current active work
    - does not start a compact before this queue item's turn
assert:
  compact queue item is visible
  sourceCommandId and FIFO position are preserved
  run remains running
```

## Invariant declaration

Invariants are product principles above any single rule. They check rules for conflicts and expose undefined paths.

The first batch of conversation invariants:

| Invariant | Statement |
| --- | --- |
| sameSessionActiveTurnExclusive | one session cannot run two active turns; concurrency exists only across sessions |
| runningStableAssistantForkAllowed | while running, an earlier `completedSuccess` turn's last completed assistant may be forked; current streaming/interrupted/failed partials and middle assistant segments cannot |
| latestQueryEditPreemptsActiveTurn | only the last real user query may be edited; submitting an edit while running equals stopping the active work first, then rerunning from that query |
| latestAssistantRetryOnly | the underlying retry capability first locks the projection's timeline-last `assistantText` row, then requires the same product turn to have a canonical user input with `origin=realUser`; synthetic result turns (background result/goal continuation/mailbox) and earlier real-user turns get no capability. 2026-07-15 product ruling: desktop, Web, and mobile UI uniformly hide the ordinary assistant retry entry while keeping the `canRetry` projection, the `retryTurn` command, and its gating, so the UI convergence is not misread as a protocol/recovery-semantics removal |
| runningPromptQueues | sending ordinary messages while running with `followupMode=queue` must enter the session's queue without interrupting the current turn |
| runningGoalQueues | sending `/goal xxx` while running must enter the session's queue; the goal is set or updated on consumption |
| acceptedInputHasSingleAuthority | busy/running inputs committed on desktop and mobile enter one CommandInbox/FIFO by the CLI's serial admission order; host and UI keep no second authoritative queue |
| acceptedInputAlwaysAccountedFor | committed input must be in exactly one of queue, guided row, transcript, or explicit rejected/failed/discarded |
| acceptedInputProjectionSilenceRecovers | after `sendText` or `editUserQuery` receives an `accepted` or `duplicate` ACK, the sender must wait for the same `sourceCommandId`'s queue item or real-user `userInput` row. Once `editUserQuery` has published a branch cut, the replacement row is the sole authoritative input fact after recovery — the client must not keep only the truncated result. If no authoritative visible fact appears within a short grace period, the client only triggers a single-flight same-subscription resync on the currently owned subscription; it must not fabricate user rows, restore old branches, build a renderer queue, or automatically replay the command. Recovery keeps the trusted desktop-continuous / mobile-replayable boundaries along the attachment; `sendGoalCommand`'s direct goal state does not use a user row as its confirmation condition |
| destructiveReplayPreservesReplacement | `editUserQuery` / `retryTurn` finish the external model-catalog preflight before the branch cut; after committing the cut they must not reject the replacement because a re-read of the changing catalog differs. If the catalog changed by the time Core creates the model, it must first publish `TurnStarted`, persist the replacement user input, then publish `TurnError(model_creation)`. The replacement follows the ordinary turn's single lifecycle and writes its terminal state once: if persisting itself fails, close out with the original model-creation error and Stop as `completed(cancelled)`; that turn accepts no guide — the guide is re-queued as ordinary queue. The workspace may keep a confirmed rewind, but the state "old branch truncated and replacement missing" must never occur; the only exception is an explicit `UserPromptSubmit` hook interception, which rejects per ordinary-turn policy without persisting. `/compact` produces no user row and publishes `TurnError(model_creation)` directly on creation failure |
| promptRequiresTextOrAttachment | `sendText`, `createSession.firstInput`, `createSelectionSideSession.firstInput`, and `editUserQuery` require at least one of body text or a valid attachment; ordinary attachment input may use an empty body, this feature's child first send requires a non-empty body, and both empty must reject explicitly |
| sourceCommandIdEndToEnd | queue item, drain/guided event, user row, message anchor, marker, and fork child metadata keep the original sourceCommandId |
| guideDrainsAfterCompletedToolBatch | an eligible guide may wait until tools appear; only after all sibling tool results of one model step are committed may at most one guide be consumed inline, continuing the same product turn |
| acceptedGuideStartsWorkSegment | an accepted guide does not cut the product turn, but must close the previous visual work segment and open an independent work-time/folding segment keyed by the guided user entity; the final action target is unchanged |
| guideFallbackPreservesIntent | when the current turn reaches a terminal state with no usable tool batch, or guide does not apply/is rejected, the same intent is re-queued in place as ordinary queue; payload, client, IDs, admissionSeq, and FIFO are unchanged |
| incompleteGoalBlocksQueueDrain | ordinary queue auto-consumption requires session ready AND target absent or `target.status=complete`; an active/paused/budget_limited target blocks text, goal, and compact kinds alike |
| verifierFailOpenCompletesTarget | verifier infrastructure, output-format, or tool-misuse exceptions fail open with `passed=true` and unlock the queue via the normal target-complete path; adding a drain branch that bypasses target updates is forbidden |
| verifierCancelDoesNotPass | a manual Stop/abort of the verifier is cancelled/failed + target paused, queue kept with `autoDrain=false`; it is neither fail-open nor pass. For non-streaming model providers, even without a timely `AbortSignal` response the adapter must end the local `generateText` wait immediately via the abort race instead of waiting for the upstream's natural return before closing the verifier |
| restartDiscardRespectsDeliveryLifetime | after a CLI restart, admitted inputs not yet terminal are marked discarded; `queue/guide` belong to the old runtime epoch and settle silently by their persisted delivery with no renderer resend copy kept; `unknown` also settles silently with no UI error; only a `startNow` that never entered the transcript prompts the user; automatic replay is forbidden |
| runningCompactQueues | while running, `/compact` appends to the CLI FIFO as a `kind=compact` maintenance intent; it does not interrupt the active work and is not an ordinary message |
| stopEndsAsInterruptedCompleted | after stopping generation there is no "paused state"; the current turn ends as `completed(interrupted)` |
| stopKeepsQueueAndDisablesAutoDrain | after a stop the queue is kept verbatim and not auto-consumed by default |
| pausedQueueInputRequiresConfirmation | in `completed` with `queue>0` and `autoDrain=false` (paused queue), ordinary messages and `/goal <new target>` do not queue silently: keep the normal send button, and after submission show a confirmation dialog choosing 「清空队列并发送」 or 「保留队列并立即发送」; `/compact` still appends directly to the paused queue (2026-07-15 UI re-ruling; V4 still expresses this as `inputRouting.mode=choice`) |
| pausedQueueResumeDrainsFifo | resuming a paused queue is a CLI-authoritative resume command: it only sets `autoDrain=true`; afterwards the session-ready and `target absent/complete` guards still apply. With no unfinished target, idle starts from the head immediately and busy arms first, starting after the current active work closes; with a non-complete target it only arms without consuming. Once guards pass, it auto-consumes by FIFO to empty; an interruption such as Stop or compact failure returns to `autoDrain=false` |
| queueContentIndependence | queue messages are future user intents not bound to any history context; editing a historical query, compact, and fork never rewrite queue content |
| queuedEditRestoresComposerAfterAuthoritativeRemoval | when first-party UI edits a queue item, it first removes it authoritatively via `deleteQueueItem(baseRevision)`; only after `accepted/duplicate` does the initiator's own session/workspace composer restore the full input idempotently; failure/noop/stale restores nothing |
| compactingAcceptsFutureInput | while compacting, ordinary messages and `/goal xxx` append to the queue |
| duplicateCompactRejected | a second compact while one is running or queued in the same session must reject, not double-queue |
| compactCanBeStopped | stopping is allowed while compacting; the compact timeline marker becomes interrupted and the session returns to `completed(interrupted)` |
| forkAssistantOnly | only assistant messages may be forked; user and tool messages cannot |
| forkDoesNotCopyQueue | forking a new session does not copy the parent queue |
| forkDoesNotCopyBackgroundWork | forking does not copy the parent's live background bash/subagent or pending background result |
| runningForkDoesNotRewindWorkspace | a running fork copies only stable conversation history; it does not rewind the shared workspace, and the parent session keeps running |
| editUserOnly | only user queries may be edited; assistant and tool cannot |
| editKeepsQueue | editing the last real user query reruns from that turn, but the queue is kept verbatim |
| sessionConfigScoped | model and thinking depth are session-scoped storage; switching to a historical session shows that session's own config |
| providerRetryUsesLiveTurnTail | `control.apiRetry` is a session-scoped runtime-memory fact shown only at the bottom of the current running turn, replacing generic loading; it clears on real model progress or a terminal state and does not survive a CLI cold start. A read-only child may display the state but must not open a manual retry command for it |
| freshSubagentInitialModelIsDurable | a fresh child persists the actually-resolved model `model_change(undefined -> X)` before the first input; the first turn shows "now using X" without a switch arrow and cold start can rebuild it; an ordinary Main first turn is silent, resume does not rewrite it, old children are not backfilled, and the parent timeline does not mirror it |
| newSessionInheritsLastSelection | a new session uses the `provider + model + thought` tuple the user last explicitly selected and the runtime confirmed in effect; thought is never inherited independently of its model |
| draftCollaborationModeUsesRendererGlobalPreference | the `build/edit/plan/yolo` memory applies only to unsent drafts: new drafts in the same renderer read the global localStorage preference; opening or switching existing sessions must not rewrite it |
| queuedSubmissionPreservesSelection | a queue item stores the complete Submission; on consumption it uses the Provider, Model, and thinking depth fixed at enqueue — later Session Selection changes do not rewrite the queued intent; Provider config is re-read from current facts at Model creation |
| acceptedGuideSwitchesAtModelStepBoundary | when the current Loop accepts a guide, the input, Session Selection, and the next Active Model take effect together; already-sent model requests keep running to completion, and the next model step uses the guide's Selection |
| crossSessionUnlimitedConcurrency | different sessions may truly run concurrently with no product-layer concurrency cap |
| sessionResidencyTargetIsSoft | each CLI may keep a resident-session soft target via LRU; active/queued/background/pending/subscribed/operation-leased sessions must stay alive preferentially, exceeding the target is allowed when protected sessions outnumber it, and cancelling work to fit capacity is forbidden |
| deactivatedSessionEqualsColdSession | resident eviction removes only the CLI in-memory record/publisher/runtime — never the persisted session or task index, and emits no `session.removed`; later access shares cold-resume with sessions unloaded after a CLI restart, and the renderer receives no deactivation business notification |
| sessionContextFollowsActiveSession | after the user switches to a historical session, the right sidebar, tasks, and context must follow the active session |
| autoCompactIsSystemTurnPrefix | an automatic compact is a system-inserted pre-maintenance step that takes no user queue slot; on success it continues the action that triggered it |
| cliOwnsConversationProjection | the conversation product projection is produced by the CLI/runtime from CLI facts; the owner host only caches, routes, and recovers the projection, and the UI invents no product facts from local message arrays |
| productRowsRequireCompleteConsumerContract | the CLI may materialize a runtime fact into a conversation product row only when the row's identity, session/turn/tool placement, cold-recovery position, and the Renderer form a complete contract. `HookRun*` projects only client-safe `hookInvocation` summaries: entering end-of-turn actions by authoritative `turnId`; a resume-time `SessionStart` missing a turnId waits for the next real user-intent turn, and constructing a `session-hooks:*` synthetic turn is forbidden; admission-only blocked must not be displayed as "has run". Live/cold, desktop continuous, mobile replayable, and Renderer must close the loop in the same change — merging only protocol types or only the producer is not enough |
| v4ColdResumeSeparatesActivationFromProjection | a V4 historical-session cold subscription reuses only the session runtime activation; historical rows/goal/plan/queue/interaction and the first frame are recovered by V4 durable materialization and ProductProjection. Do not build a legacy full snapshot nobody consumes just to activate the runtime or read usage; legacy `session/resume` keeps responding with activation + legacy snapshot for compatibility |
| turnIdAuthoritative | `turnId` is the CLI/runtime's authoritative turn identity; `turnIndex` / `ordinal` are display-only |
| stableHistoryTargetsPreferMessageId | history operations such as fork, edit, rewind, and file summary prefer stable `messageId` or `turnId`; only old data falls back to `turnIndex` |
| timelinePlacementFromProjection | timeline placement must come from the projection's `anchorTurnId` / `anchorMessageId` / `placement`, never inferred from the nearest user/assistant or array index |
| commandIdempotencyRequired | every conversation-changing command must have a `commandId` and support duplicate ACK, so retries cannot duplicate messages or stops |
| stopTargetsObservedForegroundExecution | Stop must carry the `foregroundExecutionId` projected at the user's click; within one runtime command, the primary turn, goal verifier, and goal continuation share the identity. The runtime cancels only the current matching execution; if the old execution already terminated and an unrelated new one took over, return noop — never stop the wrong new request. Once the execution is hit, cancelling local active work must not depend on whether the provider promise honors abort; the provider's late result can only be dropped, never delaying UI/runtime closure or reviving old work |
| trustedDeliveryBoundary | desktop (incl. SSH/WSL/Docker) is fixed continuous; mobile/Web remote is fixed replayable; a client cannot forge the profile |
| subscriptionOwnedByConnection | subscriptions and buffers are isolated per connection; frames go only to the owning attachment; a slow phone must not affect the desktop |

When a rule's effect violates an invariant, the Trace Tree generates a `violation case`, not an ordinary accepted case.

## Confirmed session-area semantics

This section records the currently confirmed ideal product semantics, not what existing code implements. Later case enumeration, pruning, and E2E generation align here first.

### State dimensions

```text
session.phase =
  draft
  prewarming
  running
  completed(success)
  completed(interrupted)
  error

activeWork.kind =
  primaryTurn
  foregroundSubagent
  compact
  goalVerifier
  goalContinuation
  turnSteer

followupMode =
  queue | guide

toolResultBatch =
  none | pending | committed

queue.length =
  0 | 1 | 2 | 3+

queue.autoDrain =
  true | false

compact.origin =
  manual | auto

collaborationMode =
  build | edit | plan | yolo
```

With `collaborationMode=plan`, a composer-submitted goal control command already recognized by the parser must be rejected at the UI admission boundary: show "goal cannot be used in Plan mode, please switch mode", keep the input text, and create no session, send no `sendGoalCommand` / `resumeGoal`, and write no prompt history. This guard runs before draft promotion, running-queue, and paused-queue adjudication, so runtime phase and queue state no longer expand this combination.

There is no separate `paused` session phase. After the user stops generation, the current turn enters `completed(interrupted)`; if the queue still holds messages, the queue stays with `autoDrain=false`. The UI calls this combination the "paused queue" and shows a resume banner above the queue items; product copy no longer exposes the internal term `held queue`.

When an ordinary primary turn enters `error`, it likewise only ends that turn and does not revoke already-accepted follow-up input: the queue stays verbatim and switches to `autoDrain=false`, the pause reason is marked as an error, and the user may click "continue" to resume head-first FIFO. The error path must not emit `TurnSteerDiscarded(reason=turn_failed)` and must not trigger an auto drain on the error terminal state. This recovery invariant applies equally to the shared CLI admission of desktop `desktop-continuous` and mobile `web-remote-replayable`; the latter must still respect replayable's snapshot/gap boundaries.

Paused-queue confirmation and resume timing:

```text
Stop
  -> payload.expectedForegroundExecutionId = the executionId of the current control.activeWorks
  -> CLI Runtime validates the current execution identity and atomically marks stopRequested
  -> identity switched: noop; must not cancel the later unrelated turn
  -> identity matches: abort the current execution
  -> completed(interrupted)
  -> queue kept, autoDrain=false
  -> UI: queue paused [continue]

Ordinary message or /goal <new target>
  -> open the send confirmation dialog (draft and attachments kept verbatim)
  -> clear queue: verify the confirmed queueItemId set is unchanged -> clear the old queue -> send the current input
  -> send message: verify the confirmed queueItemId set is unchanged -> keep the old queue paused -> send the current input

Click continue
  -> setAutoDrain(true)
  -> idle + target absent/complete: promote the current head
  -> target active/paused/budget_limited: only arm, wait for target complete
  -> busy: only arm; promote the head after the current active work closes
  -> Q1 -> Q2 -> ... -> queue empty
```

The dialog's `queueItemId` set validation is cross-client concurrency protection: if desktop or mobile adds/removes queue items after the dialog opened, the old confirmation is invalidated and re-confirmed against the latest projection; queue items the user never saw must not be cleared along with the rest. A withdrawn edit removes old queueItemIds and therefore invalidates the old confirmation; reordering only the same set of IDs does not widen the cleared set and may proceed. A compatible low-level call that uses `editQueueItem` to keep the same IDs in place also does not invalidate the confirmation.

`compacting` and `goalVerifying` are not top-level phases parallel to `running`; they are completion-blocking active work inside `running`, expressed as `activeWork.kind=compact` and `activeWork.kind=goalVerifier`.

An automatic compact runs around a `pendingAction` — the pending action that triggered the auto compact; it is not necessarily a message.

Typical `pendingAction` sources:

- An ordinary message the user sent directly in `completed, queue=0`.
- The head message taken during queue auto-consumption.
- A `/goal xxx` taken during queue auto-consumption.
- The turn input about to rerun after an edit user query.

### Running

| Precondition | User action | Product result |
| --- | --- | --- |
| `running, followupMode=queue` | send ordinary message | append to queue; the current turn is not interrupted |
| `running, followupMode=guide`, satisfying model/provider-independent runtime eligibility | send ordinary message | admission is guide; wait for the complete tool result batch, then consume at most one inline — no second turn starts |
| `running, followupMode=guide`, ordinary queue already present | send ordinary message | the guide still enters the current active turn; the existing queue keeps its future-turn FIFO order and forms no fallback guard |
| `running, followupMode=guide`, terminal without a tool batch, or ineligible due to attachments/Stop/non-steerable active work | send ordinary message | the same intent falls back to the queue in place, keeping payload, IDs, and admission FIFO; model/provider must not act as fallback guard |
| `running` | send `/goal xxx` | append to queue; update the goal on consumption if one exists, set it otherwise |
| `running` | send `/compact` | append to queue as `kind=compact` without interrupting the active work; the compact starts only when its turn comes |
| `running` | stop | the current turn ends `completed(interrupted)`; queue kept verbatim; `autoDrain=false` |
| `running` | fork stable assistant | allow; the target must be an earlier `completedSuccess` turn's last completed assistant; the child copies only stable conversation history, the parent keeps running, and the shared workspace is not rewound |
| `running` | fork current streaming assistant partial | reject |
| `running` | edit the last real user query | stop the active work first, then rerun from that query; queue kept verbatim and not auto-consumed |
| `running` | edit a non-last user query | reject or entry absent; historical turns cannot be rewound and no second active turn may start |

### Completed

| Precondition | User action | Product result |
| --- | --- | --- |
| `completed(success), queue=0` | send ordinary message | start the next turn immediately |
| `completed(interrupted), queue=0` | send ordinary message | start the next turn immediately |
| `completed(interrupted), queue>0, autoDrain=false` | send ordinary message | keep the normal send button; after submission open the confirmation dialog. Choosing clear empties the confirmed old queue then sends; choosing send keeps the old queue paused and sends immediately |
| `completed, queue>0, autoDrain=false` | `/goal <new target>` | same as ordinary messages: after the confirmation dialog, apply the clear/keep ruling; goal-control commands like `/goal resume` do not enter this dialog |
| `completed, queue>0, autoDrain=false` | queue "send now" | reserve the target item and start promoting; remove only on successful start, otherwise release the reservation and keep the item in place |
| `completed, queue>0, autoDrain=false` | withdraw/edit a queue item | when the composer is empty, delete authoritatively first, then restore the full input only to the initiator's own session/workspace composer; no consumption is triggered |
| `completed, queue>0, autoDrain=false` | reorder, delete queue | modify the queue only; no consumption |
| `completed, queue>0, autoDrain=false` | compact | no confirmation dialog; append to the paused queue tail keeping FIFO; still not auto-consumed |
| `completed, queue>0, autoDrain=false, target absent/complete` | click the queue banner "continue" | `autoDrain=true`; start from the head immediately and auto-consume by FIFO to empty |
| `running, queue>0, autoDrain=false, target absent/complete` | click the queue banner "continue" | `autoDrain=true` and arm; do not preempt the active work, auto-consume by FIFO after it closes |
| `queue>0, autoDrain=false, target active/paused/budget_limited` | click the queue banner "continue" | only set `autoDrain=true`; do not promote the head — wait for target complete, then auto-consume by FIFO; explicit `sendQueuedNow` is the exception |

### Queue

A queue item is a future user or maintenance intent, not bound to any history context. Therefore:

- Editing the last real user query does not clear the queue.
- Compact does not rewrite queue content.
- Fork does not copy the queue.
- Ordinary user input stores the complete Submission at enqueue, whose model and thinking depth express that submission's intent; at real consumption only the latest Provider config is re-read to create the Model — the session's later model selection is not substituted.

All clients' committed busy/running inputs enter the same CLI/runtime `CommandInbox` FIFO, ordered by CLI serial admission. A queue item is self-contained, storing the original `sourceCommandId`, stable `queueItemId`, `clientId`, kind (`sendText` / `sendGoalCommand` / `compact`), original text, attachments, delivery, order, and steer/dispatch state. When guide does not apply, attachments exist, compact/verifier is busy, or the runtime rejects steer, the input falls back to the ordinary queue with its original fields; empty, over-limit, or runtime-rejected must return explicit `rejected/failed` — the UI must not clear the payload first. When a `compact` is consumed it must go through the compact lifecycle, producing only a timeline marker: no real-user row, and no transcript query/edit/retry semantics.

First-party UI queue editing is fixed as `deleteQueueItem(baseRevision) -> accepted/duplicate -> local composer restore`. The restore payload includes the input kind, visible text, and ordered `AttachmentRef[]`; a goal's visible text is `/goal ...`, and compact offers no entry. If any of the composer's text, attachments, web context, session references, or in-progress uploads is non-empty, the withdrawal is rejected at the UI admission boundary with no command sent. During the request the target row and the composer lock simultaneously, preventing double-clicks or new drafts before the ACK.

The withdrawn original `sourceCommandId` settles with the queue removal; resending is a new user submission with new commandId, queueItemId, and submission time/order. The restored draft belongs only to the initiating renderer — it never enters snapshot or replayable state; other clients see only the queue removal. The request must bind the sessionId and `workspaceKey = workspaceIdentity?.trim() || workspacePath` at click time; repeated restore is idempotent, and switching session/workspace must not cross-write. When the target no longer exists, `deleteQueueItem` returns a distinguishable noop; stale/noop/rejected/failed all restore no old projection.

Restored attachment references keep their original order and complete fields and are marked session-owned: the session has taken them over, a resend must not re-upload/adopt, and deletion, runtime restart, and staged cleanup must not clear them by mistake. Images without a local object URL degrade to the file name and a type icon without extending the download protocol.

Guide and the ordinary queue share only input facts and the admission FIFO, not consumption triggers:

```text
guide: tool batch committed -> drain at most one inline -> same product turn continues
queue: session ready -> target absent/complete -> promote one head item as a future turn
```

Submitting a guide before any tool call appears is legal; the runtime waits for the next complete tool result batch. A parallel tool call must wait until all sibling results (success or failure) land as facts before consuming one guide. When a guide is accepted, its ModelSelection simultaneously becomes the Session Selection and creates a new Active Model at the next model step; requests already sent before acceptance keep the original Model. When the current turn completes text-only, is stopped, or is interrupted with no usable batch, the runtime must re-queue the same Submission in place with an explicit delivery/fallback fact, preserving Selection, payload, IDs, and admission order; live projection and cold hydration must agree, never re-queueing with new IDs.

Ordinary queue auto-promotion evaluates these chained guards, identically for every kind:

```text
head.dispatch=queued
  AND queue.autoDrain=true
  AND no active controller / session ready
  AND (target is absent OR target.status=complete)
```

A single `goal_verification completed` marker or `passed=false` is not enough to lift the guard. Explicit pass and fail-open both write `passed=true` first, then update the target to `complete`, and only then may ordinary queue promotion proceed. Manually terminating the verifier yields cancelled/failed + target paused with no auto-consumption. `sendQueuedNow` is an explicit reservation + stop-barrier path outside the auto-promotion guard.

The V4 wire schema adds no new command. The low-level `editQueueItem` remains as a compatibility capability that can update in place while keeping IDs, position, attachments, and source command, but first-party desktop, Web, and mobile UI no longer call it. `sendQueuedNow` is fixed as `reserve -> stop barrier -> start/promote -> remove`; across clients there may be only one reservation owner.

Scheduling atomicity: when auto-promotion finds the Bootstrap or Core foreground/runtime queue busy, it must not reserve/stop — it re-evaluates only when truly idle. An explicit `sendQueuedNow` must acquire a one-shot in-process Core promotion lease before the Stop, and by the original `sourceCommandId/inputId` let the promoted command dequeue ahead of already-waiting notifications. The lease is neither persisted nor projected and changes neither the desktop-continuous nor the mobile-replayable delivery boundary.

The queue is reliable only within the current CLI process. After a CLI restart, admitted inputs not yet in transcript/terminal state enter the discarded ledger, and `commands/query` returns `fault.command.inputDiscardedOnRestart` with the persisted `delivery`. The UI's 24-hour pending registry covers only the authoritative-unknown delivery window: a queue/guided projection, a restart query's `queue/guide`, or `unknown` all settle the account immediately; only a `startNow` that never entered the transcript keeps a manual resend confirmation; automatic replay is forbidden.

In `completed, queue>0, autoDrain=false`, when the user submits an ordinary message or `/goal <new target>` from the composer, the UI must open the confirmation dialog first — inline dual buttons must not replace the normal send button. Closing the dialog, Esc, or clicking the mask only cancels this submission; draft, attachments, and prompt history transfer nowhere. `/compact` is the exception: it appends to the queue tail and keeps the pause.

### Edit

| Precondition | User action | Product result |
| --- | --- | --- |
| `completed(success), queue=0` | edit the last real user query | rerun from that turn; later history is replaced by the new branch |
| `completed(interrupted), queue=0` | edit the last real user query | rerun from that turn; the interrupted result is replaced by the new branch |
| `completed(interrupted), queue>0, autoDrain=false` | edit the last real user query | rerun from that turn; queue kept verbatim; `autoDrain` stays false |
| edit rerun causes `running` | send another ordinary message | append to queue |
| edit rerun causes `running` | send another `/goal xxx` | append to queue |
| edit rerun causes `running` | send `/compact` | append to queue; the compact runs when its turn comes without interrupting the edit rerun |
| edit rerun causes `running` | edit the last real user query again | stop the current edit rerun first, then rerun with the latest edited text; queue kept verbatim |
| edit rerun causes `running` | edit a non-last user query | reject or entry absent; avoid a second rewind of a historical branch inside an active turn |

Only user queries may be edited; assistant and tool cannot.

Inline-edit attachments are part of the canonical input intent. First-party UI only allows deletions from the existing ordered `AttachmentRef[]` — no additions or re-uploads; the submission explicitly carries the current complete array: an omitted field means keep the original attachments, a non-empty array means replace, and `[]` means clear. An empty body with remaining attachments may rerun; body and effective attachments both empty must reject before the branch cut. Deletion affects only the new active branch and does not physically clean the old branch's attachment content.

Inline edit does not reuse the ordinary composer's long-paste-to-attachment state machine; a paste reaching 5120 characters stays `editUserQuery.newText`, avoiding new host/remote upload timing for a deletion capability.

### Fork

Only a `completedSuccess` product turn's last completed assistant may be forked. User, tool, timeline, current streaming/interrupted/failed partials, and middle assistant segments of the same turn cannot. New data resolves by persisted turn anchor; old data falls back only when unambiguous, otherwise `guard.forkTargetAmbiguous` is returned.

Forking a new session copies the pre-fork message history, the config persisted at the fork point, and the pre-fork goal state — not the parent's later config, queue, live background bash/subagent, pending background result, or continuation inbox. While a primary turn, foreground subagent, goal continuation, or goal verifier runs, an earlier stable history can still be forked; compact is the operation lock. If the parent is still running, its active work keeps belonging to it; the child evolves only from the stable fork boundary and does not rewind the shared workspace. The existing workspace checkpoint behavior of completed/idle forks is not expanded this round. Retrying the same `sourceCommandId` returns the same child.

The V4 conversation fork's model-only notice recovers as a `conversation_fork` Attachment: the persisted body carries no tag, and the provider projection wraps it in a `<system-reminder>`. Like the side chat, it never participates in MCS and always stays at the fork history boundary, before the child session's new question; the UI still shows only the `session_fork` timeline. The existing legacy/checkpoint fork's `rewind_notice` path keeps its behavior — old messages are not migrated and nothing is re-injected per turn.

```text
fork bundle: inherited history -> raw notice + Attachment metadata -> timeline boundary
hydrate:     inherited history -> conversation_fork Attachment
child send:  inherited history -> user <system-reminder>notice</system-reminder> -> user question
                                 (kept at this position for both MCS / non-MCS)
```

### Compact

Compact is manual or automatic.

Manual compact:

| Precondition | User action | Product result |
| --- | --- | --- |
| `completed, queue=0` | `/compact` or compact button | start the compact, insert timeline started |
| `completed, queue>0, autoDrain=false` | `/compact` or compact button | append to the paused queue tail; `autoDrain=false`; the compact does not start before the user resumes the drain or clicks run-now |
| `running` (incl. primary/tool/foreground subagent/goal continuation/goal verifier) | `/compact` or compact button | append to queue, strictly FIFO; the active work is not interrupted |
| `compacting` | send ordinary message | append to queue |
| `compacting` | send `/goal xxx` | append to queue |
| `compacting` | `/compact` again | reject, not queued |
| `compacting` | stop | stop the compaction; timeline marks interrupted; the session enters `completed(interrupted)`; queue kept and not auto-consumed |

Automatic compact:

```text
a pendingAction is about to execute
  -> the system decides needsCompact=true
  -> first enter compacting(origin=auto)
  -> insert the auto-compact timeline marker
  -> after the compact succeeds, continue pendingAction
```

An automatic compact is a system-scheduled pre-maintenance step and takes no user queue slot. It may appear before any turn, including direct user sends, queue consumption, goal consumption, and edit reruns.

A queued manual compact still executes as an explicit user intent even when an auto compact just ran before its turn; the runtime may return a noop marker, but UI/CLI must not silently remove it. When a queued manual compact fails or is stopped, the following queue goes held — auto-consumption must not continue past a maintenance failure/cancel.

Retry semantics:

- Automatic compact retries at most 3 times.
- Manual compact does not auto-retry.
- After an automatic compact succeeds, it must continue the `pendingAction` that triggered it, unless the user stops during the compact.

Auto-compact branches still pending confirmation:

- How to handle `pendingAction` after the auto compact still fails after 3 retries.
- How to handle `pendingAction` after the user stops an auto compact.

### Goal

`/goal xxx` sets or updates the session goal:

- In Plan mode, goal control commands are unavailable; the composer only toasts and keeps the input, creating or updating no goal.
- Without a prior goal, it sets one; with one, it updates it.
- There is no `goal validating` product state that needs to block user actions.
- Sending `/goal xxx` while running or compacting does not execute immediately; it appends to the queue.

### Model and thinking depth

Model and thinking depth are session-scoped storage:

- Where `renderer/configOptions` must temporarily represent `ZCodeModelRef` as a string, it uniformly uses `providerId/modelId$variant`; `$` is the variant-reserved separator of this display encoding. `:` always belongs to the provider's original `modelId` and must never be interpreted by the renderer as a variant — e.g. OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` must stay intact end to end. V4 commands, Agent snapshots, and persistence still use separate `provider` / `model` / `thought` or the structured `ZCodeModelRef`; this display string is not a new cross-process protocol.
- Switching to a historical session shows that session's own model and thinking depth in the top/input area.
- A new session uses the `provider + model + thought` tuple the user last explicitly selected and the runtime confirmed. The renderer persists one indivisible tuple; model and thought must not be restored as two unrelated global preferences.
- Opening or switching a historical session only displays that session's snapshot and must not rewrite the "last explicit selection" tuple; otherwise browsing history would silently change the next new draft's default model.
- When the user switches across models, the source model's thought does not represent the target model's intent. The runtime first selects the actual thought by the target model's capability, and the renderer persists the new tuple only after receiving the authoritative result; failed, stale, or not-yet-projected request values must not hit storage early.
- A draft-prewarm `createSession.config` may reference only models in the current Environment's Model Selection View. The Host must wait for this Environment's Provider Registry readiness before issuing `createSession`; it must not fill the not-ready window with Desktop snapshots, `runtimeModel`, or cross-Environment Registry pushes. Only after the current Registry confirms the original Provider's removal or disablement does the normal Worker fallback and compare-and-set persistence path apply.
- A model-identity change must synchronously clear the draft config's and the workspace default's thought that still belongs to the source model. Even if the target model supports a same-named tier, only the target model's default/actual tier applies; only a subsequent explicit thought switch by the user on the target model overrides it.
- The legacy split model/thought localStorage entries serve only as migration input: migrate only when both compose into one model config; an orphaned thought must not be applied to another model.
- An ordinary user Submission in the queue uses the model and thinking depth fixed at enqueue; Provider config, credentials, and model definitions are re-resolved from current Environment facts at execution.
- An ordinary session's first turn uses a silent initial model baseline and generates no `modelChange`. A fresh Subagent child publishes `ModelSelected(previousModelRef=null, modelRef=X)`, generating a source-less `modelChange` via the generic `∅→X` model boundary at the first turn's start, recoverable through transcript cold start. The shared projection recognizes only the silent-initial, source-less, and known model baselines — not Subagent identity; new boundaries must not be inferred from old child metadata or missing source fields alone.
- `modelChange.fromProvider/fromModel` must both exist or both be missing; the former is an ordinary A→B, the latter only a Subagent's initial actual model. The renderer only chooses "model switched" or "now using" copy by this structure; a missing source shows no switch arrow and appends no "model" after the provider/model label, while ordinary A→B display is unchanged.

### Draft collaboration-mode default

The global memory for `build/edit/plan/yolo` belongs to the renderer draft state only — it is neither a workspace default nor a session-recovery fact:

- Within one renderer, after the user explicitly selects a mode in any unsent draft, a localStorage preference without a workspace suffix is written; later new drafts in local or SSH/WSL/Docker workspaces initialize with that value.
- Draft prewarm and the first-send `createSession.config.mode` must carry it explicitly — never the Agent's old workspace/project mode first with an async switch later — avoiding a first-frame/first-send race.
- Opening a historical session, switching modes inside an existing session, and session snapshot recovery affect only that session; the draft global preference is never rewritten.
- When localStorage is missing, unreadable, or invalid, deterministically fall back to `build`; the old workspace mode takes no part in the fallback.
- Desktop renderer and mobile Web renderer have independent localStorage. This rule declares no cross-device sync; a mobile new draft inherits only the mobile browser's own preference.

### Multi-session concurrency

Different sessions run truly concurrently:

- While Session A is running, the user may switch to Session B.
- Session B may keep sending and enter running.
- There is no product-layer concurrency cap.
- Each session's queue, model, thinking depth, context, and right-sidebar state are isolated.

## Case review states

Every `case` node ultimately needs a human label.

| State | Meaning |
| ----- | ------- |
| accepted | the product expectation is clear; tests may be generated |
| undefined | protocol needs completing |
| invalid | this combination should be pruned by preconditions |
| ignored | the combination exists but the current version does not cover it |
| bug | the current implementation conflicts with the protocol expectation |

The review's output is not "is the tree pretty" but these artifacts:

- The confirmed product protocol.
- The list of undefined cases.
- Invalid pruning conditions.
- Bug candidates.
- Accepted cases that can generate E2E.

## Next step

Do not build complex entry UI yet. The next step aligns the current tooling's nodes and rule descriptions with this declaration:

- First batch of natural-language cases: [conversation-session-case-catalog.md](./conversation-session-case-catalog.md).
- MVP validation matrix: [conversation-session-validation-matrix.md](./conversation-session-validation-matrix.md).
- Session-area UI test-id contract: [conversation-session-ui-testid-contract.md](./conversation-session-ui-testid-contract.md).
- Trace Tree node overlays show `node type`, `input type`, `decision`, `rule id`.
- The rule list is grouped by `decision` and `invariant`.
- Case export carries the complete protocol fields, not just the title text.
- When `undefined` appears, it should be immediately visible which protocol layer is missing: state, input, rule, effect, or invariant.

## History-first execution boundary (2026-10-09)

A V4 session supporting historyFirst publishes the persisted history first; while runtimeInitialization is not ready, only reading and editing the local text draft are allowed — new execution commands are rejected and do not enter the accepted queue. On initialization failure the history stays and an explicit retry goes through the original subscription entry; an ordinary reconnect does not rerun a failed attempt. This state is independent of running/completed and changes neither desktop-continuous and mobile-replayable, model defaults, nor task activity timestamps. See `v4-refactor/17-cold-resume-runtime-activation.md`.
