# Conversation Session Product Protocol (current spec)

Updated: 2026-07-15

This is the current product protocol for V4 conversations. The schema authority is
`packages/shared/src/zcode-protocol-v4/`, CLI adjudication and projection live in
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`, and UI consumption in
`packages/ui/src/v4/`. The old `@zcode/protocol`, the legacy task stream, and the renderer
conversation reducer exist only in historical documents or compatibility layers and never override
this document's semantics.

Goal: define the conversation session's product behavior as a stable protocol so product,
development, QA, and E2E discuss state, actions, decisions, effects, and evidence in one language.
This document defines only the protocol layer: it does not expand the full rule table and does not
claim automation coverage.

This document integrates the shared semantics of existing documents first; where those documents
conflict, it does not silently pick a side but files the conflict under "pending boundaries". After
confirmation, findings are written back to the rule table, case catalog, and coverage matrix.

## Source Documents

| Document | Current role |
| --- | --- |
| [conversation-protocol-declaration.md](./conversation-protocol-declaration.md) | Pre-V4 terminology and adjudication history; not a current-implementation authority on conflict |
| [conversation-product-state-space.md](./conversation-product-state-space.md) | State-space and guard-pruning method; concrete fields follow the V4 schema |
| [conversation-session-case-catalog.md](./conversation-session-case-catalog.md) | Existing natural-language case catalog with current accepted, undefined, and extended cases |
| [testing/conversation-session-e2e-coverage-matrix.md](./testing/conversation-session-e2e-coverage-matrix.md) | Automation coverage matrix; states evidence status only, not a first source of product semantics |
| [testing/conversation-session-compact-decision-worksheet.md](./testing/conversation-session-compact-decision-worksheet.md) | Decision worksheet for compact failures and pendingAction |
| [testing/conversation-session-fork-cross-product-matrix.md](./testing/conversation-session-fork-cross-product-matrix.md) | Fork cross-product matrix: forkability, history boundaries, and future-state inheritance |
| `packages/shared/src/validationAppSettings.ts` | Validation and default for the app setting `zcodeInteractionBehavior = queue | guide` |
| `packages/shared/src/zcode-protocol-v4/` | Current schema for command, snapshot, delta, topic, and ACK |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/` | Current source of truth for command inbox, guards, projection, topic publishing, and recovery |
| `packages/ui/src/v4/ConversationComposer.tsx`, `conversationStatusPanelModel.ts`, `SessionPane.tsx` | Composer control, stop/status panel, command dispatch, and projection consumption |
| `packages/formal-proof/src/model.ts` | Current formal enumerator prototype, as the executable-protocol reference |

## Protocol Shape

The conversation session behavior protocol is defined by this adjudication function:

```text
ProductContext x InputEvent x TargetObject -> Guard -> Decision -> Effect -> Evidence
```

Meaning:

- `ProductContext`: the observable product context of the session before the user action.
- `InputEvent`: a user action or a system async event.
- `TargetObject`: what the action acts on — composer, queue item, assistant turn, user query.
- `Guard`: the product rule or pruning condition hit by the current combination.
- `Decision`: the product adjudication result.
- `Effect`: state transitions, data changes, UI feedback, and forbidden side effects.
- `Evidence`: UI, store, protocol, network, file, or log signals proving the decision correct.

The protocol is not a linear flowchart. The user's next GUI step is unpredictable, so candidate
combinations are enumerated first and guards adjudicate them. Case catalogs and E2E derive only
from confirmed guards/effects; they never replace the product protocol.

## State Ownership and Product Projection

The conversation's core product state is back-ended: the CLI / agent runtime owns the canonical
transcript, runtime work, command inbox, and conversation product projection; the UI keeps only
local interaction state that cannot be back-ended or must react immediately.

This projection is not a "virtual GUI" or DOM state. It is the CLI/runtime's normalized view of the
transcript, runtime facts, and product guards offered to renderer/web. It answers "what this turn
is, where it sits in the timeline, which actions are available, whether the session has ended, and
how input should be routed" — not "which panel is open, where the scrollbar is, what is hovered".

```text
CLI / agent runtime
|-- canonical transcript
|   |-- messages[]
|   `-- parts[]
|-- runtime facts
|   |-- activeWorks[]
|   |-- backgroundWorks[]
|   |-- pending permissions / elicitations
|   `-- active turn / compact / goal / fork facts
|-- command inbox
|   |-- accepted commands
|   |-- running commands
|   `-- failed / rejected / duplicate commands
`-- conversation product projection
    |-- turns[]
    |-- rows[]
    |-- timeline events
    |-- action availability
    |-- input routing
    `-- session control
          |
          | @zcode/shared/zcode-protocol-v4 semantics
          v
Host / service
|-- trusted connection context
|-- owned-subscription routing
|-- owner / lease / stale-run routing
|-- continuous / replayable recovery facade
|-- latest projection cache (soft state)
`-- no new conversation semantics
          |
          | @zcode/rpc transport
          v
Renderer / Web UI
|-- render projection
|-- send user intents as commands
|-- optimistic overlay before ACK
`-- local-only UI state
```

The current conversation schema lives in `@zcode/shared`'s `zcode-protocol-v4` module. The old
`packages/shared/src/zcode-protocol/index.ts` still serves non-V4 compatibility surfaces but is not
the entry point for new V4 conversation semantics. `@zcode/rpc` owns only channels, call/listen,
request/response, connections, logging, and telemetry — never conversation product semantics.
`productTurnId`, phase, actions, inputRouting, revision, seq, and command ACK belong to the V4
protocol/projection, not to RPC.

| Layer | Should own | Must not own |
| --- | --- | --- |
| CLI / agent runtime | transcript, turn/runtime identity, active/background work, command guards, conversation projection | DOM, scrolling, hover, panel open state |
| Host / service | trusted connection context, owned-subscription routing, owner/lease, continuous/replayable recovery, projection cache | new or modified conversation adjudication, a second conversation queue |
| Renderer / Web UI | draft, cursor, scroll, hover, focus, panel open, optimistic pending/stopping overlay | turn grouping facts, timeline ownership, session endedness, action availability |

### Projection Shape

The Conversation Product Projection is the authoritative UI input. New product semantics must land
in the projection first, never be inferred in the renderer from message-array positions and local
flags.

```ts
interface ConversationProductProjection {
  projectionVersion: number;
  revision: number;
  eventSeq: number;
  generatedAt: number;
  session: ConversationSessionProjection;
  turns: ConversationTurnProjection[];
  rows: ConversationRowProjection[];
  activeWorks: ConversationActiveWork[];
  backgroundWorks: ConversationBackgroundWork[];
  queue: ConversationQueueProjection;
  pendingCommands: ConversationCommandState[];
  actionAvailability: ConversationActionAvailability;
  inputRouting: ConversationInputRouting;
}
```

`rows[]` is the product-layer index that solves lost turns and timeline misplacement. The UI
renders the conversation from rows, not by re-guessing user/assistant/timeline boundaries from flat
`messages[]`. Old data lacking strong anchors may get fallback rows from a compatibility layer, but
fallback serves history recovery only, never as the protocol for new data.

Pagination metadata also describes only the current active branch: `totalCount` is the active
branch's total ordered row count and `firstRowId` its first ordered row — not the smallest `rowId`
ever assigned in the session. `rowId` assignment stays monotonic and may leave holes after a
rewind; when `row.removed(fromRowId)` trims from `firstRowId` or earlier and thereby cuts away the
whole active branch, the reduction must zero `totalCount` and clear `firstRowId`; the first
`row.appended` of the next new branch re-establishes `firstRowId`. The UI's "load earlier" may
appear only when the active branch genuinely has an unloaded prefix; old branches or rowId holes in
the append-only store must never be presented as pageable history.

```text
projection.rows
|-- turn:t1/input:user-msg-1
|-- turn:t1/assistant:msg-2
|-- turn:t1/worklog:compact-op-1
|-- turn:t1/post:goal-target-a-iteration-1
`-- turn:t2/assistant:msg-9              # background model-only wake is its own turn, no visible user trigger row
```

### Persistent Authority, Canonical Facts, and Addressable Identity

The persistent authorities of the conversation are fixed: `message`, `part`, session metadata, and
goal state. Projection rows, renderer stores, in-memory eventStores, `rowId`, and DOM order are
never a second authority for these facts. Live events and cold hydration must first normalize into
the same set of canonical facts, then a single resolver/materializer generates turns, rows,
actions, and command targets:

```text
live SessionEvent --------------------\
                                       +-> CanonicalFact[] -> resolver -> projection
cold message/part/session/goal facts -/
```

- Persisted body text, timeline, session metadata, and goal follow the persistent facts; live adds
  only in-flight/ephemeral facts not yet persisted, deduplicated by persistent entity key.
- `rowId` is for display, virtual scrolling, and diff within one projection/materialization only;
  it may change after refresh, cold recovery, fork, or rewind and must never be a business target
  for edit/retry/fork.
- Actionable rows must carry both a stable `entityId` and `productTurnId`; command payloads address
  stable entity identity, and the CLI generates `row.actions` and the command target atomically at
  the same revision.
