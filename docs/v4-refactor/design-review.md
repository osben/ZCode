# V4 Refactor Design Review: Cross-Check Against Existing Code and Historical Bugfixes

- Status: **pre-migration audit record, 2026-07-04**. "Existing code", paths, line numbers and open rulings
  describe the baseline before the V4 hard cut; the current implementation follows the specs and code
  navigated from [README.md](./README.md) in this directory.
- Input: all 10 docs in docs/v4-refactor/ + the full text of conversation-product-protocol.md.
- Method: a pure design review, then a read-through of five code domains (renderer assembly layer / stream
  events and snapshot sync / store and web entry / transport and remote control / CLI fact source, about
  20k lines). Historical bugfix/workaround comments were clustered into **60 case classes**, each judged
  "structurally eliminated / rule must be pinned / design gap / would return in a new guise". Cases carry
  code locations (appendix).

Full history: `git show b8876e8b:docs/v4-refactor/design-review.md`

## 1. Summary

**The direction is strongly backed by the code.** About 40 of 60 case classes are structurally eliminated by
the new design. The old code already grew half of v4 on its own: owner/observer dual streams were forced back
into one seq stream, the bridge layer grew three manual "generation" fields
(bridgeSessionId/bridgeGeneration/recoveryId), and the CLI protocol boundary uses deterministic batching so
replay is reproducible.

**Three main work items:**

1. **Foundation misstatement (most important).** The README foundation row "rpc reliability layer mature:
   ACK, heartbeat, reconnect replay" does not hold. `PersistentProtocol` is library code ported with the VS
   Code architecture and has **zero production deployments** (real links use `SocketProtocol` /
   `MessagePortProtocol` without ACK/replay); it also lacks receiver-side dedup, server-side reconnect
   attach, and never sends ACKs proactively. Phase 2 is "productionizing an unverified reliability layer for
   the first time", not "two small patches" (§2, R-02). A second misstatement: **the event log is in-memory
   only** (M8), so "CLI restart rebuilds from SQLite event replay" does not hold; a persistence-form
   decision is needed (§9.2).
2. **Schema gaps.** sessionConfig (current provider/model/thought/followupMode), usage/contextWindow,
   backgroundWorks[], plan/todo, timestamps and worked time have no home in 09; two independent scans found
   the same gap, and the existing patch clusters would be carried into the new architecture (§4).
3. **Protocol rules to pin.** Subscription epoch, three-branch duplicate-frame handling, seq/rowId/revision
   determinism, snapshot atomicity, and about 18 more; unpinned, the bug classes being eliminated return in a
   new guise (§3).

**Final persistence stance (§9, after author rulings):** CLI-side SQLite gets **zero new tables and zero
migrations**. The user query queue is not persisted; by inference the command/continuation inboxes are
in-memory acceptance ledgers and crash-window idempotency is carried by "effects carry `sourceCommandId`".
The only storage change is additive JSON anchor fields on message/part. In one sentence: **the only state
that must not be lost = transcript + anchors; everything else (event log, projection, queue, inbox) is
rebuildable soft state**, in line with 01's self-similar recovery principle.

**Ruling ledger:**

| Status                    | Item                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ruled                     | The user query queue is not persisted -> the two inbox tables are not built, no `queue_auto_drain` column, C-03 dissolves (a CLI restart never replays; in-flight commands are reconciled by the client via `commands/query` and the user decides on resend). 03 "Inbox persisted" and the "SQLite event replay" wording in 01/02/04 are to be rewritten per §9.3/M8 |
| Ruled (2026-07-05)        | (1) event-log persistence = **plan B** (bounded in-memory log + logEpoch, zero tables); (2) fork/createSession crash-window dedup = **child session records `source_command_id`**; (3) C-01 multi-client action authority = **fully peer** (idempotent closure); (4) C-04 = **keep draft** (overturns 10-P2; createSession.firstInput becomes optional, draft is memory-only); (5) 10-P3 rewind = **delete the standalone command** (UI entry of editUserQuery); (6) execution path = **hard cut** (no dual-write period, see 08/11) |
| Open                      | the rest of §5 (C-02 pending TTL, C-06 Phase 2 stop-gap scope, C-07 behavior-change list, C-08 stream-animate libraryization); G-12 fault catalog; G-13 auth surface; the four PB-* boundaries                                                                                                                                                                        |

Suggested order: **before Phase 0**, write back the design docs per §2.2 (M1-M8) and §7, pin the 18 rules of §3
and add the schema chapter of §4, and settle §9.2 and fork dedup. **During implementation**, make the §8
golden tests / chaos rig first-class acceptance (the first production use of the rpc layer needs it).

## 2. Verification of the current-state diagnosis

### 2.1 Confirmed (spot checks all hit)

The four renderer anchor behaviors match; all size numbers are
accurate (3089 / 1056 / 2141 / 5871 lines); `afterSeq`+`includeSnapshot` (zcode-protocol:2109),
`expectedRevision`, `reduce()`, `buildTraceTree`, no batching at
channelClient.ts:173, base64 double encoding, `Pause=7` really is an
unimplemented slot (`ReplayRequest=6`/`Resume=8` are also enum-only), the `@tanstack/react-virtual`
dependency and reference implementations such as GitPane, the `content-visibility` fallback, and the old protocol source is already gone.

### 2.2 Misstatements / items to rewrite (by impact)

