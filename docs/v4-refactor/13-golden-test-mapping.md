# Case Catalog to Golden Test Mapping (M0 Material)

Layers the product cases of [conversation-session-case-catalog.md](../conversation-session-case-catalog.md) by **means of proof** as the topic basis for the M2 golden test set. The product-semantic source is unchanged (still the catalog / product-protocol); only the evidence type changes: most cases sink from "must open the GUI and assert" to reducer pure-function tests of "event sequence in, projection assertion out".

## Layering criterion

| Layer | Criterion | Form |
| --- | --- | --- |
| **L1 reducer golden test** (new, the workhorse) | The case's assertion target is projection content: phase, queue, availability, rows structure, marker, inputRouting | Build an event/command sequence -> run the ProductProjection reducer -> assert the projection; no GUI, no network, millisecond-level, fully enumerable |
| **L2 protocol/transport test** | The assertion target is delivery semantics: snapshot consistency, coalesce, profile, recovery | Pure functions + simulated subscribers |
| **L3 WDIO E2E** (kept, narrowed) | The assertion target must involve real UI interaction or a cross-process chain: button click, dialog, scroll, replay network | Rebuilt at the E2E disposition pace of [11-deletion-plan](./11-deletion-plan.md), testid contract v2 |

Principle: **every catalog case has evidence in at least one layer; semantics L1 can prove do not consume L3 budget again**, and L3 only supplements "the interaction surface L1 cannot prove". When the coverage matrix is rebuilt the evidence column annotates the layer (`L1`/`L3` or both).

## Catalog group mapping

| Group | Content | Main evidence layer | Note |
| --- | --- | --- | --- |
| A First send and in-run input | three-way inputRouting (startNow/enqueue/guide), running fork | **L1** | All are "state x input -> ruling", the core of the formal-proof enumeration; L3 keeps only 1-2 composer interaction smokes |
| B Stop and queue retention | phase/queue/autoDrain after stop | **L1** | stop command -> projection assertion; L3 supplements one stop-button state |
| C Completed success state | actions available after completion | **L1** | availability assertions |
| D Edit User Query | edit rerun, row.removed truncation, editKeepsQueue | **L1** + L3 | truncation semantics L1; the edit interaction flow L3 |
| E Fork | stability judgment, child not copying queue/background, E10 merged assistant | **L1** + L3 | row-level canFork computation and child projection content L1; E10-type cross-session content completeness uses replay L3 |
| F Manual Compact | F01-F09 (including the ruled F09) | **L1** + L3 | marker state machine and queue retention L1; F09 retry-entry click L3 |
| G Auto Compact | G01-G12 (including the ruled G11/G12) | mostly **L1** | retry/circuit breaker/pendingAction destination are all runtime semantics; an L1 event sequence can build scenarios like "three consecutive failures" that L3 can hardly reproduce stably, **this group is where sinking pays most** |
| H Goal | goal state machine, verifier, queue linkage | **L1** + L3 | state machine L1; the `/goal` input flow L3 |
| I Model and thinking depth | config scope, N01-N07 crosses | **L1** | switchModelConfig CAS + config snapshot consumption (including the ruled N06) |
| J Multi-session concurrency | session isolation | **L1** + L2 | two reducer instances not affecting each other L1; subscription isolation L2 |
| K Key pruning | 9 reject rules | **L1** | All are guard assertions, covered directly by formal-proof |
| M Turn Steer | queue/guide modes, steerState | **L1** | QueueItem.steerState projection assertions |
| N Model switch crosses | N01-N07 | **L1** | same as I |
| O Tool Cross Product | each tool x compact/fork/goal | L1 + **L3** | state semantics of the cross product L1; tool UI display complexity (summary/failed state/expand) is L3's home ground |
| P Timeline position and folding | placement, fold groups | **L1** + L3 | in v4 placement is a direct product of the rows total order + turnHeader; L1 asserting rows structure suffices; fold interaction L3 |
| Q AskUserQuestion visibility | pendingInteractions lifecycle | **L1** + L3 | appear/disappear/first-come-first-served L1; dialog interaction L3 |
| R Composer draft scope | draft retention/switch | **L3** | Pure client-local state (sessionKey scope), unrelated to the projection, the only group with L3 as main evidence |
| Environment fault catalog (N/S/D/L/W/X groups) | 37 decision-needed items | layered after ruling | fault injection points are in provider/network/fs; most can be simulated as error events at the reducer layer (L1) + replay fault fixtures (L3); the X-group isolation assertion goes into L1 (see [12-fault-catalog](./12-fault-catalog.md) §3.4) |

## Structural golden tests new in v4 (not mapped from the catalog; from design-review E-03)

These prove the **protocol mechanism itself**, orthogonal to product cases, all L1/L2:

1. **snapshot atomicity**: during running, a snapshot taken at any watermark W + continuation == full replay (R-03).
2. **Late terminals do not resurrect**: assistant/tool/verifier terminals arriving after stop are rejected (scenarioization of the P1-5/P5-7 cases).
3. **provider out-of-order shaping**: tool_use before the body tail, late thought packets.
4. **profile equivalence**: the same event sequence through the continuous/replayable profiles ends byte-identical.
5. **filter closeout**: an event filtered by the profile must be closed by an unfilterable event (including subagent summaryText).
6. **Duplicate/late frames dropped silently**, resubscribe replaces the old subscription (R-01).
7. **guard and projection from the same source**: no "broadcast before state release" window (P5-3).
8. **formal-proof full enumeration == actionAvailability consistency** (already listed in 02-projection).
9. **transcript completeness**: `reduce(transcript) == reduce(events)` (persistence acceptance of option B, design-review §9.2).
10. **fault isolation**: inject any fault into session A and session B's projection is unchanged (12 §3.4).

## Suggested landing form

1. L1 tests live in the same package as the reducer (inside `apps/zcode-cli`), with **event-sequence JSON** fixtures, extractable from existing e2e replay traces or hand-written minimal sequences; each catalog case id appears in the test name for the coverage-matrix audit script to reconcile.
2. The formal-proof full enumeration runs in a separate test entry (large combination count, timed apart from per-case tests).
3. L3 is rebuilt after the M3 vertical slice (testid contract v2 ready), topics chosen from this table's L3 column rather than porting the old 52 specs wholesale.