- Live/cold equivalence compares more than visible text: canonical entities, turn ownership,
  action availability, command targets, goal intent, and final session metadata must all match.
- A user stop cancelling a model request is `completed(interrupted)`, not a `TurnError`. Even if the
  underlying assistant message persisted an `error` to keep provider debug info, its typed
  cancellation code/result must normalize to `TurnComplete(cancelled)` during cold hydration;
  standard cancellation errors generated by ZCode itself in historical data need compatible
  recovery. Rebuilding a cancellation as `phase=error` or filling `control.lastError` merely
  because `assistant.info.error` exists is forbidden.
- Desktop `continuous` and mobile `replayable` may show different intermediate frames; after both
  converge, their canonical facts and terminal projection are field-for-field identical. This
  delivery difference does not expand into per-case duplicated terminal-state permutations.

### Command and ACK Model

Session actions initiated by Renderer/Web are expressed as command intents, never as direct edits
of local conversation facts. The CLI/runtime adjudicates by the current projection revision,
guards, and idempotency keys, returns an ACK, and lets the UI converge via subsequent
projection/events. The host may route commands by owner/lease but must never build a second
accepted-input queue outside the CLI.

```text
UI local intent
  -> command(commandId, clientId, baseRevision, type, payload)
  -> transport by @zcode/rpc
  -> host attachment injects {connectionId, trusted clientMode}
  -> guard / dedupe / enqueue / execute in CLI CommandInbox
  <- ACK accepted | rejected | stale | duplicate | failed
  -> projection revision increases
  -> UI reconciles optimistic overlay with projection
```

| ACK | Meaning | UI result |
| --- | --- | --- |
| `accepted` | the command entered the authoritative command inbox or executed immediately | keep the optimistic display, wait for projection confirmation |
| `rejected` | a guard explicitly rejected the command | remove the optimistic display, show the protocol reason |
| `stale` | the command was based on an outdated projection; refresh first, then retry or confirm with the user | pull the latest projection; never silently replay non-idempotent actions |
| `duplicate` | the same `commandId` was already processed | reuse the existing result; avoid duplicate messages or duplicate stops |
| `failed` | the command was accepted but execution failed | show the error per the fault catalog and keep a recoverable state |

Every conversation-changing command must have idempotent identity: `commandId`, `clientId`,
`sessionId`, optional `baseRevision`, and a business target. `clientMode` is injected by the host
attachment as trusted — the UI never chooses it. Over second-scale web links UI staleness is
allowed; per-renderer local state need not be synchronously fresh. The correctness boundary is
that `revision + eventSeq + snapshot/projection` can re-converge the UI to authoritative state.

### Connection, Subscription, and Recovery Boundaries

Desktop windows (including SSH/WSL/Docker) are fixed to `desktop-continuous`; mobile `/remote` and
Web remote are fixed to `web-remote-replayable`. Both may subscribe to the same session, but every
attachment gets its own host-assigned `connectionId` and independent subscription registry, and the
UI-facing subscribe must not override the profile.

```text
Desktop attachment A (continuous) ── sub-a ──┐
                                             ├─> CLI's single projection/event log
Mobile attachment B (replayable) ── sub-b ──┘

frame(subscriptionId=sub-a) -> only port A
frame(subscriptionId=sub-b) -> only port B
port B saturated/resync      -> A unaffected
```

Downstream frames must be delivered only to the owning port by `subscriptionId`; workspace
broadcast followed by client-side discarding of others' frames is forbidden. Snapshots replace
wholesale; late frames with `toSeq <= localSeq` are dropped silently; a gap triggers exactly one
in-flight resync, and a further gap after resume escalates to a forced snapshot. Attachments
resubscribe automatically after being rebuilt or after a CLI runtime epoch change. Relay/main only
forward RPC payloads and connection-level `saturated/drained` signals and hold no conversation
business state such as sessions, streams, queues, or snapshots.

On ACK loss or reconnect, the UI reconciles via `commands/query` (at most 64
`{sessionId, commandId}` per call). The CLI looks up in a fixed order: in-memory LRU ->
transcript/message anchor -> timeline marker -> fork child metadata -> discarded input ledger ->
unknown. Queries and executions of the same key share single-flight, so a query window never
induces duplicate execution.

While the same `commandId` is executing, both duplicate requests and `commands/query` await the
same final-result promise of that in-flight command; returning an admission ACK without `result`
early is forbidden. Whatever the final outcome — accepted, failed, or noop — the session's
admission FIFO is released only after the promise settles, including on exception paths, so later
commands never deadlock.

```text
first request ── execute once ──> final ACK(result=child-X) ──> release session FIFO
duplicate    ── await same promise ─────────────────────────> duplicate(result=child-X)
commands/query ─ await same promise ────────────────────────> accepted(result=child-X)
```

## Product Context

### Session Phase

| Value | Meaning |
| --- | --- |
| `draft` | no formal session created yet; the user is still typing the first query |
| `prewarming` | the first send was submitted; the session is preparing or the first turn has not reached stable running |
| `running` | the session has an active foreground turn or completion-blocking active work executing, including assistant/tool/foreground subagent/compact/goal verifier/goal continuation/turn-steer |
| `completed(success)` | all completion-blocking active work of the session closed normally and next actions are accepted; background work may remain pending |
| `completed(interrupted)` | a user stop or equivalent interrupt ended the completion-blocking active work; next actions are accepted; background work may remain pending |
| `error` | the session entered an error state; recovery semantics come from the fault catalog |

`compacting` and `goalVerifying` are not top-level phases parallel to `running`; they are active
work kinds inside `running`. Where this document needs those contexts it writes
`activeWork.kind=compact` and `activeWork.kind=goalVerifier`.

There is no separate `paused` product state. After stopping generation, the session's
completion-blocking active work must first be terminated before entering `completed(interrupted)`;
if the queue holds messages, the queue stays and `autoDrain=false`. A background-only cancel is
not a session stop.

### Active Work and Completion Gate

Whether a session is complete cannot be judged from the assistant stream alone; it depends on the
set of completion-blocking active work owned by the session being empty. `activeWork` in this
document defaults to the foreground work that blocks `sessionEnded`; background bash and background
subagents are session-owned background work and do not block session completion.

Picture a conversation session as this folder. Everything under `foreground-work/` belongs to the
session's completion gate; only when that folder is empty may `sessionEnded` be `true`.
`background-work/` still belongs to the session but does not lock it in running.

```text
session/
|-- identity-and-config/
|   |-- sessionId
|   |-- workspace identity
|   |-- provider/model/thought config
|
|-- queue/
|   |-- deferred sendText
|   |-- deferred sendGoalCommand
|   `-- other future input allowed by guards
|
|-- foreground-work/                  # decides sessionEnded
|   |-- primary-turn/
|   |   |-- assistant/model stream
|   |   |-- tool calls and blocking requests
|   |   `-- tool results
|   |
|   |-- subagents/
|   |   `-- foreground subagent
|   |
|   |-- compact/
|   |   |-- manual compact
|   |   `-- auto compact pendingAction
|   |
|   |-- goal/
|   |   |-- goal verifier
|   |   `-- goal continuation
|   |
|   `-- turn-steer/
|       `-- guide-mode follow-up not yet drained
|
|-- background-work/                  # does not decide sessionEnded
|   |-- background bash
|   `-- background subagent
|
|-- continuation-inbox/
|   `-- backgroundResult -> synthetic user input for a future foreground run
|
`-- lifecycle/
    |-- draft
    |-- busy: prewarming/running while foreground-work/ is not empty
    `-- completed(success/interrupted) once foreground-work/ is empty
