# Memory Leak Fix Plan: CLI Memory Event Store Retention Strategy

Status: **Implemented** (spec at `apps/zcode-cli/docs/design/v2/session-event-store-retention.md`; user confirmed one-turn-lag eviction. This document is preserved as a decision process record.)

Related: Audit report `docs/analysis/memory-leak-audit-2026-09-03.md`; observation capability `docs/monitoring/memory-diagnostics-log.md` (already landed, the `eventRows` counter is the before/after comparison evidence for this item).

## I. Audit Hazards Reviewed and Prioritized

| Priority | Process       | Hazard                                                                                                                                                                                   | Growth Rate                                                                          | Why Prioritized Here                                                                                                                                                                                       |
| -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**    | agent CLI     | `InMemorySessionEventStore` permanently retains each `ModelStreaming` (per-token) and `ToolCallProgress` events, append also fully copies `[...events, e]`; nobody calls `deleteSession` | **One event per token**, only increases and never decreases during session residence | The only growth point per-token frequency; hits all long sessions, all users; desktop-side legacy `session/subscribe` pins sessions without recycling, the combination of both is "bigger the longer used" |
| 2        | main          | `will-download` listeners attached to defaultSession, skip cleanup on window close                                                                                                       | +N closures per window close                                                         | One-line fix, independent MR                                                                                                                                                                               |
| 3        | main          | `TaskRealtimeBus.streamBatches` non-terminal runs not deleted, also replayed to new windows                                                                                              | +1 each interruption/disconnection (≤512KB)                                          | Few-lines fix, independent MR                                                                                                                                                                              |
| 4        | renderer      | shiki `tokensCache` without eviction, streaming Edit one entry per chunk                                                                                                                 | +N per Edit tool output                                                              | Add LRU, independent MR                                                                                                                                                                                    |
| 5        | renderer      | task snapshot memory cache unbounded                                                                                                                                                     | +1 per opened task                                                                   | Apply existing caps from persistence layer                                                                                                                                                                 |
| 6        | host          | bots per-task subscriptions only released by stream-internal terminal events                                                                                                             | +1 per remote disconnection/crash                                                    | Extract `releaseTaskWatch`                                                                                                                                                                                 |
| 7        | agent CLI     | subagent child session publishers without parent→child mappings                                                                                                                          | +1 per subagent set                                                                  | Requires parent-child mappings                                                                                                                                                                             |
| 8        | host/services | RPC disconnects do not recover pty/fs.watch; session closes do not clear mirror tables                                                                                                   | +1 per disconnect / per session                                                      | Structural, requires unified boundaries                                                                                                                                                                    |

2–5 are small changes and can run in parallel as separate MRs; this document only plans item 1.

## II. Fix Goals and Must-Keep Contracts

The fix only changes **the retention strategy**, not interfaces, not sequence number allocation positions, not live sink object consumption. Each of the following below is a fact read from the code; none can be trimmed if any of them is not true.

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
 (server-ops:715) max(seq) ← risk     ModelComplete /      ToolCallResult /
 for ModelStreaming                    RewindTriggered /    CheckpointCreated
 batching as model.streaming           CheckpointCreated
