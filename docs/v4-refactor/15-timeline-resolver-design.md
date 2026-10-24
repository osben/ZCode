# Conversation Timeline Resolver Design

> **Status: ruled and implemented by [16-timeline-authority-plan.md](./16-timeline-authority-plan.md).** This document keeps the root-cause analysis, alternative structures and migration advice; the landing adopted a canonical fact normalizer, persisted anchors, `entityId/productTurnId` addressing, the `session_input` ledger and constrained timeline placement, and did not implement every general graph/resolver idea here as-is. Current facts follow 16's implementation status, the current specs 02/07 and the code. Full pre-compaction text: `git show b8876e8b:docs/v4-refactor/15-timeline-resolver-design.md`. Review of this design: [15-timeline-resolver-design-review.md](./15-timeline-resolver-design-review.md).

## Scope

Goal: explain why message misplacement, swallowed messages and unstable timeline positions persisted after the v4 refactor, and give an implementable authoritative ordering structure. Scope: the visible transcript of a conversation session, queue drain, compact timeline, goal verify timeline, model change timeline, fork timeline, multi-segment assistant, and background Bash/subagent completion wake. Non-goals: no direct implementation change, no final UI styling, no replacement of the E2E case catalog (accepted semantics must still be written back to the case catalog and coverage matrix before implementation).

## Background and problem

One v4 goal is to converge conversation state into the CLI virtual projection so the UI stops guessing runtime state. But the projection is still more of a "row generator that creates a row when an event arrives" than a full timeline resolver, so the rows the nearly-dumb UI receives already contain wrong ownership and wrong order. Four orders that get mixed:

```text
eventSeq        event arrival / persistence order
runtimeTurnId   runtime loop, trace and provider roundtrip ownership
productTurnId   the user-visible logical turn; queue drain, model-only continuation and background wake may each create a new one
visualPlacement where the item should appear on the UI timeline (inside assistant work, turn tail boundary, light boundary before the next turn)
```

These four cannot share one `turnId`, `rowId` or append order. `event.turnId` is a runtime fact, not the UI turn container; `row.appended` is a transport optimization, not visual-order authority.

## Existing semantic evidence

Key rulings already in the docs show the timeline cannot be handled with a fixed turn template:

1. A synthetic user message's `role=user` is only the provider/store physical role, not a UI user input. fork, rewind, goal-continuation, goal_state_change, background_task, subagent and compact summary must be classified through the projection policy.
2. Fork can target only a stable assistant message; the child copies the stable transcript before the fork point and session config, not the parent's queue, live background bash/subagent, pending background results or continuation inbox.
3. One logical turn may have several assistant text rows; fork/retry actions appear only on the last completed assistant row.
4. `context_compaction` is assistant activity and may sit inside assistant work; `session_fork`, `goal_verification` and model change are turn boundaries and do not enter assistant history.
5. Background Agent/Bash may let the parent turn complete first and wake the main agent via `<task-notification>` after the background finishes; this wake is a model-only trigger, not shown as a user bubble.

They point to one structure: build typed semantic entities first, then let a resolver compute product turn and visual placement.

## Why messages get "swallowed"

Most "swallowed" cases are not missing underlying facts but wrong grouping, overwriting or hiding in the projected UI rows.

- **Case A: queue drain still lands in the same runtime turn.** T1 user Q1 / T1 assistant A1 / T1 drained user Q2 / T1 assistant A2. If the UI treats only the last assistant of the turn as the body, A1 is folded into history and the user feels the previous assistant did not render.
- **Case B: a queue item is removed with no stable userInput entity to take over.** Q[Q2] -> remove queue item, with no userInput(sourceCommandId=Q2); the user sees the queue empty and no transcript either.
- **Case C: a boundary marker without anchor/placement.** assistant A1 final, then goalVerify started arrives late or its trace turnId differs from A1's; if it can only append at the tail, the marker lands after the wrong turn.
- **Case D: multiple assistant segments treated as one "latest assistant" template.** A1.1 before tool / tool result / A1.2 final; if the projection keeps only latest, or a fork target binds to an early raw assistant, the final reply, tool result or file references are lost.

The root cause is not a missing UI if: the CLI projection did not first complete semantic conservation and authoritative ordering.

## Design goals

