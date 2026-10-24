# Memory Leak Fix Plan: CLI Memory Event Store Retention Strategy

Status: **Implemented** (spec at `apps/zcode-cli/docs/design/v2/session-event-store-retention.md`; the user confirmed one-turn-lag eviction). This document is kept as the decision record. Full history: `git show 45f808f7:docs/analysis/memory-leak-fix-plan-cli-event-store.md`.

Related: audit report `docs/analysis/memory-leak-audit-2026-09-03.md`; observation capability `docs/monitoring/memory-diagnostics-log.md` (landed; the `eventRows` counter is the before/after evidence for this item).

## I. Audit Hazards Reviewed and Prioritized

| Priority | Process       | Hazard                                                                                                                                                                                  | Growth Rate                                                                          | Why Prioritized Here                                                                                                                                                                           |
| -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**    | agent CLI     | `InMemorySessionEventStore` permanently retains each `ModelStreaming` (per-token) and `ToolCallProgress` event; append also fully copies `[...events, e]`; nobody calls `deleteSession` | **One event per token**, only increases and never decreases during session residence | The only per-token growth point; hits all long sessions and all users; desktop-side legacy `session/subscribe` pins sessions without recycling, so the combination is "bigger the longer used" |
| 2        | main          | `will-download` listeners on defaultSession skip cleanup on window close                                                                                                                | +N closures per window close                                                         | One-line fix, independent MR                                                                                                                                                                   |
| 3        | main          | `TaskRealtimeBus.streamBatches` non-terminal runs not deleted, also replayed to new windows                                                                                             | +1 per interruption/disconnection (≤512KB)                                           | Few-line fix, independent MR                                                                                                                                                                   |
| 4        | renderer      | shiki `tokensCache` has no eviction; streaming Edit writes one entry per chunk                                                                                                          | +N per Edit tool output                                                              | Add LRU, independent MR                                                                                                                                                                        |
| 5        | renderer      | task snapshot memory cache unbounded                                                                                                                                                    | +1 per opened task                                                                   | Apply the existing caps from the persistence layer                                                                                                                                             |
| 6        | host          | bots per-task subscriptions released only by in-stream terminal events                                                                                                                  | +1 per remote disconnection/crash                                                    | Extract `releaseTaskWatch`                                                                                                                                                                     |
| 7        | agent CLI     | subagent child session publishers have no parent→child mapping                                                                                                                          | +1 per subagent set                                                                  | Requires parent-child mapping                                                                                                                                                                  |
| 8        | host/services | RPC disconnects do not recover pty/fs.watch; session close does not clear mirror tables                                                                                                 | +1 per disconnect / per session                                                      | Structural, requires unified boundaries                                                                                                                                                        |

Items 2–5 are small changes that can run in parallel as separate MRs; this document plans only item 1.

## II. Fix Goals and Must-Keep Contracts

The fix changes only **the retention strategy**: not interfaces, not where sequence numbers are allocated, not how live sinks consume objects. Each contract below was read from the code; if any does not hold, trimming is unsafe.

```text
                        AgentRuntime.appendEvent (core/src/runtime/methods/events.ts:101)
                                       │ eventStore.append → supply sequenceNumber
                                       │ persistDurable → sqlite messages
                                       │ notifyEventSinks (live: V4 gateway / legacy sinks)
                                       v
   ┌──────────────── InMemorySessionEventStore (adapters/src/storage/index.ts) ────────────────┐
   │ eventsBySession: Map<sessionId, SessionEvent[]>                                             │
   └──┬──────────────┬──────────────────┬──────────────────┬───────────────────┬────────────────┘
      │ getEvents    │ getEvents        │ getEvents         │ getEvents          │ getLatestSequenceNumber
      v              v                  v                   v                    v
 legacy  playback   V4 cold resume     rewind/fork/         file-changes/       assistant-feedback /
 readProtocol-      v4-bridge:1506     checkpoint          subagent child       v4-bridge:457
 SessionEvents      sourceEventSeq =   only filter         sessions only filter (+1 appending new events)
 (server-ops:715)   max(seq) ← risk    ModelComplete /      ToolCallResult /
 for ModelStreaming                    RewindTriggered /    CheckpointCreated
 batching as model.streaming           CheckpointCreated
```