| #  | Design text                                                                                                                                                  | Actual                                                                                                                                                                                                                                                                                                                                                                         | Impact                                                                                               |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| M1 | README foundation "rpc reliability layer mature"; 05 "desktop socket uses PersistentProtocol"                                                               | PersistentProtocol has zero production deployment; no receiver dedup (protocol.ts:411 has no `id <= incomingAckId` drop branch, replayed duplicates are passed up as is); no server handshake binding a new socket to the old protocol instance; ACK only piggybacks on the 5 s KeepAlive; death detection is actually 20-40 s (20 s interval timer checking a 20 s timeout). Reality is "0.5 layer of reliability" (only relayProtocol's), not "two half-baked layers" | Re-estimate Phase 2 workload and risk, see R-02                                                      |
| M2 | README root cause 2 "every delta is an independent EventFire frame", "existing batching only saves rendering"                                               | The CLI protocol boundary already has deterministic byte-budget batching (server-operations.ts:447, :3277 "cannot use live setTimeout, otherwise replay cannot reproduce boundaries"); client batching also forces a flush before control events to preserve order                                                                                | Reword to "small batching granularity, each protocol event still its own frame, relay base64s twice"; 05 frequency budget baseline uses measured frame counts; decide whether to keep this CLI batching (R-14) |
| M3 | 03 "queue is pure memory (agent-runtime.ts:159 `pendingInputSequence`)"                                                                                     | `pendingInputSequence` is only an id counter; the volatile parts are **two**: the CLI steer queue `activeTurn.pendingInputs` (memory) and the UI deferred queue (renderer memory, lost on refresh)                                                                                                                                                                              | Author ruled the queue is not persisted (§9.3): fix = unify both queues' ownership into CLI memory; rewrite 03's "Inbox persisted" attribution; discarding the UI local queue still stands |
| M4 | README "protocol is already seq-monotonic incremental events"                                                                                               | The skeleton exists, but protocol seq is **lazily numbered in memory** per `(session record, deliveryKind)`: afterSeq is meaningless after restart, each deliveryKind has its own seq space, each subscribe rescans the full history                                                                                                       | v4 must promote seq to a persistent log property: new work, not an existing foundation (R-04)        |
| M5 | 02 "all CLI facts for each ProductContext dimension already exist"                                                                                         | The queue dimension is the exception: the deferred queue fact lives on the UI side today                                                                                                                                                                                                                                                                                     | 03's queue consolidation is a prerequisite of 02; state it in the phasing order                     |
| M6 | 05 "five or six reconnect entries"; 01 "three web paths"                                                                                                   | About 10 reconnect entries measured; web actually has 3+1 forms (also a home-only stub mode with about 20 hand-written stub services)                                                                                                                                                                                                                                         | Direction right, magnitude underestimated; after the stub mode is gone define the UI degraded form when the host is unreachable (G-11) |
| M7 | 08 "the old protocol leaves about 200 dist artifacts"                                                                                                       | 324 measured                                                                                                                                                                                                                                                                                                                                                                 | none                                                                                                 |
| M8 | README foundation "rebuild projection with reduce(events), hot and cold recovery consistent"; 02 "rebuilt from persisted events on session resume, no second recovery path"; 01 "CLI restart -> rebuild projection from SQLite event replay" | **The event log is not persisted**: the only implementation of `SessionEventStorePort` is `InMemorySessionEventStore`, and production wiring is it (create-app.ts:340 `options.eventStore ?? createInMemorySessionEventStore()`); after a CLI restart `eventStore.getEvents()` is empty and cold recovery really relies on the transcript (resume.ts:144 takes the messages path after an empty log) | `subscribe(afterSeq)` across CLI restarts needs a persistence-form decision (§9.2); rewrite 01/02/04 wording |

## 3. Design rules that must be pinned (R class: unpinned, they become bugs)