1. The UI consumes only the resolved authoritative timeline and no longer infers structure from `turnId + latestAssistantTextRow`.
2. Every visible user input, assistant segment, compact lifecycle, goal verify lifecycle, fork marker and background wake has a stable business identity.
3. `eventSeq` is only the fact input order, not visual-order authority.
4. `runtimeTurnId` expresses only runtime trace ownership and does not decide product turn directly.
5. All non-tail placement is handled by the CLI resolver; what append-only deltas cannot express is sent as a snapshot resync.
6. desktop continuous and web remote replayable share the same authoritative snapshot semantics; the delivery profile affects only intermediate frames, never the final timeline.

## Layering principles

1. **The authoritative order is the in-session aggregate sequence**, not timestamp, row append order or UI array position.
2. **Input lifecycle is independent of model execution.** A prompt is durably admitted first and promoted into a transcript message at a safe boundary; the queue does not rely on renderer memory to prove it ever existed.
3. **The DB stores domain facts, not UI layout.** The transcript projection is a domain fact, not a UI schema of "which bubble/card/lane".

A compatibility layer merging message/part by id belongs only to the legacy client merge and is not ordering authority. ZCode uses `event_sequence + input ledger + domain projection` rather than keep treating UI rows as the fact source.

## Overall architecture

```text
Raw Event Journal / Persisted Facts (SessionEvent, message, part, target entry, task notification)
  -> Event Normalizer          normalize provider/runtime/legacy data into semantic events
  -> Semantic Ledger           maintain typed entities, no direct UI rows
  -> Timeline Constraint Graph edges from cause / anchor / lifecycle / copy / wake
  -> Timeline Resolver         compute productTurnId, lane, placement, orderKey, visibility
  -> Materializer              produce ResolvedTimelineSnapshot, degradable to rows.window during the compatibility period
  -> UI                        render the resolved snapshot dumbly, no guessing turn tail or hidden message
```

### Minimal physical fields and domain semantics

