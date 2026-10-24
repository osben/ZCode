# Timeline Authority Implementation Plan

> Based on [`15-timeline-resolver-design.md`](./15-timeline-resolver-design.md) (design),
> [`15-timeline-resolver-design-review.md`](./15-timeline-resolver-design-review.md) (first review, F1-F10)
> and a second code-level review (R1-R13, 2026-07-07).
> Goal: fix the "message/timeline order misplacement" and "message silently not rendered" problems that
> survive the v4 refactor, while staying compatible with existing user history
> (`~/.zcode/cli/db/db.sqlite`: 2,989 sessions / 26,942 messages / 96,112 parts at planning time).

Full history: `git show b8876e8b:docs/v4-refactor/16-timeline-authority-plan.md`

## Implementation status

P0-P4 are implemented and committed (feature/v4-vertical-slice). P5 is frozen.

| Phase                                                                                  | Commit      | Status                |
| -------------------------------------------------------------------------------------- | ----------- | --------------------- |
| P0 stop the bleeding (on-conflict drift fix + 0015 backfill/trigger)                   | `eef7ed7a9` | done                  |
| P1 read-side normalization (goal/model part consumption, session_entry merge, head-skip, conservation) | `5d08dfbb5` | done                  |
| P2 order authority (drain turn split, worked-time split, GV identity/placement, hidden-row cleanup, S2 flatten, S11 cold path) | `d35fa2123` | done                  |
| P3 session_input ledger (0016, atomic promote, wake accounting, resume sweep trace)    | `fb13f9940` | done                  |
| P4 wrap-up (fork provenance/remap, three-path normalization, turn-tail gate, conservation resync, shadow replay) | `f57146467` | done                  |
| P5 durable session_event journal                                                       | -           | frozen (§6-5)         |

Shadow replay acceptance (`apps/zcode-cli/scripts/shadow-replay.mjs`, local full history, 2026-07-08):
3,014 sessions, 0 replay crashes, 0 lost assistant bodies, 0 lost goalVerify markers. The 21 userInput
flags are heuristic false positives on legacy text-sniffed messages (goal-continuation reminders and
fork notices without a structural marker); the classifier behaves correctly.

Known leftovers from P1: the conservation criterion is still the order-insensitive `>=` (order-sensitive
node-level equivalence follows with the single normalizer in P2); the doc write-back list (§7 table) is
not yet executed.

### Cold merge ruling (2026-07-10)

P1 added goal/model cold recovery, but `v4-bridge.loadPersistedEvents` was still "in-memory eventStore XOR
transcript synthesis", which violates the three-source merge frozen here. The read side must converge on
one unit-testable cold merge:

```text
message / part durable transcript  ----\
                                        +--> cold merge --> canonical SessionEvent stream
session_entry goal legacy source  -----/
in-memory eventStore ------------------/     only fills in-flight / ephemeral
```

- Persisted user/assistant/reasoning/tool/timeline bodies are authoritative from message/part. In-memory
  body events with the same `assistantMessageId` / `partId` / `toolCallId` are not projected again.
- Exception: a non-terminal turn is filled wholesale from in-memory events (to keep the unpersisted
  streaming tail) and its already-persisted half-parts are not synthesized in addition.
- State with no transcript form (queue / permission / control / background) comes from the eventStore.
  Unrecognized or unalignable old facts are kept and reported as diagnostics, never silently dropped.
- In-memory goal / compact / fork boundaries carrying `anchorMessageId` / `targetMessageId` resolve only
  against that persisted entity, to the synthesized product turn, and insert at that turn's tail; never
  guess by text or time. A legacy boundary without a resolvable anchor goes after the last known host
  with a diagnostic.
- `SessionInputPromoted` is a known terminal queue state: the cold merge removes the matching
  `pendingInputId` from the pending set and raises no unclassified warning.
- `timeline/goal_verification` and session_entry keep deduplicating by `targetId+goalIteration`.
  `timeline/model_change` must consume `fromModel/toModel` explicitly rather than rely on the next user
  message's model snapshot.

### Projection closure ruling (2026-07-11)

message, part, session metadata and goal are the durable authority; live and cold both first produce
canonical facts. `rowId` is display-only; every actionable row is addressed by `entityId/productTurnId`.
This only completes the existing P1/P2/P4 loop and adds no client-mode product branch.

1. Edit of the latest real-user input (text or goal) goes through rewind; if a stable compact already
   covers it, atomically fork a child and navigate.
2. Running primary/continuation/verifier edit passes the stop barrier first; an active compact locks
   fork/edit/retry/send-now uniformly.
3. A user goal input produces a canonical visible real-user row, shares the `editUserQuery` target with a
   text query, and the resend keeps the `sendGoalCommand` intent. The `goalSet` lifecycle itself produces
   no marker.