```

| Contract                                           | Source                                                                                                                                                                                                                                                                                     | Constraint on Fix                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| seq sole source                                    | `events.ts:79-82` comments; `v4-gateway.ts:2375+ normalizeRuntimeEventSequence` drains by raw seq continuously                                                                                                                                                                             | Transient events **still must go through stores to allocate seqs and be delivered raw to live sinks**; cannot bypass stores |
| `getLatestSequenceNumber()+1` generates new events | `assistant-feedback-persistence.ts:53`, `v4-bridge.ts:457`                                                                                                                                                                                                                                 | Numbers must come from independent monotonic counters, cannot take "the last still-resident event"                          |
| V4 cold resume cursors                             | `v4-bridge.ts:1506-1516` uses `max(events.sequenceNumber)` as `sourceEventSeq`                                                                                                                                                                                                             | After eviction, this value will be smaller → change to `getLatestSequenceNumber()`                                          |
| Legacy protocol seq                                | `server-operations.ts:800 getProtocolEventSeq` by replaying all events to take lastSeq                                                                                                                                                                                                     | Change to directly read `lastSeq` from records (`server-types.ts:63` already exists)                                        |
| V4 projections' streaming event dependencies       | `product-projection.ts:463` only consumes `ModelStreaming` when `isRunning()`; `cold-event-merge.ts:138` lists `ModelStreaming/ModelComplete` as TRANSCRIPT_DERIVED, completed turns re-synthesized from persisted messages by `transcript-hydration.ts:1480 synthesizeEventsFromMessages` | **In-progress turn** transient events must be retained; **completed and persisted** turns' transient events are redundant   |
| `ModelComplete.content` carries full text          | `contracts/src/events/session.events.ts:566`                                                                                                                                                                                                                                               | Completed turn text does not depend on deltas                                                                               |
| Reducers/rewind/fork/checkpoints                   | `contracts/src/events/event-reducer.ts` has no `ModelStreaming/ToolCallProgress` handlers; each consumer only filters low-frequency types                                                                                                                                                  | Unaffected by truncation                                                                                                    |
| Usage statistics `firstTokenAt`                    | `usage-observability.ts:373` uses per-turn `events` arrays                                                                                                                                                                                                                                 | Unaffected                                                                                                                  |
| Legacy playback behavior changes                   | `readProtocolSessionEvents` will lose completed turns' `model.streaming` batching                                                                                                                                                                                                          | Confirm `session-mapper.ts` mapping of `ModelComplete` carries full text (first thing to do before implementation)          |

## III. Phased Plans

### Phase 1: Zero Semantic Changes (Can Be Deployed Independently)

- Change `append` to in-place `push`, removing O(n) copies; `getEvents` keeps returning copies (callers have `[...events]` habits, do not risk).
- Change `getLatestSequenceNumber` to independent monotonic counter `latestSeqBySession`.
- Call `eventStore.deleteSession(sessionId)` when session records are released: `session/close`, creation failures, idle deactivation, process exit four paths (`bootstrap/src/zcode-protocol/server.ts` / `session-residency.ts`).
- Change `v4-bridge.ts:1506`'s `sourceEventSeq` and `server-operations.ts:800`'s `getProtocolEventSeq` to read counters / `lastSeq` (behavior equivalent at this point, changed first to lay groundwork for Phase 2).
- Acceptance: all existing tests green; `eventRows` zeroes after sessions close.

### Phase 2: Turn-Window Retention Strategy (The Real Memory Fix)

- Add pure module `adapters/src/storage/session-event-retention.ts`:
  - `TRANSIENT_SESSION_EVENT_TYPES = {ModelStreaming, ToolCallProgress, StreamingToolLedgerUpdated, ModelNetworkStatus}` (single source, referenced by stores and docs).
  - State machine: `onAppend(event) → { retain: boolean; evictTurnIds: string[] }`. Rules: transient events bucketed by `turnId`; when `TurnStarted(T+1)` is observed, evict buckets for `T` and earlier that have already `TurnComplete/TurnError` (**one-turn lag**, leaving time for sqlite persistence); when `RewindTriggered` arrives, do not evict any buckets (rewind-period turn ownership is complex, hand off to `deleteSession`).
  - Non-transient events permanently retained (quantities same-order as messages, already have compact boundaries).
- `InMemorySessionEventStore` accepts `retention?: SessionEventRetentionPolicy`, default turn-window; `unbounded` mode retains current state for rollbacks and comparison tests.
- `getStats()` adds `evictedEvents`, `retainedTransient`, written to memory diagnostic logs alongside, serving as online-effect evidence.
- The only observable behavior change: legacy `session/events` / `session/subscribe afterSeq` no longer replays token deltas for **completed turns**; current turns and the immediately preceding completed turn are still replayable. Written into specs and `docs/conversation-product-protocol.md`.

### Phase 3 (Optional)

Caps for single-turn transient events (prevent individual runaway turns), batch earliest deltas into one entry when exceeded; determine after Phase 2 lands by examining `retainedTransient` distributions.

## IV. How to Test

### Unit (Write First)

| Test Case               | Assertions                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention state machine | Transient events retained during belonging turn; `TurnStarted(T+1)` evicts `T` buckets; `T+1` not ended before, `T+1` buckets retained; non-transient never evicted; rewind does not trigger eviction |
| Store: seq monotonic    | `getLatestSequenceNumber` does not regress after eviction; `append` returns strictly increasing seqs                                                                                                  |
| Store: read paths       | `getEvents/getEventsAfter` returns non-transient ∪ window-transient, sorted by seq; `deleteSession` zeroes `getStats`                                                                                 |
| Store: performance      | 10^5 appends linear (prevent returning to O(n²)), using existing `ZCODE_PERF_REPRO=1` gated writes                                                                                                    |
| Port contract tests     | `describeSessionEventStoreContract(factory)` runs both unbounded and turn-window modes simultaneously, guaranteeing semantic consistency                                                              |

### Bootstrap Integration (Existing + New)

- Must run existing: `zcode-protocol.test.ts` (5 places `model.streaming` playback/seq assertions), `v4-gateway*.test.ts`, `v4-cold-resume.test.ts`, `cold-event-merge.test.ts`, `transcript-hydration.test.ts`, `product-projection*.test.ts`, `session-resident-pool.test.ts`.
- New tests:
  1. `session/subscribe afterSeq` during turns in progress still replays current turn deltas;
  2. After two consecutive turns, playback only contains messages and low-frequency events, protocolSeq continuous without gaps;
  3. Cold resume `sourceEventSeq` equals latest seq after eviction, and gap-filling is correct;
  4. Raw seq out-of-order arrivals (N+1 before N) drain correctly after eviction;
  5. Rewind/fork/checkpoints results byte-identical after eviction in both modes (compare same scripts in both modes).
- Baseline-known-irrelevant failures: `v4-gateway.test.ts` "old revision retry", `zcode-protocol.test.ts` "three types of v4 subscribe responses", confirm their states on clean baselines before fixing, to avoid misjudgments.

### Memory Regressions (New)

`bootstrap/tests/session-event-store-retention.perf.test.ts`: `ZCODE_PERF_REPRO=1` gated, `--expose-gc`, run N turns × M deltas, assert `getStats().events ≤ non-transient count + 2 turns' transient count`, and `heapUsed` increments are bounded; output same script in unbounded mode as comparison.