`sourceCommandId`, `anchorMessageId`, `lifecycleKey`, `visibility` and the like need not all become physical columns. The preferred persisted form is a few stable physical fields plus typed JSON refs: `session_event / message / part` with `id, session_id, sequence, kind/type, data JSON`, where `data JSON` carries `refs` (`parentMessageId`, `sourceCommandId`, `anchorMessageId`, `originSessionId`, `originMessageId`), `lifecycle.state` (e.g. `promoted`) and `visibility` (`ui`, `provider`). These semantics cannot be compressed into one `pid`: a `pid` expresses only a tree parent, but a conversation timeline has several orthogonal relations at once: `id` (who I am), `sequence` (authoritative order in this session's fact stream), `parent / response-to` (which user message an assistant answers), `cause` (which command / queue item / background wake triggered me), `anchor` (which message or turn a marker should be displayed near), `lifecycle` (command admitted / promoted / completed / failed), `origin` (the original session / message after fork/copy), `visibility` (UI-visible, provider-only, or state-only). Reusing one `pid` would make it mean `response-to`, `display-after`, `caused-by`, `fork-from` and `compact-before` in different places, polluting the semantics, and the resolver would still guess.

## Core entity model

The Semantic Ledger is centered on business entities, not UI rows.

```ts
interface TimelineEntityBase {
  entityId: string;
  kind: TimelineEntityKind;
  lifecycleKey?: string;
  cause?: TimelineCause;
  anchor?: TimelineAnchor;
  visibility: "visible" | "modelOnly" | "stateOnly";
  lane: TimelineLane;
  productTurnId?: string;
  orderKey?: TimelineOrderKey;
  sourceCommandId?: string;
  copyPolicy: CopyPolicy;
}
```

| Entity             | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `UserIntent`       | real user input, user input after queue drain, model-only continuation, background notification wake |
| `ProductTurn`      | the user-visible or model-only logical turn container                                                |
| `AssistantSegment` | one assistant-role output; a product turn may have several                                           |
| `WorkActivity`     | in-assistant-work activity such as tool, reasoning, subagent, compact                                |
| `TimelineBoundary` | turn boundaries such as goalVerify, fork, modelChange                                                |
| `QueueItem`        | a future user intent, not a transcript                                                               |
| `BackgroundWork`   | detached Bash/subagent runtime work, owned by the parent session, not a queue                        |

### Lane and placement

The resolver first assigns each entity a lane: `queue` (QueueItem, shown only in the queue UI, not in the transcript); `trigger` (a visible or modelOnly UserIntent that creates a product turn); `assistantWork` (assistant text / reasoning / tool / subagent / compact activity); `turnTailBoundary` (goalVerify / fork, anchored at the end of a logical turn); `lightBoundary` (modelChange, a light turn boundary); `detachedState` (BackgroundWork state, usually shown by the summary/control surface); `stateOnly` (affects state only, not in timeline rows). Lane rank: 0 lightBoundaryBeforeTurn, 1 trigger, 2 assistantWork, 3 turnTailBoundary, 4 detachedState, 5 stateOnly. `stateOnly` must not enter `rows.window`: a marker decided not to render must not affect virtual scroll, turn grouping or history folding as a hidden row.

### Authoritative ordering

The resolver produces a deterministic `orderKey` `{ branchEpoch, productTurnOrdinal, laneRank, entityOrdinal, lifecycleOrdinal }`. The source is not timestamp or row append order but a constraint graph with edges: `cause` (queue item -> drained UserIntent; background work completed -> background wake UserIntent), `anchor` (AssistantSegment A1 -> goalVerify(targetId, iteration); A1 -> forkCreated/forkNotice), `lifecycle` (compact started -> completed/failed/interrupted; goalVerify started -> completed/cancelled), `turn` (ProductTurn trigger -> AssistantSegment / WorkActivity), `copy` (fork source assistant -> child copied graph). The resolver does deterministic topological placement; entities at the same position are ordered by `entityOrdinal`, never by DB id lexicographic order. (The review recommends weakening this to a `(branchEpoch, eventSeq)` primary total order + bounded local anchor re-parents.)

## Key semantic rules

- **Queue drain**: the queue is a future user intent, not bound to the current runtime turn; after a drain a new product turn must be created (T1: Q1/A1 final; Q[Q2]; T2: Q2/A2). Even if the runtime still completes a roundtrip inside one activeTurn, the projection must split a new `productTurnId`; `runtimeTurnId` cannot become the UI turn directly.
- **Multi-segment assistant**: one product turn may hold several assistant segments (A1.1, ToolCall Bash, ToolResult, A1.2 final); all must be kept, the UI may fold early segments but the resolver must not overwrite; fork/retry/action targets hang only on the last stable completed assistant segment.
- **Compact**: compact is assistant activity, neither a user bubble nor a forced turn boundary (assistant before compact, compact running, compact success, assistant after compact). The manual `/compact` command is a command entry and is not shown as an ordinary user query; with no following assistant, compact may show as an independent weak timeline but is still not an empty user turn.
- **Goal verify**: a turn tail boundary. Identity is mainly `targetId + goalIteration`, `verificationId` only a per-attempt alias (T1 Q1/A1 final; goalVerify(target-1, iteration-1) running -> notSatisfied; T2 modelOnly goal continuation/A2 final; goalVerify(target-1, iteration-2) running -> pass). It must have an anchor: `anchor = anchorAssistantMessageId || anchorTurnId || explicit fallback placement`; if the anchor's turn is already mid-window and the current delta can only append, do not force-append at the tail but send a snapshot resync.
- **Model change**: a light boundary, not assistant work. Only switching the draft model does not pollute the transcript; a boundary is produced only when the next accepted turn really uses the new model. The first turn using some model is not a model change. If the product rules that modelChange is not visible in the transcript, it should be `stateOnly` or a separate banner state and must not enter `rows.window`.
- **Fork**: by graph cut, not DOM row or current latest assistant. The child copies the graph up to the fork point (A1 final), the session config and the eligible goal state / verifier entries; it does not copy queue, background work, continuation inbox or active-run fields. The parent appends `BM forkCreated(childSessionId, anchor=A1)`, the child appends `BM forkNotice(parentSessionId, anchor=A1-copy)`. Goal fork state must copy the target and verifier timeline before the fork point and rewrite a copied verifier's `anchorAssistantMessageId` to the child message id; it must not recreate an empty target via `setTarget` at the bootstrap/protocol layer. The core of fork is **copy by value + provenance**: each copied message has a _local identity_ (new id / new sequence in the child, used for ordering, rendering, continuing the conversation and anchor resolution) and an _origin provenance_ (parent session / message / sequence, used only for tracing, source display and debug, never for the child's UI placement). Example: parent S1 seq 1-4 U1,A1,U2,A2 (fork point A2); child S2 seq 1 `fork.created { originSessionId: S1, originMessageId: A2, originSequence: 4 }`, seq 2-5 U1',A1',U2',A2' each with `originMessageId`. Every copied local reference must be remapped to the child's local id (`S2.A2'.parentMessageId = S2.U2'`, `S2.A2'.originMessageId = S1.A2`; `S2.A2'.parentMessageId = S1.U2` is wrong); the same holds for `anchorMessageId`, `sourceCommandId`, goal verifier anchor and compact anchor; a reference whose object was not copied cannot stay a child local anchor and degrades to `originRef` or a diagnostics fallback.
- **Background Bash / Subagent**: detached runtime work, neither queue nor an ordinary user message (T1: Q1, assistantWork: Agent(run_in_background=true), tool result backgrounded, A1 final, completed; BG1 running; BG1 completed -> BackgroundWakeCommand; T2: trigger modelOnly backgroundNotification(BG1), no visible user bubble, assistantWork: A2 handles `<task-notification>`). User ruling: a background notification need not show as a user bubble; it is modeled as a `visibility=modelOnly` `UserIntent` that may create a product turn but generates no visible user row; whether to additionally show a light system boundary is out of this round's design and by default it does not enter transcript rows. Background completion is still consumed via the runtime command queue and adds no concurrent same-session `executeTurn`: if the active loop still has a legal roundtrip the notification may merge in; when idle it continues serially via a model-only wake.