| Contract                                           | Source                                                                                                                                                                                                                                                                                         | Constraint on Fix                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| seq sole source                                    | `events.ts:79-82` comments; `v4-gateway.ts:2375+ normalizeRuntimeEventSequence` drains by raw seq continuously                                                                                                                                                                                 | Transient events **must still go through stores to allocate seqs and be delivered raw to live sinks**; stores cannot be bypassed |
| `getLatestSequenceNumber()+1` generates new events | `assistant-feedback-persistence.ts:53`, `v4-bridge.ts:457`                                                                                                                                                                                                                                     | Numbers must come from an independent monotonic counter, not "the last still-resident event"                                     |
| V4 cold resume cursors                             | `v4-bridge.ts:1506-1516` uses `max(events.sequenceNumber)` as `sourceEventSeq`                                                                                                                                                                                                                 | After eviction this value shrinks → change to `getLatestSequenceNumber()`                                                        |
| Legacy protocol seq                                | `server-operations.ts:800 getProtocolEventSeq` replays all events to take lastSeq                                                                                                                                                                                                              | Read `lastSeq` directly from records (`server-types.ts:63` already has it)                                                       |
| V4 projections' streaming event dependencies       | `product-projection.ts:463` consumes `ModelStreaming` only when `isRunning()`; `cold-event-merge.ts:138` lists `ModelStreaming/ModelComplete` as TRANSCRIPT_DERIVED; completed turns are re-synthesized from persisted messages by `transcript-hydration.ts:1480 synthesizeEventsFromMessages` | **In-progress turn** transient events must be kept; transient events of **completed and persisted** turns are redundant          |
| `ModelComplete.content` carries full text          | `contracts/src/events/session.events.ts:566`                                                                                                                                                                                                                                                   | Completed turn text does not depend on deltas                                                                                    |
| Reducers/rewind/fork/checkpoints                   | `contracts/src/events/event-reducer.ts` has no `ModelStreaming/ToolCallProgress` handlers; each consumer filters only low-frequency types                                                                                                                                                      | Unaffected by truncation                                                                                                         |
| Usage statistics `firstTokenAt`                    | `usage-observability.ts:373` uses per-turn `events` arrays                                                                                                                                                                                                                                     | Unaffected                                                                                                                       |
| Legacy playback behavior change                    | `readProtocolSessionEvents` loses completed turns' `model.streaming` batching                                                                                                                                                                                                                  | Confirm `session-mapper.ts` maps `ModelComplete` with full text (first thing to check before implementation)                     |

## III. Phased Plan

### Phase 1: Zero Semantic Change (Deployable Independently)

- `append` becomes in-place `push`, removing the O(n) copy; `getEvents` keeps returning copies (callers have `[...events]` habits).
- `getLatestSequenceNumber` uses an independent monotonic counter `latestSeqBySession`.
- Call `eventStore.deleteSession(sessionId)` when session records are released: `session/close`, creation failure, idle deactivation, process exit (`bootstrap/src/zcode-protocol/server.ts` / `session-residency.ts`).
- `v4-bridge.ts:1506`'s `sourceEventSeq` and `server-operations.ts:800`'s `getProtocolEventSeq` read the counter / `lastSeq` (behavior-equivalent now; changed first as groundwork for Phase 2).
- Acceptance: all existing tests green; `eventRows` zeroes after sessions close.

### Phase 2: Turn-Window Retention (The Real Memory Fix)

- New pure module `adapters/src/storage/session-event-retention.ts`:
  - `TRANSIENT_SESSION_EVENT_TYPES = {ModelStreaming, ToolCallProgress, StreamingToolLedgerUpdated, ModelNetworkStatus}` (single source referenced by stores and docs).
  - State machine `onAppend(event) → { retain: boolean; evictTurnIds: string[] }`. Transient events are bucketed by `turnId`; when `TurnStarted(T+1)` is observed, buckets for `T` and earlier that already have `TurnComplete/TurnError` are evicted (**one-turn lag**, leaving time for sqlite persistence); on `RewindTriggered`, no bucket is evicted (rewind-period turn ownership is complex; hand off to `deleteSession`).
  - Non-transient events are retained permanently (same order of magnitude as messages; compact boundaries exist).
- `InMemorySessionEventStore` accepts `retention?: SessionEventRetentionPolicy`, default turn-window; an `unbounded` mode keeps current behavior for rollback and comparison tests.
- `getStats()` adds `evictedEvents`, `retainedTransient`, written to memory diagnostic logs as online evidence.
- The only observable behavior change: legacy `session/events` / `session/subscribe afterSeq` no longer replays token deltas for **completed turns**; the current turn and the immediately preceding completed turn remain replayable. Recorded in the spec and `docs/conversation-product-protocol.md`.

### Phase 3 (Optional)

Cap transient events per turn (prevent a single runaway turn), batching the earliest deltas into one entry when exceeded; decide after Phase 2 lands by examining `retainedTransient` distributions.

## IV. Tests

### Unit (written first)

| Test Case               | Assertions                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention state machine | Transient events are retained during their turn; `TurnStarted(T+1)` evicts `T` buckets; `T+1` buckets are retained until it ends; non-transient events are never evicted; rewind does not trigger eviction |
| Store: seq monotonic    | `getLatestSequenceNumber` does not regress after eviction; `append` returns strictly increasing seqs                                                                                                       |
| Store: read paths       | `getEvents/getEventsAfter` return non-transient ∪ window-transient, sorted by seq; `deleteSession` zeroes `getStats`                                                                                       |
| Store: performance      | 10^5 appends are linear (no return to O(n²)), using existing `ZCODE_PERF_REPRO=1`-gated writes                                                                                                             |
| Port contract tests     | `describeSessionEventStoreContract(factory)` runs both unbounded and turn-window modes, guaranteeing semantic consistency                                                                                  |