**R-01 Subscription epoch + three-branch duplicate frames + resubscribe discipline** (round-1 A1, independently
confirmed by four scans). TopicFrame has no field to tell old and new subscription frames apart; 09§4 apply
has only two branches, so each late old frame triggers a resubscribe -> storm. The old architecture was forced
into manual generations: `bridgeSessionId`+`bridgeGeneration`+`recoveryId` (manager:888 drops cross-generation
frames), request-level single-flight (transport:839 "requests hitting the suspect window together must share
one recovery"), and the mirror runId cursor residue bug (taskStreamEventHandlers.ts:705 "treats the new run's
seq=1 as an old message and drops it, mobile misses a permission request"). Pin four rules:
1. the subscribe response assigns an epoch, frames carry it, the client drops old-epoch frames;
2. apply has three branches: a late/duplicate frame with `toSeq <= store.seq` is **silently dropped**; apply
   only when `fromSeq === store.seq`; resubscribe only when `fromSeq > store.seq`;
3. resubscribe is single-flight (no duplicate while in progress);
4. a server resubscribe of the same (client, topic) replaces the old subscription and clears its flush buffer.

**R-02 rpc layer catch-up list (for M1).** Phase 2 rpc work is at least five items: receiver dedup by msgId;
a server protocol-session registry + reconnect-token handshake (otherwise replaceSocket is only the client
half); an explicit ACK send cadence; corrected death-detection granularity; plus the already-listed
congestion signal and bounded replay buffer. First productionization must be paired with E-01 chaos
regression; "peer dedup" is not a capability to assume before it is implemented.

**R-03 Snapshot must be generated atomically from the in-memory projection** (P2-2, the largest single root
cause found). Today the snapshot is generated from persisted state and cannot catch up with the in-memory
stream (zcodeSessionEventOrder.ts:93 "a running snapshot's eventSeq only says control state caught up to
here, not that streaming body is written to the snapshot"), so the client grew a [0,50,100,200] ms polling
catch-up, half-snapshot compensation and per-field recovery patches for seven ephemeral fields
(taskSnapshotRuntimeStateSync.ts). v4's "snapshot = full projection at seq=W" must be implemented as an
**atomic read of in-memory reducer state** (including the half-finished row text up to W and all A-region
fields), and `snapshot(W) + replay(W, now] ≡ full replay` is the first Phase 1 golden test; otherwise the
09§7 walkthrough does not hold and "wholesale replacement" amplifies today's "swallowed first body segment"
bug into "swallowed any segment".

**R-04 Determinism of seq / rowId / revision** (round-1 A5, strongly confirmed by the CLI scan).
- seq: a persistent event-log property, stable across restarts, independent of deliveryKind (profile
  differences by interval accounting, not renumbering); replay uses a `getEventsAfter` index (today an
  O(full history) rescan).
- rowId: a deterministic pure function of the event log (unchanged after replay rebuild), including 07's
  fallback rows; otherwise "live id differs from recovered id" returns as a rowId
  guise and client-persisted targetRowId / fetched ranges are all invalidated.
- revision: derived by the reducer from events (suggest revision = eventSeq or an explicit progression table);
  abolish the 15+ manual `stateRevision++` sites (server-operations.ts:1207 etc.); the memory-only
  revision-resets-on-restart problem disappears with it.

**R-05 No live-only event bypass** (P5-2). The subagent mirror is a `sequenceNumber=0` side stream outside the
parent event log, so seq has to be invented. Pin: any fact that produces a row/delta enters the event log
first; otherwise 09's subagent row `summaryText` streaming and `(fromSeq,toSeq]` accounting are empty words.

**R-06 `rows/range` becomes rowId cursor paging + merge rules** (round-1 A2). After suffix truncation plus new
appends an index is reused, so merging by index with a lagging subscription stream gives transient duplicates
or misplacement. Use `beforeRowId + count`; the client merges by rowId as the sort key; a patch hitting an
unloaded rowId is a no-op; state the relation between `atSeq` and `store.seq` (monotonic rowId + final
truncate delta closure may skip seq gating, but the argument must be written).

**R-07 Complete the optimistic-closure anchors** (round-1 A4, strongly confirmed by two scans).
- `QueueItem` must carry `sourceCommandId`: when running, a sendText's authoritative result is a queue update
  rather than a row; without the anchor the current 15 s fuzzy dedup applies (taskStreamEventHandlers.ts:148:
  content + attachment + time difference <= 15 s + id prefix heuristic).
- `timelineMarker` rows also carry `sourceCommandId`: commands like compact that produce no userInput row are
  reconciled by a **1 s clock tolerance** today.
- The authoritative userInput row `text` must be the user's original: today a /goal mirror body returns the
  persisted objective and erases `/goal` from the bubble.
- Optimistic greyed-out / pending-confirm state of `resolveInteraction` goes into 03's overlay discipline:
  idempotency only guarantees correctness; with second-level RTT and no optimistic feedback users click twice.

**R-08 Separate connectionId and clientId** (round-1 A3). clientId is stored in localStorage today
(main.tsx:851, with an iOS private-mode fingerprint fallback), so two tabs share a clientId across two
connections. Route by per-connection connectionId; use clientId for idempotency and ownership.

**R-09 ACK enum gains `noop`** (or `rejected+code=alreadyResolved` with the existing result) (round-1 A6). The
late party of "both ends stop at once" / "both ends answer a permission" has a **different commandId**, so by
definition it is not `duplicate`; rewrite the mapping in 03's conflict table and 09§5 "late party receives duplicate".

**R-10 Unified tool-output terminal truncation across all profiles** (round-1 A7). 05's convergence golden test
requires "byte-identical terminal state", but 05/09§14 give two terminal forms (continuous 256 KB,
replayable head+tail 32 KB), so literally the test is red. Pin: the truncation of the completion
`row.upserted` is identical for every profile; `outputStreamCapBytes` applies only to streaming-phase deltas.

**R-11 Priority only between topics; within a topic strictly serial by seq** (round-1 A8). Read as "A-region
frames may overtake rows frames inside one conversation topic", 01's "control messages > sessionControl >
rows" breaks interval continuity. If sessionControl means the sessions-index topic, rename to disambiguate.

**R-12 Single-frame byte limit and oversize split rule** (P4-5). Precedent: "one mirror batch too large ->
RPC/base64/JSON copies several times -> host heap exhausted" (taskRealtimeBus.ts:497, then :622 forced
splitting of oversized text ops). The 09§1 frame envelope must declare a max frame size and split semantics,
or the same OOM recurs in the new channel layer.

**R-13 Connection health is client-local UI state; never mixed into sessionControl** (P4-8). Today
connection, pairing and session state live in one state machine and contaminate each other ("relay
occasionally reports the heartbeat ACK of a paired session as waiting -> the two ends tear", transport:365).
reconnecting/degraded display belongs to the client; session facts come only from the projection.

**R-14 Keep-or-delete ruling for the CLI stdio batching layer** (P5-11, for M2). 05 makes the host channel
layer (1) the only merge point, but the CLI->host stdio port already has a deterministic batching layer.
Choose one and write it into 05: delete (strictly one merge point) or keep (declared a stdio noise-reduction
layer transparent to interval accounting). Also state the upside in 05: interval accounting removes the
"frame boundaries must be reproducible" constraint, so the batching window may use wall clock (today the
deterministic byte budget exists only because there is no interval accounting).

**R-15 Three semantic groups move into the CLI reducer responsibility list + golden tests**
(P1-5/P1-8/P5-3/P5-7). These rules **only move, they do not vanish**, so they are easy to miss:
1. late terminal closure (task_complete / tool completion / verifier terminal arriving after stop; the whole
   `lateTerminalEventsAfterStopDoNotRevive` set);
2. provider out-of-order shaping (helpers:228: the provider sometimes sends tool_use first and then the tail
   of the same sentence, shown as "greedy / Toolcall / snake game"; helpers:431 late thought/tool packets);
3. guard input and projection from the same source in the same transaction (today busy facts are scattered
   over two layers/four places plus an implicit "release the lock before broadcast" order contract,
   server-operations.ts:1909).
Also: provider replay content dedup after compact (today renderUnits:389 does a toolId set difference +
startsWith text trimming in the UI) must also converge in the reducer; rows must not show duplicate activity.

**R-16 The workspace component of sessionKey must be the workspaceIdentity key, not a bare path** (P3-7).
Precedent: "different SSH/WSL/Docker windows on the same path read each other's task config, queue and error
state". 06's `sessionKey = workspace + sessionId` and the split-pane
phase-2 `Map<workspaceKey, Connection>` are both keyed by identity.

**R-17 The CLI defines staging semantics of the model-switch marker** (P3-5). Product semantics: after a model
switch the marker is staged until sending, and lands in the timeline only when the next turn starts; today it
is a UI side list plus a turnIndex mounting patch. Write it into the 09§3 marker definition as CLI-implemented,
otherwise it revives as a UI branch during implementation.

**R-18 Scroll anchor by rowId + content backfill after snapshot replacement (upgraded from suggestion to
required)** (round-1 C2). Scroll memory stores `scrollTop` pixels today (chatSessionScrollMemory.ts), which
fails under virtual scrolling with dynamic row heights. The client records an anchor rowId, backfills the
visible range via `rows/range` after the snapshot replaces everything, and sticks to the tail if the anchor
no longer exists. Write into 04/06.

## 4. Design gaps (G class: chapters/fields to add)

**G-01 The A region lacks a sessionConfig area** (highest priority among new findings; two scans converged).
The **current values** of provider/model/thought/followupMode are must-show UI state and
`switchModelConfig`/`setFollowupMode` commands exist, but the 09 snapshot lacks this area. The patch clusters
paid for it are large: workspaceSlice is nearly all config multi-source race repair (:61 thought briefly
empty, :720 requestId guarding old replies overwriting a new choice, :1105 exception chain for ignoring config
updates while running), echo-matching guards from taskStreamEventHandlers.ts:1413, 15+ stale-model guards in
useTaskRestore.ts. Without a config area (replaced wholesale in revision order), these races replay in the
new UI.

**G-02 Snapshot recovery semantics for usage / contextWindow / tokenUsage.** Existing patches: "repeated
usage_update wakes React for nothing, dropping frames"; "a window refresh must not rebuild the
usage object or it overwrites a positive used with 0"; cross-client duplicate accounting by a
128-entry eventKey ring. 09§13 says only "keep as is" for usage/*, but the evidence shows it needs
topicization (conflated latest state) or a place in the A region.

**G-03 backgroundWorks[] and cancelBackgroundWork.** The snapshot has only a `hasBackgroundWork` boolean; the
background drawer needs each item's state and a cancel entry (once inferred wrongly from chat tool
startedAt, then changed so the runtime reports explicitly, handlers:1645). product-protocol has
`backgroundWorks[]`; 09 needs a home plus a command.

**G-04 Projection homes for plan/todo, goalStats/goalVerifications summary, apiRetry hint.**
taskSnapshotRuntimeStateSync.ts wrote a recovery patch for each of seven side-channel fields (plan "used to
live only in ChatView component memory and was lost on switching away" handlers:1200; without apiRetry
recovery "the user can only wait blindly"). Outside the projection (A region or a separate topic), the
recovery patches are rewritten elsewhere.

**G-05 Timestamps, authoritative worked time, turn-level metadata, perTurn file summary** (round-1 B2, three
evidence paths converge). 09 has no wall-clock timestamps in the whole schema; the "worked N seconds"
semantics are computed on the client with dense patches: permission wait wrongly counted,
elapsed time must be frozen before entering the verifier, duration picks the best of three sources and
may not shrink. perTurnSummaries/perTurnFileChanges (per-turn file change summary) are published in
separate frames, causing height jumps. Needed: RowBase.createdAt (server clock), CLI-supplied
authoritative worked-time intervals (stating which waits are excluded), turnsMeta or a turn-header marker row
(including fold-group ownership; auto compact attaches to the previous assistant's "worked" block, which 09's
turnId adjacency cannot express), turn-level summaries applied atomically in the same frame as rows.

**G-06 mailbox / session-message messages have no row home** (P1-8). Today XML attributes are parsed by regex
and text prefixes sniffed (background-agent ACK matches **three generations of wording**,
zcodeChatMessages.ts:219-252). 09's userInput.origin enum has no mailbox slot, so migration would keep
text-sniffing.

**G-07 Command-set gaps** (round-1 B1 extended). `retry` (RowActions.canRetry has a field but no command),
`resumeGoal` (stopPausesActiveGoalTarget requires explicit resume), how autoDrain resume / held queue drain
works, relation of rewind-to-checkpoint and editUserQuery, the attachment upload channel (how AttachmentRef
bytes go up under web/remote control), ownership domain of session delete/rename and **cleanup on delete**
(today: deleting does not clear the composer-draft localStorage bucket, taskSlice:1924; deleting the viewed
task leaves activeTaskId dangling, :2001; v4 must define that when another end deletes, the pane returns to
the empty state and sessionKey-local state is GC'd).

**G-08 Terminal failure classification and "when to give up reconnecting"** (P3-8). Several recovery paths
each declare a terminal state today, causing "two contradictory error pages". 09§12 backoff
capped at 30 s is literally infinite retry; need classes for auth invalid / kicked / over-threshold, their UI
and the give-up condition.

**G-09 Feasibility of changing the relay hub (precondition to confirm).** 01 requires "relay stays a dumb
pipe", but today's external relay is a **stateful protocol**: register/auth_challenge/pair/KICKED,
query.mid-based sharding edge behavior, idle reclaim needing traffic evasion. If the
relay is an unmodifiable external service, 05's "delete pair_status, end-to-end PersistentProtocol" needs a
transition design that coexists with the current relay; ownership of the pairing lifecycle must be explicit.

**G-10 Process semantics when host/owner crashes.** 01 shrinks the owner to "which process starts the CLI",
but does not say: whether the CLI child dies with the host, who restarts it, how a running turn is closed (a
`stream_mirror_owner_lost` broadcast invalidation flow exists, taskRealtimeBus.ts:195). Also `session/send`
today "ACKs input immediately, persistUserPrompt happens inside the background turn";
per the §9.3 ruling: `accepted` does not promise cross-process survival, the client pending closes on the
authoritative row (sourceCommandId), and the crash window is covered by `commands/query = unknown` -> the
user decides to resend.

**G-11 UI degraded form when the host is unreachable.** After the home-only stub mode (about 20 hand-written
stub services, main.tsx:923) is converged away, define what the new client shows for a disconnected remote workspace.

**G-12 Fault catalog.** The **protocol-level enums** that product-protocol repeatedly defers to a "fault
catalog" (code set of `lastError`, mapping of provider errors to `phase=error`, recoverability classes) do not
exist and are a hard prerequisite of the Phase 1 reducer. Erratum (2026-07-05): the raw material is not from
scratch; [`docs/testing/conversation-session-environment-fault-catalog.md`](../testing/conversation-session-environment-fault-catalog.md)
already lists environment faults (429/503/offline/disk full/process shutdown) and verification design; what
is missing is turning it into the protocol enum table of `fault.*` reasonCode / `SessionErrorInfo.code`. The
same document is the fault-injection list source for the E-01 chaos rig.

**G-13 Security surface.** Only 01 has the word "auth" among the 10 docs. Connection auth, relay link
confidentiality (TLS-at-relay or end-to-end), clientId forgery, authorization granularity of answering
permissions remotely (08 lists it as a product question). Even if the conclusion is "keep as is" it should be written down.

**G-14 Tiered timeouts.** 09§11 uses a flat 10 s query timeout; there is already a counterexample
("Docker/SSH first connect can exceed the default 10 s", main.tsx:1609). Workspace deployment-type operations
need their own timeout tier.

## 5. Confirmation points (C class)

| #    | Question                                                                                                                                | Suggested stance                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Multi-client action authority: can any client stop / answer permissions? (08 lists it) **Ruled: yes, fully peer**                       | Yes, idempotent closure; plus the authorization-granularity note of G-13                                                  |
| C-02 | Idempotency table retains 7 d, client localStorage pending has no TTL: an expired command is blindly resent as a ghost message          | Give client pending a TTL (e.g. 24 h); after expiry turn into "not delivered, resend?" as a user decision                |
| C-03 | ~~inbox restart replay semantics~~ dissolved (§9.3 ruling: inbox in memory, never replayed, in-flight commands reconciled by the client then user decides) | -                                                                                                                         |
| C-04 | "draft" is ambiguous: server phase=draft (createSession without firstInput) vs client null pane. **Ruled 2026-07-05: keep draft, createSession.firstInput optional, draft memory-only** | (originally suggested firstInput mandatory and removing the draft enum value; overturned)                                 |
| C-05 | 04 `base={revision, seq}` vs 09 `base={seq}`                                                                                            | Unify to {seq} (revision is redundant once R-04 binds it to seq)                                                          |
| C-06 | Phase 2 stop-gap scope for the old UI: old events lack the five-piece declaration, is the batching gain realized; actual Phase 2 workload with M1 | State that Phase 2 promises only frame-level convergence (single-entry reconnect / death-detection replay / binary), batching moves to Phase 3; or state the cost of writing a one-off coalesce declaration for old events |
| C-07 | Missing **behavior-change list** from current to target: e.g. fork-while-running is flatly forbidden today vs target allows stable-history fork; steer converges into the sendText route | Add a "semantic change table" to 08 so it is not reported as a regression during gray release                            |
| C-08 | 06 cites `packages/stream-animate` as the streaming markdown home, but that package is a demo app (App.tsx/main.tsx/server)             | Confirm it can be extracted as a library, or cite its internal implementation path                                       |

## 6. Performance and experience (P class)

- **P-01 The real frame-drop battlefield: streaming row dynamic height + follow-bottom.** 06 claims
  incremental markdown parsing, but `@tanstack/react-virtual` measure/remeasure and scroll anchoring for a row
  that grows every 30 ms is an equal hotspot. Spike before Phase 3; acceptance adds "streaming growth does not
  trigger a whole-list remeasure, follow-bottom does not jitter".
- **P-02 Snapshot storm coalescing.** When many clients degrade at once, the channel layer may coalesce
  concurrent resync on a topic (soft-state cache of the latest snapshot, second-level TTL); align with 01's
  "host does not cache" in D-04.
- **P-03 Compression, per-segment confirmation** (corrects round-1 C4). The desktop<->relay segment negotiates
  permessage-deflate (transport:210; browser side can only passively confirm extensions); confirm the
  phone<->relay segment and every v4 segment, re-measure the gain after going binary, and **do not lose this
  existing optimization** in the rewrite.
- **P-04 Overlay position follows inputRouting.** When the client knows `inputRouting=enqueue`, optimistic
  display draws directly into the queue panel, so the message does not "jump" from the timeline tail into the
  queue on closure.
- **P-05 Conflation is a frame-drop guard, not only bandwidth saving.** Direct case: "usage_update with the
  same value arriving repeatedly -> pointless React wake -> frame drop"; keep "value unchanged
  is not sent" when A-region conflation lands.

## 7. Doc consistency revisions (D class)

- D-01 02 vs 09: delta operations "three kinds / {rowId} single-row delete" vs "five kinds / fromRowId
  truncation"; 09 wins, write back to 02.
- D-02 product-protocol's `ConversationProductProjection` (turns/activeWorks/backgroundWorks/generatedAt/
  projectionVersion, command envelope clientMode) and 09's `ConversationSnapshot` need a mapping table or a
  narrowed write-back; `stopTargetKind` lacks `turnSteer` on both sides; list which of eventSeq/stateRevision/
  activeTurnKind/pendingRequestIds that today's protocol snapshot.runtime already carries stay in 09.
- D-03 The projection form of the turn-steer intermediate states (submitting/queued) is undefined; today it is
  a visible queue-panel state (turn_steer_queued/status reconcile state machine, handlers:297), so QueueItem
  must be able to express it.
- D-04 01 "connection layer must not cache messages" vs product-protocol "host may cache latest projection":
  unify as "the channel layer may hold a soft-state snapshot cache but must not hold state the downstream lacks".
- D-05 Ownership list for types 09 references but does not define: QueueItem, GoalState, SessionErrorInfo,
  SessionActionAvailability, AttachmentRef, TimelineMarkerPayload, PermissionRequest/UserInputRequest.
- D-06 Revise per §2.2 M1-M7: README foundation table, root-cause 2 wording, 03 queue description, 05
  PersistentProtocol status and the "delete the parallel reliability layer" section, 02's queue dependency
  order, 01's web-form count.

## 8. Supporting work (E class)

- **E-01 Deterministic network chaos rig as first-class acceptance** (upgraded from "strongly recommended" to
  "required" by M1): frame-level injection of delay/loss/reorder/duplicate/mid-flight kill (reproducible by
  seed); assert invariants: no duplicate rows, overlay always closes, terminal convergence, bounded
  resubscribe count, `snapshot(W)+replay ≡ full replay`. It replaces the manual criterion of the Phase 2
  acceptance "mobile remote disconnect/refresh recovery works".
- **E-02 New-pipeline metrics:** coalesce compression ratio, flush frame rate, per-subscription buffer
  watermark/overflow count, snapshot resync count and reason, ACK latency distribution, reconnect count and
  reason class (hooked to RUM).
- **E-03 Golden test list (derived from the cases):**
  1. snapshot atomicity: a snapshot at any W during running + continued stream ≡ full replay (R-03);
  2. late terminal does not revive: assistant/tool/verifier terminals arriving after stop (all P1-5/P5-7 cases scenarized);
  3. provider out-of-order shaping: tool_use before the body tail, late thought packet (helpers:228/431 cases);
  4. profile convergence: the same event sequence gives the same terminal state in both profiles (depends on R-10);
  5. a filtered event must be closed by an unfilterable event (listed in 05; add the subagent summaryText scenario);
  6. duplicate/late frames silently dropped, resubscribe replaces the old subscription (R-01);
  7. guard and projection from the same source: no "broadcast before state release" window (P5-3);
  8. formal-proof full enumeration ↔ actionAvailability consistent (listed in 02, kept).

## 9. Persistence and table-structure impact (against the actual schema: migrations 0001-0014)

Conclusion first: after the §9.3 author ruling (queue not persisted), **SQL structural changes converge to
zero migrations**; only additive JSON anchor fields on message/part remain, fully compatible with 07's
"additive JSON first" principle and the current schema (message/part = index columns + `data` JSON blob, 0014
already has the `sequence` column and three supporting indexes). The real big item is not DDL but a
**semantic decision** 07 does not cover: the persistence form of the event log (§9.2).

### 9.1 Facts (DDL verified)

- Existing tables: `session` / `message` / `part` / `todo` / `session_entry` / `permission` / `input_history` /
  local_setting (0002) / workflow series (0007-0008) / usage series (0010).
- `message.sequence` / `part.sequence` + indexes such as `message(session_id, sequence, ...)` were built by
  0014: the stable ordering foundation for cold rows rebuild holds.
- `message.time_created` / `part.time_created` exist: the wall-clock timestamps G-05 needs have a persistent
  source; what is missing is putting them into the projection schema.
- Tool artifacts already have file storage `NodeToolArtifactStore` (rootDir file store): 09§6 `truncated.ref`
  + `toolOutput/get(ref, byteRange)` has a ready home, no new SQL table.
- The `todo` table is already persistent: G-04's plan/todo root cause is "stored only in component
  memory / not in the projection", not a missing table.

### 9.2 Decision point: persistence form of the event log (M8, the largest gap 07 does not cover)

The event log is memory-only today (M8) while 01/04/README assume SQLite. Two options:

|                                        | Plan A: event log on disk                                                                                                                                   | Plan B: bounded in-memory log + logEpoch (**recommended; ruled 2026-07-05**)                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How                                    | New table `session_event(session_id, seq, type, data, time_created)`, PK `(session_id, seq)`; thousands of deltas per turn in batched transactions; retention trimming task | Event log stays an in-memory ring buffer (N per session); seq scope = `(session, logEpoch)`, logEpoch renewed at each CLI process start; `subscribe(base)` carries logEpoch, mismatch -> snapshot directly |
| afterSeq resume across CLI restart     | supported                                                                                                                                                   | not supported: after a restart all clients take one snapshot                                                                                                                                              |
| Cost                                   | clear write amplification (all streaming deltas into SQLite); trimming task; index `getEventsAfter`                                                          | one extra snapshot after a CLI restart (it would happen anyway: the running turn dies with the process, clients must realign); rewrite 01/02/04 wording                                                    |
| Requirement on the transcript          | anchors may be incomplete (events as backstop)                                                                                                              | **transcript anchors must be complete**: projection must be deterministically rebuildable from the transcript alone; the golden test `reduce(transcript) ≡ reduce(events)` rises from suggestion to a persistence acceptance |

Why B: A's only gain is "one fewer snapshot after a CLI restart"; events are low frequency and a snapshot
(one tail screen) is cheap, while A costs thousands of rows of write amplification per turn and a new trimming
operations surface; B also forces complete transcript anchors, which correct display of history sessions
requires anyway. B's logEpoch and R-01's subscription epoch are two layers (process generation vs subscription
generation); they may be encoded together but their semantics must be written apart.

### 9.3 Table-level changes (revised per the author ruling: queue not persisted)

> Ruling (2026-07-04): the user query queue (deferred sendText/sendGoalCommand) is **not persisted**: it lives
> only in CLI memory and is lost when the CLI process dies. 03's "Inbox persisted" section and 07's new-table
> list are to be rewritten accordingly (03 attributes "message sent but not shown" to the queue not being
> persistent; the attribution is corrected to "queue ownership lives in renderer memory").

**Inference: the two inbox tables are not built either; persistence changes converge to zero migrations.**

| Object                                | Change                                                                                                                                                                                                                                                                                                 | Mode                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `message.data` (JSON)                 | + `turnId` (listed in 07), `origin` unified enum including a mailbox slot (07 + G-06), **`sourceCommandId` (missing in 07; the closure anchor of R-07 and the basis of crash-window idempotency; must be persisted)**, terminal marker (interrupted/failed, if not derivable from parts), user original and parsed result of commands like `/goal` in separate fields (R-07) | no migration, additive JSON    |
| `part.data` (JSON)                    | + authoritative worked-time interval anchors (start/end excluding permission wait, G-05), output truncation metadata (`truncated: {totalBytes, ref}`, ref pointing to the existing artifact store)                                                                                                        | no migration, additive JSON    |
| ~~`command_inbox`~~                   | **Not built.** inbox = CLI in-memory acceptance ledger (serialization point + idempotency table + result cache + pendingCommands data source), process lifetime                                                                                                                                       | -                              |
| ~~`continuation_inbox`~~              | **Not built.** Background bash/subagent do not survive a CLI restart; their undelivered result notifications go by the same ruler as the queue: lost with the process (side effects like file changes are on disk anyway). Revisit if background work ever needs cross-restart recovery                | -                              |
| ~~`session.queue_auto_drain`~~        | Not needed. With the in-memory queue, held/autoDrain state is in memory too                                                                                                                                                                                                                            | -                              |
| `session_event`                       | Needed only by §9.2 plan A; with plan B (recommended) also zero tables                                                                                                                                                                                                                                 | per §9.2 decision              |
| `message.turn_id` standalone column   | Stays "not now" (listed as optional in 07)                                                                                                                                                                                                                                                             | not now                        |
| `todo` / `usage` / `input_history` / 0014 indexes | untouched                                                                                                                                                                                                                                                                                  | -                              |

Companion semantics (must be pinned together, otherwise correctness is lost, not just persistence):

1. **The essence of fixing "message sent but not shown" is moving ownership up, not persisting.** The queue
   moves from renderer memory into CLI memory + authoritative echo (state.updated), after which refresh /
   disconnect / multi-client are all correct; persistence only affects the window "CLI process dies", in
   which the running turn dies too, so the user perceives a session interruption and the queue vanishing with
   it is a consistent product semantic.
2. **Crash-window idempotency is carried by "effects carry the commandId".** `commands/query` lookup order =
   in-memory idempotency table -> transcript by `sourceCommandId`. Commands with persisted effects (sendText
   startNow, editUserQuery, compact marker) are naturally deduplicated; commands without effects (stop,
   resolveInteraction) are harmless to resend. The one small hole is duplicate creation by fork/createSession:
   **ruled (2026-07-05): the child session records `source_command_id`** (one column or metadata, additive,
   no migration).
3. **ACK `accepted` does not promise cross-process survival.** Client pending finally closes on arrival of
   authoritative data (row / QueueItem `sourceCommandId`), which is 02's original principle "overlay closure
   does not depend on ACK"; after a CLI restart an in-flight command query returns `unknown` -> per C-02
   shown as "not delivered, resend?". C-03 (which commands to replay on restart) dissolves: **never replay**.
4. **pendingInteractions are not persisted** (unchanged): derived from running-turn memory facts; the dialog
   vanishing when the turn dies is the right semantics.

Net result: CLI SQLite gets **zero new tables, zero migrations**; the only change is additive JSON anchor
fields on message/part, matching 07's "touch persistence as little as possible" and 01's self-similar
recovery (the only state that must not be lost = transcript). R-07's `QueueItem.sourceCommandId` is
unaffected: it is a protocol/memory field, not a storage field.

### 9.4 Client-side persistence (non-SQLite, same list)

- localStorage: `clientId` (after R-08 only as submitter identity), draft (per sessionKey), in-flight
  commandId list + TTL (C-02), scroll anchor rowId (R-18, replacing today's scrollTop pixels), pane layout (06).
- IndexedDB: `(projection, revision, seq[, logEpoch])` atomic snapshot cache, later optimization (listed in
  04; under plan B it must carry logEpoch to decide whether the cached base is usable).
- Old data: historical messages whose turnId cannot be backfilled stay empty, fallback rows are generated at
  runtime by the compatibility layer and not written back (07); if "unread" is recorded by seq today, under
  plan B switch to `time_updated`.

## Appendix: five-area case table (60 classes)

> Verdicts: **eliminated** = structurally eliminated (design basis given); **pin** = right direction but needs
> a §3 rule; **gap** = design does not cover it (§4); **returns** = would return in a new guise. Code
> locations of the evidence are in the full history.

### A. Renderer assembly layer (P1)

- P1-1: stream/snapshot dual-source merge heuristics (richness scoring, sliding-window overlay, prefix comparison) -> eliminated (04 wholesale replacement) + prerequisite R-03
- P1-2: streaming container split errors, stitching an old tail (three-level turnId/inputId/traceId guess) -> eliminated (09§3 state machine + new rowId per turn)
- P1-3: timeline misplacement/duplication/anchor drift (1 s clock tolerance matching, 4 identity keys cross-recognized) -> eliminated (marker = ordinary row) + pin R-04 (rowId)
- P1-4: optimistic merged instead of overwritten (operationId backfill, local row takeover) -> eliminated (03 discipline) + pin R-07 (marker anchor)
- P1-5: late terminals vs content stream disorder (task_complete before a late packet, Write preview merged back after stop) -> eliminated (client side) + pin R-15 (reducer closure)
- P1-6: UI guesses turn grouping (`turnIndex ?? Math.floor(index/2)`) -> eliminated (07 turnId persisted)
- P1-7: control flags inferred from the message array (canFork backfill, goal-continuation running-state recognition) -> eliminated (02 sessionControl/actions)
- P1-8: provider semantic text sniffing (three-generation wording match, stopReason regex, mailbox XML regex) -> partly eliminated + gap G-06 (mailbox)
- P1-9: snapshot watermark is not a consistency watermark -> pin R-03
- P1-10: client out-of-order cache compensation (gap detection / pending cache / 10k dedup table) -> eliminated (04 rule 2) + prerequisite R-01
- P1-11: worked-time local estimation and best-of-two sources (permission wait miscounted, freeze before verifier, never shorten) -> gap G-05
- P1-12: compact ownership / fold-bridge heuristics + replay content dedup (toolId set difference + startsWith trimming) -> a) pin R-15; b) gap G-05 (fold group)

### B. Stream event application and snapshot sync (P2)

- P2-1: snapshot merge-strategy zoo (replace/terminal_reconcile/backfill/preserve/drop) -> eliminated (04 rule 1, v4's strongest positive evidence)
- P2-2: running snapshot non-atomic (polling to catch the watermark, partial snapshot, seven fields each recovered) -> pin R-03
- P2-3: late-terminal ownership race (four shouldTreat* booleans, terminals without inputId) -> eliminated (turn.* events vanish, phase follows the projection)
- P2-4: client seq-gap compensation machine (250 ms recovery timer, trimChunkOverlap prefix/suffix dedup, unverifiedFromSeq cursor) -> eliminated + prerequisite R-01
- P2-5: deliveryKind client behavior forks (gap recovery fork, replayable-only consumption, isFilteredNonOwnerBatch) -> eliminated (05 parameter table + interval accounting)
- P2-6: blocking interaction events lost/overwritten/out of sync across clients -> eliminated (09§5 pendingInteractions)
- P2-7: flag-array inference (isChatTaskRunning guess, SSH residual pending execute special case) -> eliminated; shimmer derivable from phase + tail row
- P2-8: queue drain/held/steer orchestration on the client (local drain trigger after terminal, stopRequested locally rewriting held) -> eliminated + D-03 (steer intermediate-state expression)
- P2-9: optimistic user message 15 s window fuzzy dedup, /goal original overwritten by objective -> eliminated + pin R-07
- P2-10: model/config echo races (echo-matching guard, three-layer thought preserve, 15+ stale guards) -> gap G-01 (most important finding of this area)
- P2-11: subscription/component lifecycle gap loses data (release before subscribing, plan only in component memory) -> eliminated (client is no longer a reducer)
- P2-12: side-channel projection field recovery patch cluster (plan/todo/goalStats/apiRetry/contextUsage/background bash) -> gap G-02/03/04

### C. Store and web entry (P3)

- P3-1: dual-truth reconciliation (verifier double write, comparing client clock to server time, unread double source) -> eliminated + gap G-01/02 (fields must enter the projection)
- P3-2: duplicate delivery hand-written idempotency tables (usage repeated wake drops frames, eventKey ring, requestId object dedup) -> eliminated (msgId dedup + interval accounting + conflation)
- P3-3: residual running-state flag misjudgment (inputId residue, activeTurnKind not cleared, stop route wiped) -> eliminated (control replaced wholesale)
- P3-4: single-slot pending interaction overwrite, dual-path cleanup CPU spike -> eliminated + pin R-07 (optimistic greyed-out)
- P3-5: model-switch marker side staging + turnIndex mounting -> pin R-17
- P3-6: related data published in separate frames, height jumps (messages/summary/fileChanges three writes) -> eliminated + gap G-05 (perTurn summary home)
- P3-7: workspace identity crosstalk (path fallback reads each other's config/queue/error state) -> pin R-16
- P3-8: recovery paths with conflicting terminal states (unknown->invalid-mobile two error pages, DEVICE_OFFLINE racing ahead) -> eliminated + gap G-08 (terminal classification)
- P3-9: whole-tree remount on bridge swap (key=bridgeSessionId, "loading" flash on foreground) -> eliminated (subscription identity persistent)
- P3-10: half-open connection send black hole (silent drop, one-way path rebuild retry) -> eliminated (05 death detection + pipe replay)
- P3-11: reconnect cascade storm (10 entries, hand-written single-flight, 4 generation comparisons) -> eliminated + prerequisite R-01
- P3-12: client identity localStorage singleton (same id across tabs, private-mode fallback) -> pin R-08

### D. Transport and remote control (P4)

- P4-1: seq-gap -> degraded -> whole-bridge hard recovery (non-idempotent frames dare not be replayed) -> eliminated + prerequisite R-02 (receiver dedup really exists)
- P4-2: middle-layer per-client buffer + TTL/overflow/degraded patching -> eliminated (no per-client queue)
- P4-3: owner/observer dual event sources forking (forced back into one stream) -> eliminated (peer clients; strongest endorsement of the direction)
- P4-4: owner lease / command routing race (NO_ACTIVE_TASK_OWNER, owner_lost broadcast) -> eliminated + gap G-10 (crash takeover)
- P4-5: large-frame OOM (mirror batch copied repeatedly filling the heap, forced splitting into seqs) -> eliminated + pin R-12 (frame limit)
- P4-6: multi-path heartbeat/death-detection/reconnect cascade (5-6 transport entries + 3 s grace) -> eliminated + gap G-09 (relay feasibility)
- P4-7: half-open / sleep false-alive (kernel does not fire close, waiting_terminal stuck) -> eliminated (application-layer ACK death detection; argument and cases match)
- P4-8: transport-state-to-UI-state tearing (staleWaiting suspect state, debounce holding active) -> eliminated + pin R-13
- P4-9: PersistentProtocol lacks receiver dedup / server attach / proactive ACK -> **returns** (without the fix the A1 storm is certain) -> R-02
- P4-10: PersistentProtocol has zero production deployment -> misstatement correction M1
- P4-11: multi-path duplicate delivery, tail eventId backstop (thousand-entry ring, cross-channel forced flush for order) -> eliminated + pin R-01 (three branches)
- P4-12: base64 double encoding / hand-written chunking (0x8000 chunks to avoid stack overflow) -> eliminated (binary frames) + P-03 (keep deflate)

### E. CLI fact source (P5)

- P5-1: protocol seq lazily numbered in memory per (record, deliveryKind), subscribe rescans full history -> eliminated + pin R-04 (seq persisted)
- P5-2: live-only events not in the event log (subagent mirror seq=0) -> gap -> pin R-05
- P5-3: mutually exclusive facts scattered over two layers + release/broadcast order race -> eliminated + pin R-15 (guard same source)
- P5-4: turn boundary guessed by array scan (synthetic user breaks turn count, only the last turn can fork) -> eliminated + pin R-04 (fallback rowId determinism)
- P5-5: fork: running flatly forbidden now vs target allows stable history -> behavior change -> C-07 list
- P5-6: fork inheritance scope recovered item by item with patches (model overwritten by default, goal timeline broken) -> eliminated (inheritance table, golden-testable)
- P5-7: stop vs late terminal closure race (verifier not receiving abort keeps active goal, cancelled with no terminal event to settle) -> eliminated + pin R-15 (into golden tests)
- P5-8: revision manually incremented at scattered sites, memory-only, -32009 unstructured -> pin R-04 (revision derived)
- P5-9: follow-up input while running: two volatile queues (steer memory + UI deferred queue) -> eliminated + correct M3 + 08 adds migration
- P5-10: dual streaming representation dedup tax (scheduled repeats large params, cross-event dedup state machine) -> eliminated (single row.delta + closed whitelist)
- P5-11: CLI protocol boundary already has a deterministic batching layer -> pin R-14 (keep-or-delete ruling)
- P5-12: subscribe is a one-shot RPC, no subscription stream identity, no retention window -> eliminated + prerequisite R-01; with G-15 indexing

G-15: when the event retention window goes from "unbounded" to bounded, the replay path gets a
`getEventsAfter` index to avoid the O(full history) rescan.