## Snapshot contract

The ideal UI consumption is a structured snapshot rather than flat rows:

```ts
interface ResolvedTimelineSnapshot {
  revision: number;
  branchEpoch: number;
  nodes: TimelineNode[];
  queue: QueueState;
  backgroundWorks: BackgroundWorkSummary[];
  controls: SessionActionAvailability;
}

type TimelineNode = ResolvedTurnNode | ResolvedBoundaryNode | ResolvedMaintenanceNode;

interface ResolvedTurnNode {
  productTurnId: string;
  trigger?: ResolvedTrigger;
  assistantSegments: ResolvedAssistantSegment[];
  workActivities: ResolvedWorkActivity[];
  tailBoundaries: ResolvedBoundaryNode[];
}
```

During the compatibility period it may still materialize into `rows.window`, but rows must carry the resolver output (`entityId`, `productTurnId`, `lane`, `placement`, `anchor`, `orderKey`, `visibility`, `lifecycleKey`, `sourceCommandId`); the UI may temporarily reuse existing components but no longer infers logical structure from `turnId + latestAssistantTextRow`.

## Delta and resync

Existing append-only deltas can stay, with tightened semantics: tail addition `row.appended`; lifecycle state update `row.upserted`; branch deletion `row.removed`; text increment `row.delta`; non-tail insertion / reorder / late placement correction `snapshot.resync`. The client must not simulate a move with `row.upserted`, since the existing apply only replaces by rowId without changing position. When the resolver finds a visible entity's `orderKey` in the middle of the sent window it should send a snapshot resync or enter a new snapshot epoch.

## Conservation invariants

After every snapshot the resolver must run conservation checks; on failure do not send the bad snapshot to the UI, log an error and expose diagnostics in development.

1. **Input**: every visible inputId is in exactly one of QueueItem or UserIntent row (not neither, not both).
2. **assistant**: every assistantMessageId maps to one AssistantSegment; a later assistant never overwrites an earlier one.
3. **compact**: every compact operationId/inputId maps to one WorkActivity; started/success/failed/interrupted update the same entity.
4. **goal verify**: one boundary entity per targetId + iteration; verificationId is an alias, not the UI primary identity.
5. **fork**: the fork source must be a stable assistant segment; the child contains no parent queue, live background work, pending background result, continuation inbox or active run fields.
6. **background**: every completed background notification is either a pending wake or has produced a modelOnly wake turn; no visible user bubble.
7. **rendering**: a visible entity must have a renderer; a stateOnly entity must not enter timeline rows; a hidden/modelOnly trigger must not affect the visible user turn count.

## Real persisted structure