### Bootstrap integration

- Must run existing: `zcode-protocol.test.ts` (5 places with `model.streaming` playback/seq assertions), `v4-gateway*.test.ts`, `v4-cold-resume.test.ts`, `cold-event-merge.test.ts`, `transcript-hydration.test.ts`, `product-projection*.test.ts`, `session-resident-pool.test.ts`.
- New:
  1. `session/subscribe afterSeq` during an in-progress turn still replays the current turn's deltas;
  2. after two consecutive turns, playback contains only messages and low-frequency events, protocolSeq continuous without gaps;
  3. cold resume `sourceEventSeq` equals the latest seq after eviction, and gap filling is correct;
  4. raw seq out-of-order arrivals (N+1 before N) drain correctly after eviction;
  5. rewind/fork/checkpoint results are byte-identical after eviction in both modes (same scripts compared across modes).
- Known irrelevant baseline failures: `v4-gateway.test.ts` "old revision retry", `zcode-protocol.test.ts` "three types of v4 subscribe responses"; confirm their state on a clean baseline before fixing.

### Memory regression (new)

`bootstrap/tests/session-event-store-retention.perf.test.ts`: gated by `ZCODE_PERF_REPRO=1`, `--expose-gc`; run N turns × M deltas, assert `getStats().events ≤ non-transient count + 2 turns' transient count` and bounded `heapUsed` growth; output the same script in unbounded mode for comparison.

### Manual / E2E

- Connect desktop to a local CLI running a >30-minute streaming session and watch `memory_sample`'s `eventRows` in `~/.zcode/cli/log`: before the fix it rises linearly with tokens, after it recovers between turns.
- V4 panes and legacy bots subscribe simultaneously, reconnect offline via `afterSeq` playback; rewind/fork/compact then replay.
- Run `pnpm test:e2e:container:conversation` (conversation validation set covering streaming/replay semantics).

## V. Making Changes Testable

1. **Dependency injection instead of hardcoded construction**: `server-operations.ts:3493` and `:2883` call `createInMemorySessionEventStore()` directly. Add `context.deps.createSessionEventStore?(sessionId)` (`ZCodeProtocolAgentDependencies` in `server-types.ts`), default turn-window stores; tests inject spy stores or unbounded stores for A/B comparison. `create-app.ts:558` already has an `options.eventStore` interface; follow its convention.
2. **Separate policy from container**: eviction rules are an IO-free pure state machine with exhaustive branch unit tests; stores only "call the policy and maintain Maps". Future rule changes touch neither stores nor consumers.
3. **One port contract test**: `describeSessionEventStoreContract` in `adapters/tests`; delete the hand-written stand-in `core/tests/test-event-store.ts` (same O(n) copy as production) and switch core's 40 tests to real stores, removing stand-in/production drift false greens.
4. **Single-source constants**: `TRANSIENT_SESSION_EVENT_TYPES` is exported from contracts and referenced by stores, specs, and `readStreamingDeltaBatchableEvent` (`server-operations.ts:382`); adding an event type changes one place, and test assertions match the set and the reducer's ignore set.
5. **Consumers contract by seq, not array length**: change all `max(events.sequenceNumber)` inferences to `getLatestSequenceNumber()` / `record.lastSeq`, and add a "still correct after eviction" test for each consumer, so future retention changes do not silently break cursors.
6. **Runtime assertions**: `getStats()` `events / evictedEvents / retainedTransient` enter memory diagnostic logs so online effect is directly verifiable; perf tests assert upper bounds with the same `getStats()`.
7. **Rollbackable**: retention mode is a construction parameter; on problems switch the default back to `unbounded` without reverting consumer changes.

## VI. Delivery Order

1. `docs`: convert this document to the spec at `apps/zcode-cli/docs/design/v2/session-event-store-retention.md`; update `docs/design/v2/session-idle-deactivation.md` (record release on `deleteSession`) and `docs/conversation-product-protocol.md` (legacy playback behavior change).
2. `refactor(cli): in-place event append, seq counter, deleteSession on release` (Phase 1 + consumers read counters + DI seams + contract tests + delete test stand-ins).
3. `feat(cli): turn-window retention for transient session events` (Phase 2 + new integration/perf cases + getStats expansion).
4. Parallel small MRs: main `will-download` / `streamBatches`, renderer shiki/snapshots LRU.

## VII. Decision Points

- Whether one-turn-lag eviction is acceptable (cost: one more completed turn's deltas stay in memory; benefit: no dependence on persistence timing). Confirmed by the user.
- Legacy `session/events` no longer replays completed turns' `model.streaming`; whether desktop replayable / bot sides depend on rendering historical text (check `session-mapper.ts`'s `ModelComplete` mapping and the consumer side of `packages/services/src/zcode-agent/zcodeAgentService.ts:5640` before implementation).