```

| Completion-blocking active work | Meaning | Completion threshold |
| --- | --- | --- |
| `primaryTurn` | the main assistant turn, model stream, tool calls, or blocking requests triggered by the current user input | normal completion, failed closure, or stop interrupt |
| `foregroundSubagent` | a child agent/child request derived by the main turn that must be summarized within the current assistant round | the foreground subagent completes, fails, or is stopped |
| `compact` | the compaction request and pendingAction pre-maintenance of a manual or auto compact | the compact completes, noops, fails, or is stopped |
| `goalVerifier` | the achievement-verification request for the goal target | the verifier returns pass/notSatisfied, fails, or is stopped |
| `goalContinuation` | the next-step execution chain auto-continuing after an unmet goal | the continuation completes, enters the next active work, or is stopped |
| `turnSteer` | guide-mode follow-up submitted to the runtime but not yet confirmed drained | confirmed by the runtime, rejected, fallen back to the queue, or closed by stop |

| Background work | Meaning | Product closure |
| --- | --- | --- |
| `backgroundBash` | bash/process work derived by the main turn but declared background | does not block `sessionEnded`; produces a background result on completion |
| `backgroundSubagent` | a subagent derived by the main turn but declared background | does not block `sessionEnded`; produces a background result on completion |
| `backgroundResultContinuation` | follow-up input triggered when a background result returns to the main session | enters `continuation-inbox`; may start a new foreground run or queue while busy/held |

`BackgroundTaskStarted/Updated/Completed` must carry the runtime-adjudicated
`taskKind: "bash" | "subagent"`; `toolName` keeps only tool provenance and legacy-event
compatibility and is no longer the product classification authority for new projections.
Legacy-event compatibility must recognize historical aliases such as `Agent`, `Task`, and
`subagent` through one shared legacy resolver — never separate string checks in the reducer,
service, and UI. `backgroundWorks[].kind`, cancel capability, and UI icons all materialize from
this canonical fact, keeping terminal classification identical between the desktop continuous and
web replayable snapshots.

`completed(success)` and `completed(interrupted)` both require completion-blocking
`activeWork=empty`. If `assistantComplete` arrives while a foreground subagent, compact, goal
verifier, goal continuation, or undrained turn-steer remains, the session is still busy: it must
not enter completed and must not open completed-only actions. Background bash/subagents take no
part in this completion gate; they still belong to the parent session but surface only through
`hasBackgroundWork`, the background drawer, or the continuation inbox.

When a background result returns to main, the provider view may use `role=user` as next-round
input, but the product/protocol layer must preserve the equivalent of `origin=backgroundResult`,
`backgroundSource=bash|subagent`, `humanAuthored=false`. It is not a hand-written user query: it
must not automatically inherit edit-user-query or ordinary retry entry semantics. If it has
already materialized into visible transcript before the fork point it participates in fork like
ordinary stable history; otherwise a pending background result is not copied to the fork child.

Ordinary retry must first lock onto the timeline-latest `assistantText`, then check whether the
same product turn has a canonical user input with `origin=realUser`. Model-only/synthetic turns
such as background results, goal continuations, and mailbox turns — even when they are the latest
assistant — show no ordinary retry; and an earlier assistant triggered by a real user must not
regain retry then. Retry moves to the new latest turn only after the next real user input
completes a new assistant turn.

```text
real user Q1 -> assistant A1 [retry]
                       |
                       +-- background done -> synthetic wake -> assistant B1
                                                     |             |
                                                     |             +-- no retry
                                                     +-- A1 no retry (not revived backward)

real user Q2 -> assistant A2 [retry]  # A2 is the new timeline-latest assistant with a realUser cause
```

When a background result triggers continued main execution, the UI's "how long working" drawer uses
a new foreground work interval and does not fold background waiting time into the previous
assistant interval. The product feel may be "the conversation suddenly started again", but in
state terms it is a new foreground run triggered by the background result.

`sessionBusy` in this document means `prewarming`, `running`, or any context with
completion-blocking `activeWork!=empty`. With only `backgroundWork!=empty`, `sessionBusy=false`
and completed-only actions may open per their own guards.

### Session Endedness and Input Routing

`sessionEnded` is a product-state derived value answering exactly one question: can the current
composer input immediately become the next active turn. It does not redefine agent/runtime hook
timing and does not make any hook a product completion gate. It must come from CLI/agent runtime
facts or a host/service normalization of those facts; the UI must never judge it from the assistant
text stream, timeline bars, or a local `streaming` flag.

| Determination | Condition | Product meaning |
| --- | --- | --- |
| `sessionEnded=false` | `prewarming`, `running`, or any completion-blocking `activeWork!=empty` | the session has not ended; new composer input is a future intent and cannot start a second active turn directly |
| `sessionEnded=true` | `completed(success)` or `completed(interrupted)` with completion-blocking `activeWork=empty`; `backgroundWork` may be non-empty | the session has ended; completed-only actions open; ordinary input may start the next turn per queue state |

While `sessionEnded=false`, ordinary `sendText` defaults to the queue; in
`running + followupInput.mode=guide` satisfying turn-steer conditions it is submitted to the
runtime by guide rules, otherwise it falls back to the queue. `sendGoalCommand` also queues and
sets or updates the goal only when consumed.

`/compact`, fork, edit, and `sendQueuedNow` are not auto-queued by `sessionEnded=false`; each must
hit its own guard: for example, `/compact` during busy is still rejected; `sendQueuedNow` may
stop-then-drain only in contexts that explicitly allow preemptive consumption; fork is adjudicated
by whether the target assistant turn is stable, not blanket-rejected because the parent session is
running. `activeWork.kind=compact` keeps its operation lock; `activeWork.kind=goalVerifier` is not
an independent operation lock — message-type inputs still queue and stop may interrupt the
verifier.

### Runtime Facts and Control Projection

Session lifecycle state has three layers: first the CLI/agent runtime facts and product
projection; second the host/service transport, owner routing, caching, and replayable recovery;
third the UI rendering and optimistic overlay.

```text
CLI / agent runtime facts + product projection
  |-- activeWorks[]                  # completion-blocking foreground work
  |-- backgroundWorks[]              # background bash/subagent, does not block sessionEnded
  |-- backgroundResult facts
  |-- activeTurnKind
  |-- activeInputId / runId
  |-- compact timeline fact
  |-- goal target / verifier / continuation fact
  |-- foreground subagent fact
  |-- background bash/subagent fact
  |-- pending requests / permissions / tool calls
  |-- sessionEnded
  |-- hasBackgroundWork
  |-- canStop
  |-- stopState: idle | stoppable | stopping
  |-- stopTargetKind
  `-- inputRouting: startNow | enqueue | guide | reject

Host / service transport and recovery layer
  |-- expose latest projection over RPC
  |-- route owner commands
  |-- preserve replayable watermarks / snapshots
  `-- cache but do not invent conversation semantics

UI
  |-- render stable stop button from canStop/stopState
  |-- route composer submit from inputRouting/sessionEnded
  |-- show detail text from stopTargetKind, not from local guessing
  `-- keep local-only draft / scroll / focus / optimistic overlay
```

The fact layer must be produced by the CLI/agent runtime. Host/service may normalize, cache, and
forward projections from CLI snapshots, event streams, and replayable gap recovery, but must not
independently define new conversation product adjudication. The UI may show a brief optimistic
`stopping` but must not declare the session ended; true endedness waits for completion-blocking
`activeWorks=[]` or an equivalent `sessionEnded=true` projection. `backgroundWorks[]` may only
affect the background drawer, continuation inbox, and background cancel entry — never flip
`sessionEnded` back to `false` alone.

The product control layer keeps the UI's interaction shell coarse and stable without losing
internal detail:

| Field | Values | Meaning |
| --- | --- | --- |
| `sessionEnded` | `true` / `false` | whether composer input may immediately become the next active turn |
| `hasBackgroundWork` | `true` / `false` | whether the session still has background bash/subagent pending; does not drive the main stop button |
| `canStop` | `true` / `false` | whether the session has completion-blocking active work that a user stop can terminate |
| `stopState` | `idle`, `stoppable`, `stopping` | the stable stop-button display; clicking may optimistically enter `stopping` until the authoritative projection converges |
| `stopTargetKind` | `assistant`, `tool`, `subagent`, `compact`, `goalVerifier`, `goalContinuation`, `mixed`, `unknown` | which work kind this stop will mainly act on; affects tooltip, logs, telemetry, and detail copy only — never button visibility/flicker |
| `inputRouting` | `startNow`, `enqueue`, `guide`, `reject` | the product adjudication summary for the current composer input; must be traceable to a rule-table guard |

The stop button must not flicker across active-work handoffs like
`assistant -> compact -> goalVerifier -> goalContinuation`. As long as `canStop=true` or
`stopState=stopping`, the UI keeps the same stop button; a `stopTargetKind` change may only update
the tooltip/auxiliary text, never make the button disappear and reappear.

`stop` itself remains a session-level user action. On stop, the CLI/agent runtime acts precisely on
the current completion-blocking active work: during assistant output it aborts
assistant/tool/foreground subagents, during compact it aborts the compact, during goal verifier it
aborts the verifier, during goal continuation it aborts the continuation. With only background
work pending, the session's main stop button must not keep showing; cancelling background
bash/subagents goes through background task control and does not change `sessionEnded`. If the
goal target is `active`, any foreground stop must move the target to a non-active paused state;
only an explicit resume may reactivate it.

### Stop Priority

`stop` is the highest-priority user action within a session. Whenever the session is not
completed, `stop` outranks queue drain, guide injection, auto goal continuation, compact
pendingAction, and late runtime terminal events.

| Scenario | Protocol |
| --- | --- |
| `running + stop` | terminate the primary turn, tool/blocking requests, all running foreground subagents, goal continuation, goal verifier, and unconfirmed turn-steer |
| `running + activeWork.kind=compact + stop` | terminate the current compact; manual/auto compacts may not keep writing success results, and an auto compact's pendingAction must not execute after the stop |
| `running + activeWork.kind=goalVerifier + stop` | terminate the current verifier; this verifier run counts as `failed(cancelled)` and may no longer trigger pass/notSatisfied follow-ups |
| `running + sendQueuedNow` | equivalent to executing the highest-priority `stop` first, then consuming the clicked queue item once completion-blocking active work is empty; `activeWork.kind=compact + sendQueuedNow` still rejects per the operation lock; `activeWork.kind=goalVerifier + sendQueuedNow` may drain after the stop barrier |
| `stop requested + late terminal event` | a late foreground subagent/compact/verifier/assistant completion may only close out the stopped old work; it must not flip the session back to success or override a new round of active input |
| `backgroundWork only + stop` | the main stop button is unavailable; cancelling from the background drawer is background task cancel, not a session stop |