A read-only inspection of local real persisted data on 2026-07-07 showed conversation data is not a single DB fact source but three layers: UI v4 virtual projection <- zcode protocol snapshot/live <- CLI transcript store `~/.zcode/cli/db/db.sqlite` (`session`, `message(id, session_id, time_created, time_updated, data JSON, sequence)`, `part(id, message_id, session_id, time_created, time_updated, data JSON, sequence)`, `session_entry(...)`); the App metadata store `~/Library/Application Support/ai.z.zcode/zcode.db` (sessions / workspaces / follow_up_queue / session_notifications; no full transcript); the task list/search index `~/.zcode/v2/tasks-index.sqlite` (tasks / task_groups / searchable_text; serves only list, grouping and search, not the message-order truth). The real CLI DB is the authoritative transcript store. Scale observed: `session` 2,989 rows; `message` 26,942 (JSON `data`, physical `sequence` column); `part` 96,112 (same); `session_entry` 1,402 (mainly `target_completion_verification` and `runtime/bash_shell_selection`); app `follow_up_queue` 0 rows (`session_id + position + payload`, not a transcript order source). Repository read order: message `order by sequence is null, sequence, time_created, rowid`; part `order by message_id, sequence is null, sequence, time_created, id`, so the code already uses `sequence` as the primary ordering field for new data and keeps a fallback for rows lacking it.

### Risks exposed by real data

Not "the DB has no ordering field" but ordering fields and semantic anchors are both unreliable. After migration `0014_message_part_sequence` (applied 2026-06-29 06:50:36 EDT): NULL `message.sequence` 1,690 rows, NULL `part.sequence` 5,933 rows, 331 affected sessions, range 2026-06-29 07:50:30 EDT to 2026-07-07 09:01:35 EDT. NULL `sequence` is therefore not purely an old-data burden: some write, import, repair script, raw SQL or other unlocated side path still bypasses the unified `saveMessage` / `savePart`. The verified fork main path going through `persistMessage` / `persistPart` / the session-store repository is no longer the default suspect; use logs and DB invariants to find the real side path. Semantic field coverage is also clearly insufficient: `message.data.semantics` 569/26,942; `message.data.anchor` 432/26,942; `message.data.anchor.turnId` 425/26,942; `part.type = timeline` 45/96,112; timeline `anchorMessageId` 21/45; timeline `anchorTurnId` 10/45. timelineType distribution: `model_change` 24, `goal_verification` 10, `session_fork` 6, `context_compaction` 5. This explains why goal verify, fork, compact and other markers drift: many real markers lack enough anchor, and if the resolver infers only from append position, timestamp or the current turn, cold recovery, late events, fork copy and queue drain misplace them.

### Persisted fields vs the database

Not every resolver field must become a database column. Correct layering: (1) `~/.zcode/cli/db/db.sqlite` `session/message/part/session_entry` is the authoritative fact source of the conversation transcript; (2) app `zcode.db` stores only app metadata, notifications and the renderer-local queue, not a transcript order source; (3) `tasks-index.sqlite` stores only task list, search and groups; (4) new writes of `message` / `part` must go through the unified repository, guaranteeing non-null `sequence` and stable monotonicity within a session / message; (5) a new timeline part must record anchor and semantic fields such as `anchorMessageId`, `anchorTurnId`, `lifecycleKey`, `visibility`, `timelineType`; (6) a new user intent, queue drain or background wake must keep `sourceCommandId` / `cause` / `origin` / `turnId`, otherwise the UI cannot tell a real user input, queue consumption and a model-only wake apart; (7) CLI cold resume must re-feed persisted facts to the same resolver rather than write another hydration ordering logic; (8) a materialized snapshot may cache `entityId/productTurnId/orderKey` but the cache is not a fact source. Whether to add physical columns by risk: **must fix first** - every future message / part write carries a sequence, and data without a sequence must be derivable at read time and never dropped; **recommended new or equivalent** - a `session_command` / `session_input` ledger expressing at least the durable lifecycle command/input admitted -> promoted -> cancelled/failed (an independent table or `command.*` events in session_event, but not only in the renderer-local queue or runtime memory); **recommended JSON-contract reinforcement** - semantics / anchor / sourceCommandId / cause / visibility / lifecycleKey, written incrementally into JSON keeping old data compatible; **not a physical column priority** - productTurnId / orderKey / lane / placement (resolver output, not raw facts; may be cached but never the sole fact). Recommended minimal boundary: an `event_sequence` or `session_sequence` (`session_id`, `next_sequence`); `session_command` / `session_input` (id, session_id, kind, delivery_kind, client_mode, payload_json, admitted_sequence, promoted_sequence, promoted_message_id, status, time_created, time_updated); `message` / `part` with non-null sequence and `data JSON` carrying typed refs / semantics. If an existing unified allocator already guarantees one in-session monotonic sequence for all transcript facts, no `session_sequence` table is needed; otherwise add or equivalently implement an allocator so message, part, session_entry and command do not each generate incomparable orders. The root cause is not simply "the DB lacks an ordering field": `sequence` exists but its coverage is incomplete and semantic anchor coverage is low, so the projection snapshot must be the authoritative resolver and neither the UI nor hydration may reverse-infer from row order, role or turnId.