4. A background model-only wake is always an independent product turn. Retry restores the full intent.
5. A stable fork is published only after all child-local references are remapped atomically.

## 0. Root-cause ruling (why the v4 refactor did not fix the original problem)

v4 moved state into the CLI projection with a dumb UI; that is right, and the protocol layer (closed delta
enum, apply, profile-closure invariants, snapshot+afterSeq recovery) is verified. This plan does not change
the protocol delta shape. Four systemic projection-layer gaps remain, each tied to a user-visible failure:

| #   | Gap                                                                                           | Code fact                                                                                                                                                                                                                                                       | User-visible failure                                              |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| G1  | No authoritative ordering: markers land where they arrive; payload anchors are ignored        | `product-projection.ts:1391-1408` (goalVerify), `:1225-1226` (compact comment "lands at row tail on arrival"); `TimelineMarkerRow` schema has no anchor (`rows.ts:224-231`); `turnIdOf` falls back to `"turn-unknown"` (`:1621-1623`)                          | goal verify / compact / fork markers drift to the wrong turn      |
| G2  | No entity identity: rowId is an in-process counter, user input has no stable id, goalVerify uses a volatile verificationId | `rowBase` `nextRowId++` (`product-projection.ts:1612-1619`); `buildUserInputRow` has no messageId/sourceCommandId; `verificationId = spanId ?? traceId` (`target-completion-verification.ts:108`) | duplicate verify markers; conservation undecidable; fork/edit lookup fails |
| G3  | Live and cold semantics differ: drain/model-only wake share one runtimeTurn live, cold splits/merges by real-user | live: `turn-loop.ts:33-55` + `onTurnSteerDrained` same turnId; cold: `transcript-hydration.ts:708-771`; UI folds by turnId + latestAssistantText (`conversationTurnRenderUnits.ts:77-174`)                                                                        | previous assistant folded into "worked" (Case A); structure changes after refresh |
| G4  | Input lifecycle not durable: event log, queue and wake commands are in memory only            | `InMemorySessionEventStore` (`adapters/storage/index.ts:21-55`, `create-app.ts:342`); `runtimeCommandQueue` array (`command-queue.ts:98-99`); resume drops pending steer (`steering.ts:825-869`); drain is non-atomic across stores (`steering.ts:726-760`)     | queue disappears and never reaches the transcript (Case B); restart loses queue/wakes |

Two corrected facts make the fix cheaper than 15's estimate:

1. The durable facts for goal verify / model change are complete: verification writes a timeline part every
   time (identity `targetId_goalIteration`, `anchorMessageId/anchorTurnId`, `events.ts:217-291`) plus a
   session_entry; model change also has a durable timeline part (`timeline-persistence.ts:44-87`). The loss
   is on the read side: hydration only consumes `context_compaction` (`transcript-hydration.ts:165-198,641-643`)
   and the conservation criterion does not count the other two (`:807-862`).
2. Cold recovery is "event log XOR full synthesis" (`v4-bridge.ts:320-338`) and the event log is in
   memory, so a real cross-process cold start always takes the lossy synthesis path.

## 1. Failure to fix-phase map (acceptance table)

| User-visible failure                                              | Root cause                                                                                                                                                                                                                                                                  | Phase                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| assistant reply disappears entirely (original pain point, not folding) | live: projection only accepts streaming text in phase=running, the "late terminal does not resurrect" gate silently rejects the whole segment (`product-projection.ts:527`); cold: assistant/synthetic messages before the first real user message are skipped (`transcript-hydration.ts:708-711`, triggered when the session head is a rewind notice/compact summary) | P1 + P2 (assistant conservation) |
| previous assistant looks gone (early text folded into "worked" after drain) | G3 + UI latestAssistantText inference                                                                                                                                                                                                                                  | P2                         |
| queue message disappears, never in transcript                     | G4 (non-atomic drain / projection holds in-memory state)                                                                                                                                                                                                                    | P3 (durable) + P2 (projection) |
| goal verify gone after cold recovery                              | G4 -> read side does not consume it                                                                                                                                                                                                                                         | P1                         |
| goal verify mispositioned / duplicate marker                      | G1 + G2                                                                                                                                                                                                                                                                     | P2                         |
| compact / fork marker mispositioned                               | G1; fork anchor approximated to row tail                                                                                                                                                                                                                                    | P2 + P4                    |
| model change gone after cold recovery / phantom fold region       | read side does not consume + invisible rows in the window                                                                                                                                                                                                                   | P1 + P2                    |
| background wake mis-attributed / user bubble appears              | G3                                                                                                                                                                                                                                                                          | P2                         |
| order differs between refresh/restart and live                    | G3 + XOR hydration                                                                                                                                                                                                                                                          | P1 + P2                    |
| marker state stuck at running                                     | out-of-window upsert is a silent no-op (`apply.ts:64-65`)                                                                                                                                                                                                                   | P4                         |
| queue / pending wakes silently lost on restart                    | G4                                                                                                                                                                                                                                                                          | P3                         |