`stop` is not an ordinary queue item and cannot wait in line. A transient `stopRequested` marker or
a UI "stopping" display may exist, but it is not an independent product phase; ultimately there is
only `completed(interrupted)` after completion-blocking active work empties, `error` after an
explicit failure, or a new active turn started later.

### Queue

| Dimension | Values | Meaning |
| --- | --- | --- |
| `queue.length` | `0`, `1`, `2`, `3+` | length equivalence classes for GUI display and case convergence |
| `queue.autoDrain` | `true`, `false` | whether the queue head is consumed automatically after the current turn |

The queue holds future user intents, not completed history. All inputs already submitted from
desktop or mobile that cannot start immediately while busy/running enter the authoritative FIFO of
the single CLI/runtime `CommandInbox` in serial admission order; a desktop renderer-local queue and
a mobile host runtime command queue are both not a second V4 source of truth. The UI keeps only
unsubmitted drafts and a brief optimistic overlay.

Every queue item must be a self-contained `ConversationInputIntent`, conserving at least
`sourceCommandId`, `queueItemId`, `clientId`, input kind, original text, attachments,
delivery/fallback, admission order, and steer/dispatch state. The queue item, drain/guided events,
the user row, and the transcript message anchor use the same original `sourceCommandId`; edit,
promotion, or send-now must not swap in the operating command's new id.

For example: `running + sendText` may queue as a deferred `sendText`; `running + sendGoalCommand`
may queue as a deferred `sendGoalCommand`; `running + sendCompactCommand/clickCompact` must reject —
being a slash command does not let `/compact` into the queue. When new commands are added, their
`allow`/`enqueue`/`reject` per state must be declared in the rule table first; they never
auto-inherit `/goal`'s queueing semantics.

Edit, compact, and fork must not rewrite queue content; a forked child session does not copy the
parent queue. The queue executes only when truly consumed, against the session's latest context,
model, and thinking depth at consumption time.

`editQueueItem` modifies the authoritative item in place, preserving IDs, position, attachments,
client, and source command. `sendQueuedNow` uses `reserve -> stop barrier -> start/promote ->
remove`: removal happens only on successful start; timeout or failure releases the reservation and
the original item stays in place; consecutive clicks or cross-client races may have only one
reservation owner.

The queue is reliable only within the current CLI process. After a CLI runtime restart, inputs
admitted by the previous process that never entered the transcript go to the discarded ledger, and
`commands/query` returns `fault.command.inputDiscardedOnRestart` with the persistent `delivery`.
The UI's 24-hour pending-command registry covers only the unknown-delivery window (sensitive
interactions store only a digest): the account clears as soon as a queue/guided projection
arrives; a restart query's `queue/guide` and the `unknown` without an authoritative verdict settle
silently with no UI error; only a `startNow` that never entered the transcript prompts the user to
confirm a resend — automatic recovery or replay is forbidden.

A background result returning while foreground is busy, compacting, verifying, or holding a queue
must first enter the `continuation-inbox` or an equivalent deferred queue item. It may appear as
`role=user` in later provider requests, but the queue/event must keep `origin=backgroundResult` so
it is never mistaken for a hand-written user query, wrongly given edit, or copied to a fork child
as a pending future input.

When a background result truly triggers a model-only wake, live or cold, it must create a new
independent `productTurnId`. That turn has no visible user trigger row and shows only its own
assistant/work rows; it must not merge into the previous real-user turn because of runtime turn
reuse, arrival order, or refresh recovery.

### Follow-up Input Mode

`followupInput.mode` defines how ordinary follow-up text typed in the composer is handled while
the same session is `running`. It is not a queue-item type; it is the routing strategy for running
follow-ups.

| Value | Default | Meaning |
| --- | --- | --- |
| `queue` | yes | follow-up text enters the CLI authoritative queue, waiting for the active turn to finish or an explicit `sendQueuedNow` |
| `guide` | no | eligible follow-up text enters agent-side turn steering as guidance for the current active turn; ineligible input falls back to the CLI queue |

`guide` mode does not mean rewriting in-flight requests already sent to the provider. It only
submits a complete input intent to the runtime's turn-steer mechanism and waits for confirmation,
rejection, or fallback. When guide does not apply, the input has attachments, compact/verifier is
busy, or the runtime rejects steering, the input must fall back to the CLI queue with its original
fields. Empty, over-limit, or admission/runtime rejections must return explicit `rejected/failed`
so the UI keeps the text and attachments. In both `queue` and `guide`, user input is preserved: it
may never disappear from the composer or transient state into neither queue/guided row/transcript
nor an explicit `rejected/failed/discarded` outcome.

After the runtime confirms injecting a guide, the product turn is unchanged, but the CLI must
close the previous visual work segment in `turnHeader.workSegments` and open a new one keyed by
the guided user's stable entity ID. The UI shows and folds "worked/working" per segment
independently; these are workspace boundaries only and do not change the final assistant's
fork/retry/action ownership.

`followupInput.mode` decides only whether ordinary text during an ordinary assistant run queues or
attempts guide. In non-steerable contexts with `sessionEnded=false` such as
`activeWork.kind=compact` or `activeWork.kind=goalVerifier`, guide does not apply: ordinary text
and `/goal` both enter the queue as deferred input.

Confirmed boundaries:

| Scenario | Protocol |
| --- | --- |
| `running + followupInput.mode=queue + sendText` | queue as deferred `sendText`; the active turn is not interrupted |
| `running + followupInput.mode=queue + sendGoalCommand` | queue as deferred `sendGoalCommand`; goal is set or updated on consumption |
| `running + followupInput.mode=guide + sendText + guide eligible` | enter turn-steer submitting/queued, or project as a guided user message after runtime confirmation |
| `running + followupInput.mode=guide + sendText + guide ineligible` | fall back to a deferred `sendText` queue item |
| `running + followupInput.mode=guide + sendGoalCommand` | still follows `sendGoalCommand`'s state rules; currently queues as deferred `sendGoalCommand` unless a future rule table explicitly accepts goal steering |
| `activeWork.kind=compact/goalVerifier + sendText/sendGoalCommand` | queue as deferred input; no new turn starts, the active work is not interrupted |
| `running + sendCompactCommand/clickCompact` | unaffected by follow-up mode; always reject — not queued, not sent as an ordinary message, no compact started |
| `sendQueuedNow` | an explicit queue-preempting consume action (zh UI may call it 「立即引导」); it is not the same as `followupInput.mode=guide` |

### Compact

| Dimension | Values | Meaning |
| --- | --- | --- |
| `compact.origin` | `manual`, `auto` | user-initiated or system pre-maintenance |
| `compact.memory` | `never`, `compactable`, `justCompacted`, `notNeeded` | whether the context needs or allows further compaction |
| `compact.canCompactAgain` | `true`, `false` | whether compacting again right after a compact can still produce useful compression |
| `compact.pendingAction` | ordinary send, queue item, queued goal, edit rerun, etc. | the action to continue after a successful auto compact |

Auto compact is a system-inserted pre-maintenance step and takes no user queue slot. It runs around
a `pendingAction`; on success it continues that action. After a stop, an auto compact must not
continue its `pendingAction`; whether the pendingAction returns to the held queue, stays for user
confirmation, or is dropped remains governed by the compact decision worksheet.

### Goal

| Value | Meaning |
| --- | --- |
| `none` | the session has no goal target |
| `active` | the session has an unfinished target |
| `verifying` | the verifier is judging whether the target is achieved |
| `verified` | the verifier judged it achieved |
| `notSatisfied` | the verifier finished normally but judged the target not yet achieved |
| `failed` | the verifier was cancelled, hit an API failure, timeout, or internal error and produced no valid verdict |

`notSatisfied` and `failed` must stay separate. `notSatisfied` is a valid verification conclusion —
the goal is not done; auto-continuation, waiting for user input, or queue handling per goal rules
may follow. `failed` means the verification itself failed with no reliable conclusion and must not
be treated as a business "goal not achieved" judgment.

`/goal xxx` sets or updates the session goal: setting when there is none, updating when there is
one. `/goal` while running is a future intent: it queues and sets or updates the goal on
consumption.

The `goalSet` lifecycle/state fact only updates goal state and generates no timeline marker/row; it
and the user-submitted goal input are two different facts. Every accepted and materialized user
goal input must generate a canonical, visible real-user row and use the unified `editUserQuery`
action/target exactly like an ordinary text query. Only the current active branch's latest
real-user input is editable; when it is a goal input, the stable `entityId/productTurnId` must
resolve back to the original `ConversationInputIntent(kind=goal)` and the resend still routes as
`sendGoalCommand`, never degrading to plain `sendText`. Cold recovery of goal state takes the
persisted goal facts as authority, never re-deriving from visible `/goal` text.

### Fork