### Manual / E2E

- Connect desktop to local CLI running >30-minute streaming long sessions, watch `memory_sample`'s `eventRows` curves in `~/.zcode/cli/log`: before fix linearly rises with tokens, after fix recovers between turns.
- V4 panes and legacy bots simultaneously subscribe, reconnect offline via `afterSeq` playback; rewind/fork/compact then replay.
- Run `pnpm test:e2e:container:conversation` (conversation validation set covering streaming/replay semantics).

## V. How to Ensure Testability of Modifications to Other Modules

1. **Dependency injection replaces hardcoded constructions**: `server-operations.ts:3493` and `:2883` directly `createInMemorySessionEventStore()`. Add `context.deps.createSessionEventStore?(sessionId)` (`ZCodeProtocolAgentDependencies` in `server-types.ts`), default turn-window stores; tests can inject spy stores asserting append/delete calls, or inject unbounded stores for A/B comparisons. `create-app.ts:558` already has `options.eventStore` interfaces, follow conventions.
2. **Separate strategies and containers**: Eviction rules are IO-free pure state machines, exhaustive branch unit tests; stores only "call strategies, maintain Maps." Future rule changes do not touch stores, nor any consumers.
3. **One Port Contract Test**: `describeSessionEventStoreContract` placed in `adapters/tests`, existing `core/tests/test-event-store.ts` this hand-written stand-in (same O(n) copies as production implementation) deleted, core's 40 tests switch to real stores, eliminating "stand-in-production behavior drift" false greens.
4. **Single-source constants**: `TRANSIENT_SESSION_EVENT_TYPES` exported from contracts, referenced by stores, specs, `readStreamingDeltaBatchableEvent` (`server-operations.ts:382`) with the same collections; when adding new event types, only change one place, test assertions match collections and reducer ignores sets.
5. **Consumers contract by seq, not by array lengths**: Uniformly change `max(events.sequenceNumber)` inferences to `getLatestSequenceNumber()` / `record.lastSeq`, and add "still correct after eviction" test cases for each consumer; so future retention strategy changes do not quietly break cursors.
6. **Runtime assertions**: `getStats()` `events / evictedEvents / retainedTransient` enter memory diagnostic logs, directly verifiable online whether strategies take effect; perf tests use the same `getStats()` to assert upper bounds.
7. **Rollbackable**: Retention modes are construction parameters, problems occur by switching defaults back to `unbounded` for rollbacks, without reverting consumer changes.

## VI. Delivery Order

1. `docs`: Convert this document to spec at `apps/zcode-cli/docs/design/v2/session-event-store-retention.md`, simultaneously update `docs/design/v2/session-idle-deactivation.md` (record releases when `deleteSession`) and `docs/conversation-product-protocol.md` (legacy playback behavior changes).
2. `refactor(cli): in-place event append, seq counter, deleteSession on release` (Phase 1 + consumers change to read counters + DI seams + contract tests + delete test stand-ins).
3. `feat(cli): turn-window retention for transient session events` (Phase 2 + new integration/perf cases + getStats expansions).
4. Parallel small MRs: main `will-download` / `streamBatches`, renderer shiki/snapshots LRU.

## VII. Decision Points for You

- Whether one-turn-lag eviction is acceptable (costs: always retain one more completed turn's deltas in memory; benefits: does not depend on persistence timing).
- Legacy `session/events` no longer replay completed turns' `model.streaming`; whether desktop replayable / bot sides have dependencies on rendering historical text (check `session-mapper.ts`'s `ModelComplete` mappings and consumer-side of `packages/services/src/zcode-agent/zcodeAgentService.ts:5640` before implementation).