## 2. Overall design (adopting 15's layering with three corrections)

```text
Persisted Facts (authority): message / part / session metadata / goal (+ in-memory event log only as live accelerator)
        |
        v
Event Normalizer (single entry, P1 focus)
  live events and cold facts both normalize into typed semantic events
  three-source merge + dedup; the XOR choice is abolished
        |
        v
Semantic Ledger (P2)
  typed entities, entityId always derived from persisted facts
        |
        v
Timeline Resolver (P2, weakened)
  primary order = normalizedOrderKey, near-total order (below)
  + bounded anchor re-hang (boundary attaches to the target productTurn tail; no general topological solving)
        |
        v
Materializer: during the compatibility period keeps emitting rows.window (with entityId/productTurnId/visibility)
        |
        v
UI: renders the resolver result; the turnId+latestAssistantText inference is deleted
```

**normalizedOrderKey.** Today's four sequences are incomparable (message.sequence is session-wide,
part.sequence is per message, session_entry has none, event order is independent), so they must be
normalized first or the implementation falls back to timestamp/append guessing:

```text
normalizedOrderKey = (
  branchEpoch,        # rewind/fork generation, outermost
  hostMessageSeq,     # session-wide sequence of the message the fact lives in or is anchored to
  hostPartSeq,        # part sequence within the message; message-level facts use -1
  boundaryRank,       # lane order at the same host position: trigger < assistantWork < turnTailBoundary
  lifecycleOrdinal,   # Nth state change of the same entity
)
```

- Facts without a message host (session_entry goal verify, live events) resolve through the anchor to the
  host message (`anchorMessageId` -> its messageSeq). On failure they land after the last known host plus a
  diagnostic; timestamps are never guessed.
- In-flight live output not yet persisted sorts after all persisted facts, by event order. Once persisted,
  hostMessageSeq takes over (entityId unchanged, only the authority source switches; no position jump).

Corrections to 15:

1. The focus moves from a constraint graph to the normalizer (first-review ruling): the ordering skeleton is
   near-total; the hard part is normalizing each fact into a typed entity with stable identity, anchor and
   visibility.
2. Resolver output is not persisted: `productTurnId/orderKey/lane/placement` may only be cached.
3. Durable/ephemeral split: streaming deltas never enter the durable fact layer; a future durable
   session_event journal (P5, separate ruling) would store durable events only.

## 3. Historical data compatibility (hard constraints for all phases)

1. **Historical rows are read-only**: message/part/session_entry history is never rewritten, and no
   "re-save to repair" is allowed. Before the P0 on-conflict fix, re-saving a NULL-sequence row drifts it
   to the queue tail (`messages.ts:41-44`).
2. **Deterministic order**: historical rows keep the current read order `sequence is null, sequence,
   time_created, rowid/id`; a golden pins "hydrating the same session repeatedly yields the same order"
   (including NULL mixing and same-millisecond timestamps).
3. **Missing fields are derived at read time**: old data without semantics/anchor is derived by the
   normalizer with an explicit fallback placement (by fact order + diagnostics); never dropped silently,
   never crash.
4. **Dual-source dedup**: goal verify across `session_entry` (legacy primary, 1,402 rows) and
   `timeline/goal_verification` parts (new writes) merges by `targetId+iteration`; the differing products
   of the three fork paths (with/without timeline part) must all be recoverable.
5. **NULL-sequence incremental backfill runs once**: close the write source first (P0), then idempotently
   re-run the 0014 window-function backfill (only `where sequence is null`) with an audit log.
6. **Old fork children**: part-embedded anchors pointing at parent ids (`clonePartForFork` does not remap,
   `steering.ts:60-65`) degrade to originRef/diagnostics in the resolver and do not participate in placement.
7. **No visibility regression**: once the normalizer treats semantics as authority, old messages classified
   by text sniffing (compact summary, goal continuation, task notification, rewind notice, fork notice)
   keep their visibility; locked by an all-category classification golden.
8. **Protocol compatibility**: the rows.window shape stays; desktop/web clients need no lockstep upgrade.
9. **Shadow-replay acceptance**: a dev command runs all local historical sessions through the new pipeline
   and outputs the conservation-failure list and old-vs-new projection diff. Release gate = failure list
   reviewed by a human, no silent drops.

## 4. Phased plan

### P0 Stop the bleeding: close the bad-data source (no behavior change)

- Fix both on-conflict branches in `messages.ts`: re-saving a NULL row must not drift it to the tail; make
  the cross-session rebind (import upsert) branch explicit or forbid it.
- Add a DB trigger/constraint: new message/part writes must not have NULL sequence (the trigger may fill
  `max+1` for old-binary writes to stop version skew from producing NULLs).