A fork derives a child session from a stable assistant turn of the parent session. It neither
copies the current window state nor copies the parent's future action queue or live background
work. The parent session may be running a new foreground turn or background work; as long as the
fork target itself is already stable assistant history, the fork is allowed.

| Dimension | Protocol |
| --- | --- |
| `fork.sourceSession` | the parent session that triggered the fork |
| `fork.target` | must be the last completed assistant segment of a `completedSuccess` product turn; current streaming/interrupted/failed partials and middle assistant segments are not fork targets |
| `fork.historyBoundary` | the single CLI resolver returns turnId, ordered messageIds, and boundaryMessageId; the child inherits only the boundary and the stable visible transcript before it |
| `fork.configSnapshot` | the child inherits the provider/model/thinking config persisted at the fork point; it does not read the parent's later config |
| `fork.goalSnapshot` | the child inherits the goal target, iterations, and verifier timeline from before the fork point |
| `fork.queuePolicy` | the parent queue is kept; the child queue is empty |
| `fork.backgroundPolicy` | the parent's live background bash/subagents, pending background results, and continuation inbox are not copied; only background results already materialized into stable transcript before the fork point are copied as history |
| `fork.workspacePolicy` | a running fork copies conversation only and does not rewind the shared workspace; the existing checkpoint behavior of completed/idle forks is not expanded this round |
| `fork.timeline` | the fork notice is a turn boundary; it enters neither the assistant work history nor the "worked" folding |

Fork permissibility is adjudicated by history stability:

| Precondition | Target | Decision | Notes |
| --- | --- | --- | --- |
| `completed(success)` or `completed(interrupted)` | assistant message/turn | `allow` | create the child session; inherit pre-fork history and the config persisted at the fork point |
| `running + activeWork.kind=primaryTurn/foregroundSubagent/goalContinuation/turnSteer` | stable historical assistant message/turn | `allow` | a running parent does not make the fork target unstable; the child inherits only pre-fork history, not the current active work |
| `backgroundWork!=empty`, whether or not the parent is completed | stable assistant message/turn | `allow` | background bash/subagents do not block fork; live background handles and pending results still belong to the parent only |
| `prewarming` with no stable assistant target | any assistant message/turn | `reject` | no stable assistant history exists yet as a fork boundary |
| `activeWork.kind=compact` | any assistant message/turn | `reject` | a compact is rewriting/maintaining the context boundary; a child cannot be created simultaneously |
| `activeWork.kind=goalVerifier` | stable assistant message/turn | `allow` | a running verifier does not make the historical target unstable; the child inherits only pre-fork stable history, not the verifier or the later goal loop |
| any state | the currently streaming assistant partial | `reject` | a partial is not yet a stable transcript boundary |
| `error` or failed/error partial that has not formed a `completed(interrupted)` product terminal state | assistant partial | `reject` | the partial history is unstable |
| any state | user message, tool message, timeline marker | `reject` or entry absent | fork points are defined only on assistant messages/turns |

The parent session continues afterwards per its own queue, goal, config, foreground/background
work, and run state — unaffected by the child. A running fork does not pass through any
idle-requiring legacy bridge and does not restore, roll back, or copy the shared workspace
checkpoint; the child receives only the stable transcript, the config persisted at the fork point,
and the pre-fork goal state. The child's later requests use the fork-point config snapshot and
then evolve with the child's own config changes. If the parent's background bash/subagent returns
after the fork, it can only wake the parent session; it must not call back into the child or
generate synthetic user input in the child.

New data uses persisted turn anchors; old transcripts allow fallback only when the logical turn
boundary is unambiguous, otherwise `guard.forkTargetAmbiguous` is returned. Turns containing tool
calls copy the tool blocks, tool results, final assistant, and the file facts that turn produced,
per logical boundaries — never truncating at the last raw assistant message. Retrying the same
`sourceCommandId` must return the same child.

Stable fork creation is one atomic persisted operation: child session metadata, the copied
message/part set, goal snapshot/verifier entry, fork provenance, the anchors the child projection
needs, child initial input admission, and the parent accepted-command fact must all succeed in one
transaction before the child is registered/started. This bundle serves explicit forks only; a
compact-covered edit commits a branch cut in the original session and creates no hidden child. All
child-local message/part/tool/timeline/compact/goal references must be rewritten to child entities
through one shared mapping table; only explicit `originRef`/provenance may keep pointing at the
parent. Any unresolvable or unremappable child-local reference fails the fork and publishes no
half-built child — renderer fallback patching is not allowed. If the child runtime fails to start
synchronously after the transaction commits, the parent's edit ACK and `commands/query` stay
accepted/pointing at the same child; the child initial input must persist as
`failed(fault.command.childStartFailed)` and produce a recoverable `TurnError` in the child
projection; a restart must not rewrite that failed terminal state back into discarded.

`ForkIdentityMap` pre-allocates session/message/part/tool-call/turn/product-turn/goal-target/
verifier-entry/verification identities once before the transaction; the stable fork serves explicit
`forkAssistant` only and must not be implicitly reused by edit/retry. Message parents,
`MessageInfo.anchor`, timeline/compact refs, goal/verifier refs, and fork notices all consume only
this map. Legacy workspace forks may keep the original checkpoint policy, but the V4 entry must not
call child-only metadata creation or per-item copy/after-the-fact goal/fact compatibility paths.

This atomicity does not expand workspace rewind semantics: a running stable fork is
conversation-only, restores no shared workspace checkpoint; the existing checkpoint behavior of
completed/idle forks is unchanged this round.

### Edit and Retry

- The unified `editUserQuery` allows only the current active branch's last `humanAuthored=true`
  real-user input — an ordinary text query or a user-submitted goal input. Earlier real-user
  inputs, synthetic/model-only/background results, assistants, tools, and timeline offer no edit.
- Whether or not the latest real-user input is already covered by a compact summary, the edit
  rewinds in the original session via an append-only branch cut to that intent and reruns with the
  edited complete intent: text still goes through `sendText`, goal through `sendGoalCommand`. Old
  messages/parts are not physically deleted but no longer belong to the active projection, model
  context, or cold-recovery branch; explicit `forkAssistant` is the only entry that creates a child.
- The branch cut must apply before compact scope: first obtain `kept prefix + new messages after
  the branch cut`, then choose the last compact boundary within that active branch to build model
  history. Crossed compact summaries and full/microcompact derived state all invalidate; the most
  recent compact still on the active branch before the target is kept.
- Conversation rewind appends no provider-visible `rewind_notice`; the model sees only the kept
  prefix and the replaced canonical intent. The persistence layer identifies new branches with
  `branchCutAfterMessageID + branchGeneration` and stays compatible with old `createdMessageID`
  data.
- `editUserQuery.workspaceMode=preserve|rewind` distinguishes "reset conversation only" from
  "conversation + file reset". The combined mode re-runs preflight and restores checkpoints in
  reverse order within one command; any unsafe, ignored shell, unsupported, or missing safe
  checkpoint returns a structured blocked result with files, conversation, and provider requests
  all unchanged.
- While a primary turn, goal continuation, or goal verifier is running, editing the latest
  real-user input (including the latest goal input) first enters a stop barrier; the original
  session rewind happens only after the old completion-blocking work reaches a terminal state. On
  barrier failure there must be no rewind, no new text/goal intent, and the old active work, the
  original input, and the current branch are kept, with no edited provider request sent.
- `activeWork.kind=compact` is the operation lock for unified edit, fork, retry, and
  `sendQueuedNow`: all are rejected, without stopping the compact, without queueing, and without
  half-built command-target side effects.
- Retry must restore the complete original `ConversationInputIntent` (kind, text, attachments,
  goal intent, delivery/fallback, and source cause) from the target product turn's canonical
  cause — never reassemble from visible user text; the new command identity produced by the retry
  command must not overwrite the original intent's cause/provenance. Retry-of-retry reuses the
  earliest `provenance.sourceCommandId/queueItemId/clientId`, never the intermediate retry's
  queue/client.
- Row actions are the sole eligibility source for handlers: during ordinary running, edit may pass
  a stop barrier and stable-history fork is available; retry and file rewind are unavailable during
  any completion-blocking active work; compact active work locks edit/fork/retry/file rewind
  entirely. Handlers must not run a second adjudication on `activeAbortController`.
- `startNow` command admission must hold the session's CommandInbox gate until the canonical
  `TurnStarted` has been persisted, drained contiguously from the raw reorder buffer, and had its
  projection applied, advancing revision, active work, and row actions in the same materialization
  — only then may the ACK return. The input facade seeing a runtime event only means "notified" and
  is not projection-commit evidence; the command layer must wait on the connection-independent
  gateway commit waiter keyed by `{sessionId,eventId}`. That way, even while the delta has not yet
  reached/applied in the UI, a retry or file rewind on the old `baseRevision` can only return
  stale; conversation/workspace rewind must never execute in the window where the runtime
  controller is active but the projection is still idle.
- Failures before `TurnStarted` must first clear the runtime active lock, then end the command as
  failed and cancel the durable input admission; returning accepted and leaving a ghost input with
  no canonical user fact is forbidden. If the commit barrier exceeds 25 seconds without a
  `TurnStarted`, it must fail-closed: clear the lock and return an explicit timeout failure.