## Test and acceptance layers

Stabilize the resolver with L1/L2 first, then pick representative E2E; old E2E need not be all green at once but every accepted case must have an explicit setup/action/assert. L1 Semantic Ledger / Resolver golden: event sequence -> typed entities -> resolved orderKey/nodes. L2 Materializer / profile convergence: continuous/replayable final snapshots match; late placement triggers resync. L3 UI render unit: the UI renders only by resolved nodes and does not re-guess the turn tail. L4 representative E2E: queue drain with both rounds' assistants visible; compact producing no user bubble and not fragmenting assistant work; goal verify landing at the turn tail by anchor; modelChange not polluting the first turn and draft switches; fork graph cut not copying queue/background; merged assistant fork allowed only on the last stable segment; background completion model-only wake showing no user bubble.

## Migration advice

1. Rule and freeze the `eventSeq/runtimeTurn/productTurn/visualPlacement` four-layer boundary in docs.
2. Audit all `message` / `part` write paths and forbid bypassing the session-store repository; after fixing add a DB invariant so migration stops producing NULL `sequence`.
3. Add compatibility backfill or stable read-time derivation for existing NULL `sequence`; read-time derivation must not change historical facts but must give the same order across repeated hydrations of one session.
4. Add or equivalently implement `session_command` / `session_input` persisting the admitted/promoted lifecycle of queued prompts, background wake and resume input.
5. Fill `semantics`, `anchor`, `sourceCommandId`, `cause`, `origin`, `visibility`, `lifecycleKey` for newly written v4 facts; for old data lacking fields the resolver derives them, with no destructive hard migration.
6. Generate a child local id / local sequence for fork-copied messages and remap child-internal refs; parent ids may enter only `origin*` provenance.
7. Add `entityId/productTurnId/lane/placement/anchor/visibility/lifecycleKey/orderKey` to the v4 row/snapshot.
8. Add the Semantic Ledger and Timeline Resolver, first covering only queue, assistant segment, compact, goalVerify, fork, modelChange and background wake.
9. The materializer keeps outputting the old rows shape, but rows come from the resolved graph; any visible message/part that cannot be grouped must enter a diagnostics fallback row and never be dropped silently.
10. Change UI render units to consume resolver results and gradually delete the `turnId + latest assistant` inference.
11. cold resume, desktop continuous and web remote replayable all go through the same resolver.
12. Add service-layer logs and development diagnostics for conservation failures so a bad snapshot never enters the UI silently.

## Questions needing separate rulings

1. Whether a background notification needs a light system boundary. Current ruling: not shown as a user bubble, and by default not in transcript rows.
2. Whether modelChange is finally a timeline row or SessionPane/banner state; either way it must not pollute rows.window as a hidden row.
3. Whether goal verifying remains a lock for compact/fork. The newer case catalog expresses no independent validating lock, but formal-proof and part of the implementation still use the old semantics and need a separate written-back ruling.
4. Whether append-only deltas extend with `row.inserted/row.moved`. This document recommends not extending; non-tail changes uniformly use snapshot resync to reduce the client error surface.

## Conclusion

To truly solve message order and swallowing, the CLI projection can no longer be treated as a "row append reducer"; the CLI must become a real timeline authority: **fact normalization** (raw events -> typed semantic entities), **order normalization** (constraint graph -> productTurnId / lane / orderKey), **display normalization** (resolved snapshot -> a dumb-rendering UI) and **conservation normalization** (invariants for input, assistant, compact, goal, fork and background). Only at this layer can the UI truly not guess, not patch and not swallow.