- Locate the NULL source: the 1,690 NULLs added after migration are primarily suspected to be version skew
  (an old binary writing the same DB); verify through trigger auditing, not by grepping for side paths.
- After closing, idempotently re-run the backfill (principle 5).

Not done: no projection, hydration or UI change.
Acceptance: `null-seq-determinism` golden (L1); new NULLs drop to zero after the trigger ships (DB audit).

### P1 Read-side normalization: Event Normalizer + three-source merge (read-time only)

Goal: cold recovery stops losing facts (goal verify / model change disappearing after refresh; fork child
recovery losing facts).

- New Event Normalizer module (bootstrap/zcode-protocol-v4); live events and cold facts share one
  classification entry. `getConversationMessageProjectionPolicy` becomes an internal detail: semantics
  first; text sniffing only for legacy data without semantics, counted in diagnostics.
- `v4-bridge.loadPersistedEvents` changes from "event log XOR synthesis" to a **three-source merge** with
  two layers:
  - **Authority priority (body facts)**: message/part is the durable transcript authority. The in-memory
    event log may only add (1) in-flight streaming state not yet persisted and (2) ephemeral state with no
    durable form (queue display, permission interaction, control phase). When both sources hold the same
    `assistantMessageId`/`partId`, the persisted source wins (events only supply streaming intermediate
    frames); a body is never projected twice.
  - **Boundary dedup keys**: compact=`operationId`, goal=`targetId+iteration`,
    fork=`parentSessionId+targetMessageId`, model=`anchorMessageId+from/to`. session_entry is only the
    legacy source for goal verify and merges across sources with the timeline part.
- Hydration additionally consumes `timelineType=goal_verification / model_change` parts and session_entry
  (`SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION`).
- **Fix the hydration head skip** (`transcript-hydration.ts:708-711` currently skips; the cold vector of
  "assistant reply disappears"). If a recoverable parent/anchor resolves (the matching model-only input
  message, rewind/compact context), build a **preface productTurn** (model-only trigger, no visible bubble,
  visible assistant content); otherwise emit a **visible diagnostics row**. Both go into the live=cold
  golden; silent drop is forbidden.
- Upgrade the conservation criterion: the `eventsCoverTranscript` footprint-subset check becomes an
  order-sensitive node-level equivalence that counts goal/model (P2 upgrades it to node-level golden).

Not done: no ordering-rule change, no UI change, no new DB fields.
Acceptance (L1/L2): `GV-cold` / `MC-cold` / `GV-cold-session_entry` / `classifier-golden` / three-source
merge golden (same terminal state for any subset present) / `assistant-head-skip` (a session whose head is a
rewind notice / compact summary still shows the assistant reply after cold recovery).

### P2 Order authority: entity identity + productTurn split + anchor placement

Goal: live = cold in one structure; A1/A2 both visible; markers placed by anchor.

- **CanonicalFact carries both visibility and command addressing.** Live `SessionEvent` and cold
  message/part must not each build a look-alike payload; before ProductProjection they normalize to the same
  persisted-entity fields: `entityId/productTurnId/runtimeTurnId/transcriptMessageId/visibility/origin/placement`.
  Cold hydration passes the existing `message.info.id` as `transcriptMessageId`; it must not re-match a
  persisted runtime anchor via `hydrate-turn-N`.