- On a transport error after `sendText` goes upstream, the renderer may only conclude the command
  result is unknown — never equate it with "explicitly not admitted" and auto-resend with a new
  command/session. It must keep the original commandId's recovery clues and converge via
  `commands/query` or a queue/guide/transcript projection carrying the same `sourceCommandId`;
  before the authoritative result is known, one user submission may produce at most one Agent
  admission.
- Once the `TurnStarted` commit barrier times out and the command reaches a failed/cancelled
  terminal state, the eventId and sourceCommandId enter a non-committable terminal state. Even if
  the raw reorder gap later fills, that `TurnStarted` must not be applied to the canonical
  projection; otherwise the renderer would roll back and resend per the failed ACK while the
  original turn arrives late, breaking the "one user submission, one authoritative input outcome"
  conservation constraint.
- The projection event commit waiter must: succeed immediately for already-applied eventIds; not
  succeed while a raw gap is pending; succeed only after the missing seq arrives and drains/applies
  contiguously; and explicitly reject on projection apply error, rehydrate, session/gateway
  dispose, abort, or 25-second timeout, cleaning up timer/listener/waiter. The timeout's
  point-of-no-return follows the actual projection commit — never mark committed merely because
  the runtime sink saw the event.
- When a row command or file changes/preview query hits a stale revision, stale epoch, or stale
  entity target, the client must trigger a projection recovery/resync on the same subscription;
  the action may be resubmitted only under the new revision/epoch/entity authority — reusing the
  old projection target is forbidden.
- A fork ACK's `accepted` and a `duplicate` with an existing child result navigate equally; an
  edit ACK always binds to the current session and never navigates to a child. failed/rejected/
  stale must not navigate; a file-blocked result keeps the inline draft and allows degrading to
  `workspaceMode=preserve` with a new commandId.
- The UI consumes only the CLI's `visibility/origin/marker/actions`. Hiding actions/rows by array
  position, `lastFlowRow`, or raw `/compact` text is forbidden; old history missing canonical
  fields is normalized by CLI hydration.

### Target Object

| Value | Meaning |
| --- | --- |
| `composer` | what the current input box submits |
| `queueItem` | one item in the queue panel |
| `latestUserQuery` | the latest real-user input; an ordinary text query or a user-submitted goal input |
| `oldUserQuery` | a non-latest historical real-user input (text/goal) |
| `latestAssistantTurn` | the latest assistant turn |
| `oldAssistantTurn` | a historical assistant turn |
| `toolMessage` | a tool block or tool result |
| `timelineMarker` | compact, fork, goal verification, model change, and other timeline markers |

Fork targets are defined only on assistant messages/turns; edit targets only on user queries. Tool
messages and timeline markers offer no fork/edit entries unless a future protocol defines them.

## Input Events

### User Events

| Event ID | Surface | Payload | Typical target |
| --- | --- | --- | --- |
| `sendText` | composer | ordinary text | `composer` |
| `sendGoalCommand` | composer or goal control | `/goal xxx` or goal text | `composer` |
| `sendCompactCommand` | composer | `/compact` | `composer` |
| `clickCompact` | toolbar or action menu | compact intent | current session |
| `stop` | toolbar | stop current session activity | current session active work |
| `forkAssistant` | turn actions | fork intent | latest/old assistant turn |
| `retryTurn` | protocol-compat entry (hidden in product UI) | retry intent | latest assistant turn |
| `editUserQuery` | real-user row actions | edited text/goal text; keeps the original intent kind | latest real-user input |
| `sendQueuedNow` | queue actions | queue item id | `queueItem` |
| `editQueueItem` | queue actions | edited queue content | `queueItem` |
| `reorderQueueItem` | queue actions | new order | `queueItem` |
| `deleteQueueItem` | queue actions | queue item id | `queueItem` |
| `switchModelConfig` | toolbar/model selector | provider/model/thought config | current session |

### System Events

| Event ID | Source | Applicable context |
| --- | --- | --- |
| `assistantComplete` | runtime/model stream | `running` |
| `assistantFailed` | runtime/model stream | `running` |
| `compactStarted` | runtime | auto/manual compact |
| `compactComplete` | runtime | `activeWork.kind=compact` |
| `compactNoop` | runtime | `activeWork.kind=compact`, or compacting again after completed |
| `compactFailed` | runtime | `activeWork.kind=compact` |
| `goalVerifyStart` | goal runtime | entering the verifier after a goal is active |
| `goalVerifyPass` | goal runtime | `activeWork.kind=goalVerifier` |
| `goalVerifyNotSatisfied` | goal runtime | `activeWork.kind=goalVerifier`, the verifier returned "target not yet achieved" normally |
| `goalVerifyFailed` | goal runtime | `activeWork.kind=goalVerifier`, the verifier was cancelled, hit an API failure, timeout, or internal error |
| `foregroundSubagentStarted` | runtime/tool | `running`, a foreground child agent derived by the primary turn |
| `foregroundSubagentComplete` | runtime/tool | `running`, the corresponding foreground subagent active work closes |
| `foregroundSubagentFailed` | runtime/tool | `running`, the corresponding foreground subagent fails or is stopped |
| `backgroundWorkStarted` | runtime/tool | a background bash/subagent starts; does not block `sessionEnded` |
| `backgroundWorkComplete` | runtime/tool | a background bash/subagent completes; produces a background result or no-op |
| `backgroundWorkFailed` | runtime/tool | a background bash/subagent fails or is cancelled by background cancel |
| `backgroundResultQueued` | runtime/tool | a background result entered the continuation inbox or a deferred queue |
| `sessionRestored` | restore/snapshot | app reload, session switch, remote replayable |

## Decision Types

| Decision | Meaning | Must state |
| --- | --- | --- |
| `allow` | the action takes effect immediately | the next state, the protocol request produced, or the local state change |
| `reject` | the action is explicitly rejected | user feedback, forbidden side effects, unchanged-state parts |
| `enqueue` | the action does not execute now; it enters the queue | the deferred input event, payload, order, and whether autoDrain |
| `noop` | the action may fire but changes no business state | user feedback and why no action is needed |
| `system-transition` | a system event advances the state | event ownership, next state, whether follow-up actions trigger |
| `undefined` | product semantics undefined | the question to confirm and candidate readings |
| `bug-candidate` | the current implementation seems to violate a confirmed protocol | the confirmed protocol, the observed conflict, and the evidence entry |

`reject` is not a fallback error. Every reject must state its feedback and forbidden side effects,
for example "not queued, not sent as an ordinary user message, no compact request sent".

`undefined` cannot get a stable E2E. It must enter a decision worksheet or backlog and only after
confirmation is it written back into the rule table and case catalog.

## Global Invariants

These invariants outrank individual cases. Any rule effect violating an invariant is marked
`bug-candidate` or `undefined`, never accepted as an ordinary case.

| Invariant ID | Statement | Status |
| --- | --- | --- |
| `sameSessionActiveTurnExclusive` | one session cannot run two active turns; same-session follow-up input must go through queue, turn-steer, or explicit stop/drain rules | accepted |
| `sessionCompletionRequiresNoForegroundWork` | `completed(success/interrupted)` requires primary turn, foreground subagent, compact, goal verifier, goal continuation, and turn-steer all closed; background work takes no part in the completion gate | accepted |
| `foregroundSubagentKeepsSessionBusy` | after the assistant stream or parts of the main turn finish, the session cannot enter completed while a foreground subagent owned by it still runs | accepted |
| `backgroundWorkDoesNotBlockSessionEnd` | while background bash/subagents run, the session may still enter completed once foreground work empties, opening completed-only actions | accepted |
| `sessionEndedDrivesImmediateStart` | only a completed context with `sessionEnded=true` lets ordinary composer input immediately become the next active turn; with `sessionEnded=false` a queue, guide, reject, or stop/drain guard must apply | accepted |
| `runtimeFactsAreAuthoritative` | `sessionEnded`, `canStop`, `stopState`, `stopTargetKind` must come from CLI/runtime facts or normalized host/service projection; the UI must not guess from local message streams, timeline, or `streaming` state | accepted |
| `persistentConversationFactsAreAuthoritative` | message, part, session metadata, and goal are the persistent authority; live/cold normalize into the same canonical facts before generating projection | accepted |
| `rowIdentityIsDisplayOnly` | `rowId` is display-only; edit/retry/fork actions and command targets must bind to `entityId/productTurnId` | accepted |
| `trustedDeliveryBoundary` | desktop (incl. SSH/WSL/Docker) is fixed continuous, mobile/Web remote fixed replayable; the profile is trusted-injected by the host attachment and not selectable by the UI | accepted |
| `subscriptionOwnedByConnection` | every connection has an independent subscription registry; frames go only to the owning port; one slow subscriber must not pollute other connections | accepted |
| `acceptedInputHasSingleAuthority` | all committed busy/running inputs from all clients enter the same FIFO in CLI admission order; host/runtime/UI keep no second authoritative queue | accepted |
| `acceptedInputAlwaysAccountedFor` | every committed input must be in exactly one of queue, guided row, transcript, or explicit rejected/failed/discarded | accepted |
| `sourceCommandIdEndToEnd` | queue item, drain/guided event, user row, message anchor, marker, and fork child metadata keep the original sourceCommandId | accepted |
| `restartDiscardRespectsDeliveryLifetime` | after a CLI restart, unfinished admitted inputs are explicitly discarded; the old runtime's `queue/guide` and the `unknown` without an authoritative verdict settle silently with no UI error; only a `startNow` that never entered the transcript prompts a resend confirmation; automatic replay is forbidden | accepted |
| `stopButtonStableAcrossActiveWork` | across handoffs between assistant, compact, goal verifier, goal continuation, and foreground subagent active work, the UI stop button must stay stable while the session is still stoppable, without flicker from internal phase switches | accepted |
| `stopPausesActiveGoalTarget` | with an active goal target, a user stop — whether acting on assistant, compact, goal verifier, or goal continuation — must move the target to a non-active paused state | accepted |
| `cancelledTurnColdHydrationParity` | typed/legacy ZCode cancellations from a user stop normalize to `TurnComplete(cancelled)` after both live and cold hydration; no `TurnError`, `phase=error`, or `control.lastError` | accepted |
| `followupInputModeExplicit` | running follow-up ordinary input is adjudicated explicitly by `queue` or `guide` mode; the default is `queue` | accepted |
| `runningPromptQueues` | in `running` with follow-up mode `queue`, ordinary text enters the queue and does not interrupt the in-flight request | accepted |
| `unfinishedSessionPromptQueues` | with `sessionEnded=false` and no guide allow hit, ordinary text enters the queue and starts no second active turn | accepted |
| `unfinishedSessionGoalQueues` | with `sessionEnded=false`, `/goal xxx` enters the queue and sets or updates the goal on consumption; this is `/goal`'s own rule and does not imply all commands may queue | accepted |
| `guideModeEligibilityGuard` | `guide` mode applies only when turn-steer conditions hold; otherwise it must fall back to queue | accepted |
| `guideModePreservesMessage` | in `guide` mode, follow-up text must survive in turn-steer/guided history or the fallback queue — never lost | accepted |
| `runningCompactQueues` | in `running`, `/compact` enters the unified FIFO as a typed maintenance intent; it is not an ordinary message and cannot start a concurrent compact | accepted |
| `runningStableAssistantForkAllowed` | in `running`, an earlier `completedSuccess` turn's last completed assistant may be forked; current streaming/interrupted/failed partials and middle assistant segments cannot | accepted |
| `latestQueryEditPreemptsActiveTurn` | only the last real-user input (text or goal) may be edited; in running, submitting an edit equals stopping the active work first, then rerunning from that input with the original intent kind kept | accepted |
| `compactCoveredLatestEditRewindsInPlace` | when the latest real-user input is covered by a stable compact summary, the original session takes an append-only branch cut, resets the crossed compact derived state, and replays per the original kind; no child is created, no rewind reminder appended | accepted |
| `latestAssistantRetryOnly` | the capability layer first locks the projection's timeline-last `assistantText` row, then requires the same product turn to have a canonical user input with `origin=realUser`; synthetic turns (background result/goal continuation/mailbox) and earlier real-user turns get no capability. The product UI hides the ordinary assistant retry entry uniformly on desktop, Web, and mobile; `canRetry` / `retryTurn` remain protocol-compat only | accepted |
| `retryPreservesFullIntent` | retry restores input kind, text, attachments, goal intent, delivery/fallback, and source cause from the canonical cause; rebuilding from visible text alone is forbidden | accepted |
| `goalInputUsesUnifiedEditTarget` | `goalSet` lifecycle produces no marker; a user goal input produces a canonical visible real-user row sharing the `editUserQuery` target with text queries; the resend stays `sendGoalCommand` | accepted |
| `stopHighestPriorityCancelsForegroundWork` | stop is highest priority; it must terminate the session's primary turn, foreground subagents, compact, goal verifier, goal continuation, and unconfirmed turn-steer | accepted |
| `stopEndsAsInterruptedCompleted` | after stop terminates all completion-blocking active work, the session enters `completed(interrupted)`; there is no paused product state | accepted |
| `stopKeepsQueueAndDisablesAutoDrain` | after a stop the queue is kept and `autoDrain=false` | accepted |
| `lateTerminalEventsAfterStopDoNotRevive` | late assistant/foreground subagent/compact/verifier terminal events after a stop cannot flip old work back to success or override a new round of active input | accepted |
| `heldQueueInputRequiresChoice` | in `completed` with a held queue (queue>0 + autoDrain=false), new composer input does not silently queue: the user chooses 「清空 queue 后发送」 or 「保留 queue 立即发送」 | accepted |
| `queueContentIndependence` | the queue holds future intents and is not bound to completed history; edit, compact, and fork do not rewrite the queue | accepted |
| `forkAssistantOnly` | only assistant messages may be forked; user/tool/timeline offer no fork | accepted |
| `forkDoesNotCopyQueue` | a forked session does not copy the parent queue; the parent queue is kept | accepted |
| `forkStableHistoryOnly` | the child inherits only the `completedSuccess` turn's last completed assistant and the stable history before it; a running parent does not automatically forbid fork, but current partials, middle assistants, and the compact operation lock cannot be stable fork boundaries | accepted |
| `runningForkDoesNotRewindWorkspace` | a running fork is conversation-only; no shared workspace checkpoint is restored, the parent keeps running; the existing workspace behavior of completed/idle is not expanded | accepted |
| `forkDoesNotCopyBackgroundWork` | a fork does not copy the parent's live background bash/subagents, pending background results, or continuation inbox; only background results already in pre-fork transcript are copied | accepted |
| `forkInheritsSessionFutureState` | the child inherits the provider/model/thinking depth persisted at the fork point and the pre-fork goal state, but not the parent's later config or queue | accepted |
| `forkTimelineIsBoundary` | the fork notice is a turn boundary and does not enter assistant work-history folding | accepted |
| `editUserOnly` | only the latest real-user input (text query or user goal input) may be edited; assistant/tool/timeline offer no edit | accepted |
| `editKeepsQueue` | editing the latest real-user input reruns the branch per the original intent kind, but the queue stays untouched | accepted |
| `sessionConfigScoped` | model, provider, and thinking depth are session-scoped future config and must not leak across sessions | accepted |
| `queuedSubmissionPreservesSelection` | the queue stores the complete Submission; on consumption it keeps the Provider, Model, and thinking depth fixed at enqueue time, while Provider config is read fresh at Model creation | accepted |
| `crossSessionUnlimitedConcurrency` | different sessions may truly run concurrently with queue/model/sidebar isolated from each other | accepted |
| `autoCompactIsSystemTurnPrefix` | auto compact is a pre-maintenance step for pendingAction and continues it on success | accepted |
| `goalVerificationOutcomeSeparation` | a verifier's normal "not achieved" verdict is `notSatisfied`; only cancel, API failure, timeout, or internal error is `failed` | accepted |
| `compactActiveWorkOperationLock` | `activeWork.kind=compact` is a maintenance state inside running; ordinary text and `/goal` queue, while compact, fork, edit, retry, and sendQueuedNow must reject | accepted |
| `goalVerifierBusyRouting` | `activeWork.kind=goalVerifier` is a verification state inside running; ordinary text, `/goal`, and `/compact` all queue as future intents, stop may interrupt the verifier; latest-user-query edit reruns after a stop barrier, stable-history fork is allowed, and sendQueuedNow drains after a stop barrier | accepted |
| `backgroundWakeStartsIndependentProductTurn` | a background model-only wake creates an independent product turn live or cold; it has no visible user trigger row and must not merge into the previous real-user turn | accepted |
| `stableForkIsAtomicAndFullyRemapped` | a stable fork publishes only after child metadata, history, goal/provenance, and all child-local references are atomically written and remapped; a failure leaves no half-built child | accepted |

## Known Stable Guards

These guards have stable consensus in existing documents and form the first batch of the future
rule table.