- **row, command target and row.actions are materialized atomically.** `rowId` is display/virtual-scroll
  only and never enters server business addressing. The `entityId/productTurnId -> transcript message/turn
  boundary` mapping is part of ProductProjection's command projection, not an optional cache. Producing or
  updating an actionable row must generate the stable command target and `actions.canEdit/canRetry/canFork`
  in the same reduction:

  ```text
  row.actions.canEdit
    <=> resolveEditTarget(entityId, productTurnId) succeeds
    <=> target is the last real user transcript message

  row.actions.canRetry
    <=> resolveRetryTarget(entityId, productTurnId) succeeds
    <=> target is the last stable assistant transcript message in the whole timeline
  ```

  The UI renders only the CLI-provided row.actions and never derives edit/retry/fork from array position,
  phase or raw messages. The command handler still guards, but a half-projected state ("entry visible, target
  must fail on the same revision") must not occur.

- **live/cold equivalence is upgraded to addressability equivalence.** Shadow replay/golden must also compare,
  per row, the command target and actions for `entityId/transcriptMessageId`, covering at least: provider
  failure before first token, tool-only, empty assistant, latest-query edit after cold resume, and a normal
  completed assistant. "0 lost messages" no longer means the projection loop is closed.
- **entityId derivation (frozen contract)**: a queue item and a promoted user message are two entities and
  never share identity.
  - `QueueItem.entityId = pendingInputId/inputId` (= session_input.id once the P3 ledger lands).
  - `Promoted UserIntent.entityId = persisted user messageId` (the drain event's `injectedMessageIds` and
    `pendingInputIds` correspond one-to-one; the runtime calls `persistUserPrompt` before emitting the drain
    event, `steering.ts:741-756`).
  - They link by cause ref: `UserIntent.cause = { pendingInputId, sourceCommandId }`.
  - Input conservation: every pendingInputId is either still a QueueItem or has a promoted UserIntent whose
    cause points at it (exactly one).
  - assistant=assistantMessageId; compact=operationId; goalVerify=`targetId+iteration` (verificationId is
    only an attempt alias); fork=`parentSessionId+targetMessageId`. `nextRowId++` and DB lexical order are
    forbidden as identity.
- **productTurn split rule** (first-class invariant, ruled 2026-07-07/11, see §7): within one runtimeTurnId,
  boundaries are drawn by the fact order of trigger-type UserIntents (**queue drain / model-only
  continuation / background wake**). A background model-only wake always creates an independent productTurn
  and no visible user trigger row. **A steer (guide-mode injection) is not a boundary**; it is inline in the
  current turn, which needs both delivery=steer/queue semantics (carried by the session_input ledger). The
  live path emits productTurn boundaries at the boundary; the cold path gets the same structure through the
  same normalizer.
- **Drain granularity**: the runtime drains one queue item at a time; each item maps 1:1 to one productTurn
  and one reply (§7).
- **Worked time**: a productTurn splits worked time by boundary; each turn shows trigger -> next boundary,
  and the sum equals total worked time (§7).
- **Assistant conservation (live rejection vector)**: the "late terminal does not resurrect" gate
  (`product-projection.ts:527`) must not silently drop streaming text; on rejection it records diagnostics
  and triggers a resync from persisted facts. Every persisted assistant message maps to a visible segment or
  a diagnostics row.
- **Multi-segment text**: all assistant text segments in one productTurn are shown flat; only
  tool/reasoning/subagent activity folds into "worked" (§7).
- **Lifecycle facts that produce no marker row** (§7): `retryNotice`, `goalSet` and parent-side
  `forkCreated` no longer produce timeline marker rows (today all three are "in the window, render null"
  invisible rows). The `goalSet` state fact belongs to the goal panel, but each user `sendGoalCommand` input
  that triggered it must still materialize as a canonical visible real-user row sharing the `editUserQuery`
  target with a text query. Fork relationship lives in the sessions tree; retry leaves no trace. A background
  wake turn has no trigger row (S14).
- **Partial turn shapes** (protocol PB-AUTO-COMP-STOP-G12 + S15): resolver/UI must support an interrupted
  turn with only a trigger (plus optionally a cancelled compact marker) and no assistant segment (an
  auto-compact pendingAction stopped, or an injected steer stopped). Conservation must not flag it as lost
  and folding must not swallow it.
- **goal verify boundary**: identity `targetId+iteration`, **upsert-by-lifecycleKey** (either started or
  terminal can create the entity; the "terminal dropped without started marker" and `if (!goal) return []`
  silent drops are removed); placement uses `anchorAssistantMessageId || anchorTurnId || explicit fallback`;
  the `"turn-unknown"` black hole is removed.
- **Multi-segment assistant**: one productTurn keeps all segments; fork attaches only to the last completed
  segment of its turn; retry attaches only to the last assistantText row of the whole timeline (guaranteed at
  the resolver output; the UI no longer infers).
- **edit/retry intent loop**: unified `editUserQuery` resolves only the active branch's latest real-user
  canonical intent (text or goal). Not covered by a compact: rewind. Covered by a stable compact:
  conversation-only atomic fork child, then navigate once the projection is available. A user goal input is
  an ordinary real-user row sharing the stable `entityId/productTurnId` action target; the resend keeps the
  `sendGoalCommand` intent and never degrades to `sendText`. Retry restores text/goal kind, attachments,
  delivery/fallback and source cause from the canonical cause, never rebuilt from row text. Running edit of
  primary / goal continuation / goal verifier (including the latest goal input) passes the stop barrier
  first; if the barrier fails, no rewind and no new text/goal starts, keeping the old active work, input and
  branch. An active compact applies one operation lock to fork/edit/retry/send-now.
- **stateOnly channel**: modelChange and similar do not render a marker and do not enter rows.window (or are
  ruled a visible row; never an invisible "in the window, render null" row). The materializer exit hard-checks:
  stateOnly/hidden never enter rows, and a hidden trigger does not affect the turn count.
- **UI**: `conversationTurnRenderUnits` consumes the resolver result (rows carry
  `entityId/productTurnId/visibility`); the turnId+latestAssistantText inference is deleted.
- The conservation check lands fully per 15's conservation invariants; failure does not publish a bad
  snapshot and records diagnostics.

Acceptance (L1/L2/L4): `QD-node` (A1 in T1, A2 in T2, both visible, live = cold); `GV-identity` /
`GV-terminal-only` / `GV-late-anchor`; `BG-wake-cold` (independent model-only turn, no user bubble);
live = cold node-level golden; `assistant-conservation-live` (streaming text arriving in a non-running
phase is not dropped silently: diagnostics + resync; the live vector of "reply disappears"); `steer-inline`
(S1: steer does not split the turn, one worked span, edit rewinds the whole turn); `drain-per-item` (S3);
`worked-time-split` (S5); multi-segment text flat + fork only on the last segment (S2);
retryNotice/goalSet/forkCreated no longer produce lifecycle marker rows (S7/S9/S10, invisible rows cleared);
the canonical real-user row of a user `sendGoalCommand` input is retained.

### P3 Durable write side: session_input ledger + atomic promote (the root of "swallowed messages")

Goal: queue/wake existence no longer depends on any process memory.

- New table `session_input` (migration 0015): `id` (= **input/command id**, exists at admission),
  `session_id`, `kind`, `delivery` (steer/queue), `payload_json`, `admitted_sequence`, `promoted_sequence`,
  `promoted_message_id` (**nullable**, written in the same transaction as the user message when promoted),
  `status` (admitted/promoted/**cancelled/discarded**; cancelled/discarded carry TurnSteerDiscarded and
  stop-held semantics), `time_created/updated`.
  Status transitions cover the protocol's existing rulings: `discarded(session_resumed)` (§6-1, restart keeps
  nothing); `discarded(user_cleared)` (heldQueueInputRequiresChoice clearQueueAndSend); a steer in
  submitting that is stopped goes back to `admitted` (back to the held queue); an already-drained one that
  is stopped becomes `promoted` (message stays in the turn as interrupted, S15). The ledger also gives
  input-type commands durable idempotency (the command-inbox idempotency table is an in-memory LRU and dies
  on restart).
  Note: ZCode's messageId is created by `createMessageId()` at drain time, so no pre-allocated message id
  exists at admission to reuse as the input id; a nullable foreign key disturbs the existing id flow least
  and lets the ledger express "accepted but not consumed".
- **Atomic promote**: drain/promote and user message persistence share one transaction. The drained row text
  comes from the ledger; the projection no longer depends on in-memory `queue.items` (the
  `if (!item) continue` silent drop in `onTurnSteerDrained` is removed).
- Background wake: a `task-notification` command enters the ledger (admitted) and is promoted after the wake
  runs; a pending wake is recoverable after a crash.
- **Crash/restart semantics (ruled)**: the queue is not kept after restart; the ledger records unconsumed
  items as `discarded(session_resumed)` as a trace. No silent disappearance without a ledger entry.
- New message/part writes additionally carry `semantics/anchor/sourceCommandId/cause/visibility` JSON fields
  (old data untouched, derived by the P1 normalizer).

Acceptance (L2/L4): crash-window replay: admitted-not-promoted items recover as `discarded(session_resumed)`
after cold recovery and do **not** enter the queue (consistent with §6-1); crash after promote -> the
transcript has exactly one matching user message (no orphan, no double write); queue behavior after restart
L4 (empty queue + discarded trace in the ledger).

### P4 Transport and fork wrap-up

- **Late-change delivery (ruled, §7)**: the CLI resolver does not know the user's visual region and
  maintains only the complete timeline authority. A late change with an out-of-window anchor is not rendered
  immediately, not appended to the tail, and not dropped: the publisher records a dirty range / revision and
  the client gets the latest structure when it materializes that productTurn. The same rule covers "upsert
  target not in the delivered window" (today `apply.ts:64-65` no-ops silently).
- **Fork fixes** (new forks only; old data follows principle 6): newly copied message/part write `origin*`
  provenance. Child session metadata, message/part, goal snapshot, fork provenance and projection anchor are
  written in one atomic transaction. All child-local message/part/tool/timeline/compact/goal references
  (including anchorMessageId, compaction tail_start_id/summaryMessageId) are remapped through one mapping
  table; only an explicit originRef may keep pointing at the parent. If any child-local reference cannot be
  remapped, the whole fork fails and the child is not published; no half-finished degradation. The persisted
  products of the three fork paths are unified (`forkWorkspaceAtMessage` adds the timeline part). The parent
  side no longer produces a forkCreated row (§7: fork relationship only in the sessions tree; child's leading
  forkNotice is kept), which removes the "exact anchor vs row-tail approximation" problem. The core fork
  entry validates: only the last completed assistant segment at a turn's end (§7 ruling 3).

  Fork atomicity/remap does not change workspace policy: a running stable fork is conversation-only and does
  not rewind the shared workspace; compact-covered edit is an append-only branch cut in the original session
  and no longer reuses the fork bundle; existing checkpoint behavior of completed/idle forks is neither
  widened nor narrowed.

Acceptance: out-of-window upsert L2; `fork-remap` golden (every child-local reference checked, failure rolls
back); `resync-scope`; fork graph cut L4 (regression guard).

### P5 (separate ruling, does not block P0-P4): durable session_event journal

There is no durable event log today (R1). P0-P4 rely on "message/part/session metadata/goal as authority +
in-memory event log as live accelerator" and do not depend on this item. If built:

- table `session_event(id, session_id, sequence, kind, data_json)` + per-session allocator;
- durable/ephemeral split required (streaming deltas not stored);
- gains: session-wide total order, ledger can degrade to `command.*` events, web remote replay needs no
  synthesis;
- cost: write amplification, retention policy, double-write consistency with existing message/part.

## 5. Test and acceptance infrastructure

- L1/L2/L4 cases are listed in each phase's acceptance (one-to-one with the review list); accepted semantics
  are written back to the case catalog and coverage matrix.
- **Shadow-replay tool** (delivered in P1, reused by P2/P3/P4): a dev command walks local historical
  sessions, hydrates through the new pipeline, and outputs the conservation-failure list, diagnostics
  fallback counts and a structural diff against the old projection. Gate per phase = full replay with no
  crash, no silent drop, and failure list reviewed.
- Conservation failures expose diagnostics in dev and log in the service layer (15 §migration advice 12,
  maintained).

## 6. Rulings (user-decided 2026-07-07, all final)

1. **No queue retention after restart**: the ledger records `discarded(session_resumed)` as a trace (P3).
2. **modelChange visibility**: switching the model in the input box does not enter the timeline; only the
   turn actually sent after the switch gets the "model switched" divider (same as R-17, frozen).
3. **Fork only at turn ends**: the UI does not expose fork on intermediate assistant segments; the core layer
   validates that only the last completed assistant segment at a turn's end is allowed (P2/P4).
4. **Late change = dirty range / lazy materialize**: see P4.
5. **P0-P4 do not build a durable session_event journal**: message/part/session_entry remain the durable
   authority and the in-memory event log is only a live accelerator. If unified event sourcing is still
   wanted after normalizer/resolver/session_input land, session_event goes to a separate P5 review.

## 7. Order and business-semantics rulings (aligned item by item with the user 2026-07-07, normative source for L1 goldens)

Diagnosis correction (user confirmed): the main "previous reply gone" symptom is the **whole assistant
reply disappearing** (live rejection gate + cold head skip, §1 first row); folding is only a secondary
impression. Both are fixed: assistant conservation and flat multi-segment text.

| #   | Scenario                                                          | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Scope                                    |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| S1  | steer (guide-mode injection while running)                        | **Inline, no turn split, independent visual work segments (corrected 2026-07-19)**: the bubble is inline at the injection point; assistant segments before and after belong to one productTurn. Each accepted guide closes the previous visual work segment and opens a new one, each with its own worked time/fold. Still one fork entry (the turn-tail segment). Editing a steer message = rewind and rerun the whole turn. Needs delivery=steer/queue semantics | split rule, ledger delivery field, turnHeader.workSegments |
| S2  | multiple assistant text segments in one turn (text->tool->text)   | **Row total order first**: the renderer must follow the CLI row total order; earlier text, tool/reasoning/subagent/compact in one visual work segment must not be re-bucketed or re-sorted. A normal segment has one fold control; a guide boundary opens a new segment/control per S1. The turn-tail last assistantText is externalized as the final body; fork attaches only to the turn's last segment, retry only to the last assistantText row of the whole timeline; copy on the tail segment = all text segments of the turn merged                    | UI render units                          |
| S3  | consumption granularity of multiple queued items                  | **One turn each**: the runtime drains one item at a time; queue item : reply : productTurn = 1:1:1                                                                                                                                                                                                                                                                                                                                                                                                                                                 | runtime turn-loop, ledger conservation   |
| S4  | goal verify x queue order                                         | **Queue first (bounded window)**: items admitted before the verify scheduling point (when the previous turn settles) are consumed first, then verify; items admitted after the point go to the next scheduling window (after this verify/continuation), so continuous appends cannot starve verify. A notSatisfied continuation goes after this window's user input. **Addendum (catalog BG03, accepted)**: while any background task is running the verifier defers its request; the post-command goal loop re-verifies only after background notifications are consumed. Full order = drain queue -> wait for background notifications -> verify -> continuation | continuation loop scheduling             |
| S5  | "worked xx s" after drain splits turns                            | **Split by boundary**: each turn shows trigger -> next boundary; sum = total worked time                                                                                                                                                                                                                                                                                                                                                                                                                                                           | turnHeader computation                   |
| S6  | inter-turn auto compact (new input triggers over-threshold compaction) | **Belongs to the next turn's first activity**: narrative is "user sends -> compress -> start working" (in-turn compact stays an assistant-work activity)                                                                                                                                                                                                                                                                                                                                                                                   | compact placement                        |
| S7  | parent timeline after fork                                        | **No forkCreated**: fork relationship only in the sessions tree/list; child's leading forkNotice is kept                                                                                                                                                                                                                                                                                                                                                                                                                           | projection emits no row; rewind x fork problem disappears |
| S8  | rewind/edit truncation of a turn containing a fork point          | **Disappears with the branch**: the timeline reflects only the current branch; the child stays reachable in the sessions list                                                                                                                                                                                                                                                                                                                                                                                                                      | branchEpoch semantics                    |
| S9  | retry trace                                                       | **No trace**: the old turn is replaced wholesale; retryNotice removed from the projection (clears the invisible row); use fork to keep the old branch                                                                                                                                                                                                                                                                                                                                                                                               | projection emits no row                  |
| S10 | goalSet boundary                                                  | **stateOnly lifecycle + visible user intent**: the `goalSet` fact shows no timeline marker (carried by the goal panel); each user `sendGoalCommand` still yields a canonical visible real-user row sharing the `editUserQuery` target with a text query; resend keeps the goal intent                                                                                                                                                                                                                                                                | stateOnly vs user-input layering         |
| S11 | several background completions (idle)                             | **One turn per notification**: symmetric with S3, 1:1, serial model-only turns (current behavior, frozen)                                                                                                                                                                                                                                                                                                                                                                                                                                          | wake scheduling                          |
| S12 | actions while goal is verifying (refined 2026-07-08/11, updated 2026-07-13) | **goalVerifier is no longer an independent operation lock**: messages (sendText / `/goal`) and typed `/compact` are queued; fork is **allowed** (stable history suffices, aligned with catalog H06); sendQueuedNow is **allowed** = stop the verifier first (counts failed(cancelled), goal becomes paused) then drain (aligned with catalog line 238); edit of the latest real-user input (text or goal) is **allowed** = stop the verifier, then rewind/fork by the unified `editUserQuery` target and resend with the original intent kind; a barrier failure keeps old work/input/branch and starts no new goal. Edit of a non-latest real-user input is still rejected; stop can interrupt the verifier. Only active/queued compact hits `compactOperationLock` | guard/availability                       |
| S13 | model switch before a model-only continuation turn                | **Show the divider as usual**: whenever a turn actually uses a different model from the previous turn, drop a divider, whether triggered by user, goal continuation or BG wake                                                                                                                                                                                                                                                                                                                                                                     | modelChange placement                    |
| S14 | visible trigger form of a background wake turn (2026-07-08, settles 15's open ruling #1) | **No trigger row**: a wake turn shows only assistant content + its own "worked"; background info lives in the background drawer/status area; the `turn:t2/input:background-result` row in the protocol doc's rows example must be corrected                                                                                                                                                                                                                                                                                        | rows contract                            |
| S15 | user stops after a steer was submitted but drain unconfirmed (2026-07-08) | **Distinguished by whether injected**: runtime confirmed drained -> the steer bubble stays in place inside the turn (turn marked interrupted, edit/retry available after stop, aligned with G12); still submitting -> back to queue (held, autoDrain=false), ledger returns to admitted                                                                                                                                                                                                                                                              | stop closure, ledger state transitions   |

### Doc write-back list (existing docs to sync after S1-S15)

| Document                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/conversation-product-protocol.md`                    | (1) rewrite the `goalVerifierActiveWorkOperationLock` invariant and stable guard per S12 (messages and typed compact queue, fork allowed, sendQueuedNow = stop barrier, latest text/goal edit = stop barrier); (2) Fork table row `activeWork.kind=goalVerifier -> reject` becomes allow; (3) drop the `turn:t2/input:background-result` row from the Projection Shape rows example (S14); (4) distinguish the marker-less `goalSet` lifecycle from the visible editable user goal input; (5) `compactActiveWorkOperationLock` covers only active/queued duplicate compact |
| `docs/conversation-session-case-catalog.md`                | write back S1-S15 (especially S1 steer inline, S3 one turn each, S4 bounded window, S14/S15); H06 and line-238 semantics stay authoritative                                                                                                                                                                                                                                                              |
| `packages/formal-proof`                                    | remove the old goalVerifier lock semantics, align with S12                                                                                                                                                                                                                                                                                                                                              |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | add entries for the §4/§5 acceptance cases                                                                                                                                                                                                                                                                                                                                                              |
| `docs/v4-refactor/15-timeline-resolver-design.md`          | open ruling #1 -> S14, #2 -> §6-2, #3 -> S12, #4 -> §6-4, mark as ruled                                                                                                                                                                                                                                                                                                                                 |