| Guard ID | Match | Decision | Core effect |
| --- | --- | --- | --- |
| `firstSend` | `draft + sendText` | `allow` | create the session, enter the detail page, the first user message is visible |
| `runningPromptQueues` | `running + followupInput.mode=queue + sendText` | `enqueue` | deferred `sendText` grows by FIFO; no second same-session active turn |
| `guideModeTurnSteer` | `running + followupInput.mode=guide + sendText + guide eligible` | `allow` | follow-up text enters turn-steer or a guided user message; no ordinary new turn |
| `guideModeFallbackPreservesMessage` | `running + followupInput.mode=guide + sendText + guide ineligible` | `enqueue` | falls back to deferred `sendText`; user input not lost |
| `unfinishedSessionPromptQueues` | `sessionEnded=false + sendText + guide ineligible/not applicable` | `enqueue` | deferred `sendText` grows by FIFO; no second active turn |
| `unfinishedSessionGoalQueues` | `sessionEnded=false + sendGoalCommand` | `enqueue` | deferred `sendGoalCommand` keeps the goal intent; set/update on consumption |
| `runningCompactQueues` | `running + sendCompactCommand/clickCompact` | `enqueue` | append a kind=`compact` queue item; not an ordinary user message; strictly FIFO after the current work ends |
| `runningStableAssistantForkAllowed` | `running + forkAssistant + stable historical assistant target` | `allow` | create the child; the parent's current active work, queue, and background work stay with the parent |
| `latestQueryEditPreemptsActiveTurn` | `running + editUserQuery + latest real-user input (text/goal)` | `allow` | stop barrier first; after old work empties, rewind and rerun per the original kind; on barrier failure keep old work/input/branch and start no text/goal |
| `compactCoveredLatestEditRewindsInPlace` | `editUserQuery + latest real-user input + coveredByStableCompact` | `allow` | append-only branch cut in the original session; reset crossed compact/microcompact state, replay per the original kind, create or navigate no child |
| `goalInputUsesUnifiedEditTarget` | `editUserQuery + latest real-user input (kind=goal)` | `allow` | rewind by stable entity target; resend the `sendGoalCommand` intent; the goal input row stays visible; no `goalSet` marker |
| `latestQueryEditOnly` | `editUserQuery + non-latest real-user input` | `reject` | historical text/goal inputs offer no edit, preventing active-branch rollback to old context |
| `latestAssistantRetryOnly` | `retryTurn + non-latest assistantText row`, or the latest assistant's turn has no canonical user input with `origin=realUser` | `reject` | historical assistant replies and background/synthetic result turns get no retry capability; skipping the latest synthetic assistant to roll back to old context is forbidden; no ordinary assistant retry capability is rendered as a product UI entry |
| `activeWorkBlocksCompletion` | `assistantComplete + activeWork!=empty` | `system-transition` | close the finished work but keep the session busy; no completed-only actions |
| `controlProjectionKeepsStopVisible` | `canStop=true OR stopState=stopping` | `system-transition` | the UI keeps the same stop button; `stopTargetKind` changes only update detail copy |
| `stopBusySessionCancelsForegroundWork` | `prewarming/running/activeWork!=empty + stop` | `allow` | terminate the session's completion-blocking active work; once empty enter `completed(interrupted)`, queue kept with `autoDrain=false` |
| `sendQueuedNowStopsBeforeDrain` | `running + queue>0 + sendQueuedNow` | `allow` | reserve the target item, run the stop barrier; remove only on successful start, otherwise release the reservation and keep the item in place |
| `compactActiveWorkOperationLock` | `activeWork.kind=compact + sendCompactCommand/clickCompact/forkAssistant/editUserQuery/retryTurn/sendQueuedNow` | `reject` | a compact is running: no second compact, no fork/edit/retry, no preemptive queue drain |
| `goalVerifierBusyRouting` | `activeWork.kind=goalVerifier + sendText/sendGoalCommand/sendCompactCommand` | `enqueue` | while verifying a goal, user input and maintenance intents are saved as typed queue items; no second active turn, no verifier interruption |
| `goalVerifierStopBarrierDrain` | `activeWork.kind=goalVerifier + sendQueuedNow` | `allow` | stop the verifier first (marker failed/cancelled, goal paused), then drain the target item by explicit queue consumption rules |
| `completedCanStartNextTurn` | `completed + sendText + queue=0` | `allow` | start the next turn immediately |
| `backgroundOnlyCompletedCanForkOrCompact` | `completed + backgroundWork!=empty + forkAssistant/clickCompact` | `allow` | background work does not block completed-only actions; fork/compact still act only on stable transcript |
| `heldQueueInputRequiresChoice` | `completed + queue>0 + autoDrain=false + sendText/sendGoalCommand` | `choice` | the client presents a choice: `clearQueueAndSend` or `keepQueueAndSend`; the command replay carries the chosen disposition |
| `manualCompact` | `completed + clickCompact/sendCompactCommand` | `allow` | enter `running + activeWork.kind=compact`, insert the compact timeline |
| `forkAssistantOnly` | `stable assistant target + forkAssistant` | `allow/reject` | assistant allows fork; user/tool/timeline forbid |
| `editUserOnly` | `editUserQuery` | `allow/reject` | latest real-user input (text/goal) allows edit; non-latest real-user input, assistant/tool/timeline forbid |
| `forkDoesNotCopyQueue` | `forkAssistant` | `allow` | the child inherits stable history and fork-point config, not the parent queue |
| `forkDoesNotCopyBackgroundWork` | `forkAssistant` | `allow` | the child does not copy the parent's live background work or pending background result |
| `queueContentIndependence` | `editQueueItem/reorderQueueItem/deleteQueueItem` | `allow` | queue-only edits; no consumption triggered |

## Pending Product Boundaries

All four boundaries were adjudicated on 2026-07-05 (V4 refactor M0 decision close-out); this
section keeps the rulings. Detailed sub-question conclusions live in
[decision-answers](./testing/conversation-session-decision-answers.md) and the compact decision
worksheet.

| Boundary ID | Ruling | Source |
| --- | --- | --- |
| `PB-COMP-FAIL-F09` | stay completed (back to the pre-compact state) + failed marker (with retry entry); the queue is kept and not auto-consumed, autoDrain unchanged; all actions restored | compact worksheet F09.1–F09.4 |
| `PB-AUTO-COMP-FAIL-G11` | continue pendingAction without compaction (stay running; the 4th request is the main model request); the retrying history and failed marker are kept but do not block; the circuit breaker engages and resets after a successful manual compact | compact worksheet G11.1–G11.4 |
| `PB-AUTO-COMP-STOP-G12` | exactly like an ordinary stop: pendingAction stays as the current turn's interrupted user message (editable/retryable in the timeline, not copied back to the queue, not dropped); the session is `completed(interrupted)`; the compact marker becomes cancelled; explicitly appended queue items are all kept and not auto-consumed | compact worksheet G12.1–G12.4 |
| `PB-AUTO-COMP-MODEL-N06` | switching is allowed: an already-sent compact is not interrupted and the config takes effect immediately; the race boundary = the pendingAction reads the then-latest config snapshot at the instant of consumption (V4 switchModelConfig uses revision CAS) | case catalog N06 |

## Evidence Contract

Every future rule or case declares at least one user-visible evidence and one non-UI evidence.

| Layer | Use |
| --- | --- |
| UI | messages, queue, disabled buttons, toasts, and timeline markers the user actually sees |
| Runtime/Store | `sessionId`, phase, queue, target, activeInputId, activeWork, backgroundWork, sessionEnded, canStop, stopState, stopTargetKind, autoDrain, model config |
| Protocol | app/agent commands such as send, compact, goal, fork, stop; activity terminal events; runtime facts snapshots; product control projection |
| Network/SSE | provider requests, compact requests, stream timing, retries |
| Files | session snapshots, task index, compact summary, fork history |
| Logs | UI logger, service logger, agent log — always with case/session/input attribution |

For reject rules, the evidence must also prove the forbidden side effects do not happen. For
example, a `/compact` running reject must show not only the toast but also an unchanged queue, no
ordinary user message, and no compact request.

For completed rules, the evidence must prove the session's completion-blocking active work is
empty: not just an assistant message reaching a completed look, but no still-running foreground
subagent, goal verifier, compact, undrained goal continuation, or turn-steer. Background
bash/subagents need separate proof via `backgroundWork` or background drawer facts; they may keep
pending but must not flip `sessionEnded` back to `false`.

For control projection rules, the evidence must prove the chain CLI/runtime facts -> host/service
projection -> UI is consistent. For example, while `canStop=true` or `stopState=stopping`, the stop
button must not briefly disappear across internal `assistant -> compact -> goalVerifier` phase
switches; a `stopTargetKind` change may only change the tooltip, logs, or auxiliary copy.

For `sessionEnded=false` queueing rules, the evidence must prove the user input was saved as a
queue item and that no second active turn started. In `activeWork.kind=compact` or
`activeWork.kind=goalVerifier`, it must also prove the existing compact/verifier active work was
not interrupted and the queue drains only at later allowed moments.

For fork rules, the evidence must prove the fork target is the stable transcript boundary of a
`completedSuccess` product turn's last completed assistant, and that the child did not copy the
parent's queue, live background bash/subagents, pending background result, or continuation inbox.
If the parent was still running at fork time, the evidence must also prove the parent's active
work still belongs to the parent, the shared workspace was not rewound, and the child received
only pre-fork stable history.

For user-stop rules, the evidence must prove the stop command reached all completion-blocking
active work, especially foreground subagents; with an active goal target, that the target moved to
paused; and that post-stop late assistant/foreground subagent/compact/verifier terminal events did
not revive the session to success, trigger pendingAction, or override a new round of active input.
A background-only cancel goes through background task control and is not session-stop evidence.

## Next Step

If `docs/conversation-session-rule-table.md` is added later, only this file's `accepted`
invariants and stable guards expand into the rule table. That file does not exist yet;
`needs-decision` boundaries go through small-batch confirmation first, not into accepted rules.
