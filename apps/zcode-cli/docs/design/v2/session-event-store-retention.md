# Session Event Store Retention (turn-window eviction of the in-memory event store)

Status: **confirmed, implemented per this spec**

## Problem

Each ZCode Protocol session record holds an in-process `InMemorySessionEventStore`. It does two things:
assigns a `sequenceNumber` to every `SessionEvent` (the single source of truth for live / replay /
snapshot order), and serves event reads for legacy replay, V4 cold recovery and rewind / fork /
checkpoint.

The problem: it kept `model_streaming` (per token), `tool_call_progress` and other transient events at
message-stream frequency resident forever, and `append` copied the whole array with `[...events, e]`
each time. While a session stays resident, memory grows linearly per token and GC pressure grows
O(n²); the desktop legacy `session/subscribe` keeps sessions resident without reclaim, and together
this is "it keeps getting bigger".

## Decision

Change only the **retention policy**; the `SessionEventStorePort` interface, the place where sequence
numbers are assigned and the objects the live sink receives stay unchanged.

1. `append` pushes in place; `getLatestSequenceNumber` is returned by an independent monotonic counter
   and no longer takes "the last still-resident event".
2. Transient events (`TRANSIENT_SESSION_EVENT_TYPES`) are bucketed by `turnId`. After a turn ends
   (`turn_complete` / `turn_error`) they are **not** evicted immediately; when the next `turn_started`
   arrives, the transient buckets of all ended turns are evicted (one-turn lag).
3. Time fallback: if an ended turn has no successor turn within `SEALED_TURN_TRANSIENT_GRACE_MS =
   120_000`, the protocol server calls `pruneSessionEventStores()` on the existing 60s resource sampling
   tick to evict it. Reason: a subagent child session has only one turn and never sees a next
   `turn_started`; on a real machine one child session left about 10 thousand deltas until the record
   was reclaimed by the pool. In-progress turns are unaffected.
4. Non-transient events keep their count, but when a sealed turn is evicted its `model_request` gets
   **metadata slimming** (next section); other non-transient events are kept permanently as is.
5. `deleteSession` is called when a session record is released (`session/close`, creation failure, idle
   deactivation).
6. The retention mode is a constructor parameter: `turn-window` (default) and `unbounded` (rollback /
   comparison tests).

### model_request metadata slimming (revised 2026-09-30)

The original item 4 said "non-transient events are of the same order as messages and have a compact
boundary". Measurement disproved this: `model_request.payload.messages` is the **full context** sent to
the model on every request, one per tool iteration; compact only truncates the context of later
requests and does not reclaim old resident events. One session of 214 turns (99 compacts) showed the CLI
heap after GC growing linearly from 102MB to 264MB, with about 150MB of event store growth, mostly the
`messages` of historical requests.

Nothing reads `messages` from the in-memory store:

| Reader | Fields used |
| --- | --- |
| `bootstrap/src/zcode-protocol/session-mapper.ts mapModelRequestPayload` | only `messages.length` (a comment says the full context is not pushed to the desktop) |
| `core/src/runtime/methods/usage-observability.ts` | only timestamp |
| `tui/src/app-events.ts` | only sets status |
| `server-operations.ts` title filter | only `querySource` |
| debug analyzer (`packages/debug/server`) | reads the JSONL written by the event sink, **not the in-memory store**; the live sink still receives full events |
| rewind / fork / checkpoint / V4 projection | do not consume `model_request` |

Rule: when the `turn-window` policy evicts a sealed turn (same-turn lag / time-fallback tick), the
resident copy of that turn's `model_request` is replaced with a new object whose `payload` drops
`messages` and adds `messageCount` (`slimRetainedModelRequest`). The event itself, `sequenceNumber` and
other payload fields are unchanged, and the object `append` returns to the live sink is unchanged.
In-progress turns and `unbounded` mode keep full messages (test doubles and comparison tests rely on it
to assert the request trace). `mapModelRequestPayload` prefers `messageCount` and stays compatible with
old full payloads.

### Why a one-turn lag

`appendEvent` first calls `eventStore.append`, then persists the message to sqlite, then notifies the
live sink. Right after a turn ends its messages may not be persisted yet; V4 cold recovery falls back to
in-memory transient events to assemble text for non-persisted turns. By the time the next turn starts
(the user sent another message) the previous turn's messages are certainly persisted, so eviction is
safe and the persistence result need not be fed back to the store. The cost is that memory always keeps
the transient events of one more completed turn, a bounded constant.

## Sequence

```text
turn 1 started ──► delta ×N ──► model_complete ──► turn_complete ──► turn 2 started ──► ...
     │               │                                   │                 │
     │  retain       │  retain (turn 1 open)             │ seal turn 1     │ evict turn 1 transient
     │               │                                   │ (still kept)    │ open turn 2
seq  1               2..N+1                              N+3               N+4 (counter never goes back)
```

## Contract (dependencies verified before implementation)

| Dependency | Source | Constraint |
| --- | --- | --- |
| Single source of seq | `core/src/runtime/methods/events.ts` `appendEvent`; `v4-gateway.ts normalizeRuntimeEventSequence` drains by raw seq continuously | Transient events still get seq from the store and go to the live sink unchanged |
| Appending new events with `getLatestSequenceNumber()+1` | `assistant-feedback-persistence.ts`, `v4-bridge.ts` | Sequence comes from the independent counter; eviction never rolls it back |
| V4 cold-recovery cursor | `v4-bridge.ts loadPersistedEvents`: previously `max(events.sequenceNumber)` | Now reads `getLatestSequenceNumber` together with `getEvents` (`Promise.all`, no await between the two calls, consistent snapshot) |
| Legacy protocol seq | `server-operations.ts getProtocolEventSeq` uses record-level `seqBySourceEventKey / lastSeq` | The protocol seq of evicted events stays on the record; replay merely skips them and seq stays continuous and monotonic |
| V4 projection | `product-projection.ts` consumes `model_streaming` only in `isRunning()`; `cold-event-merge.ts` lists `model_streaming / model_complete` as transcript-derived; completed turns are synthesized from messages by `transcript-hydration.ts synthesizeEventsFromMessages` | In-progress turns must be kept; transient events of completed, persisted turns are redundant |
| `model_complete.content` carries the full text | `contracts/src/events/session.events.ts` | The text of a completed turn does not depend on deltas |
| reducer / rewind / fork / checkpoint / file-changes / subagent child session | each consumer filters only low-frequency types | Unaffected |
| Legacy replay `session/events` / `session/subscribe afterSeq` | `server-operations.ts readProtocolSessionEvents` | **Behavior change**: batched `model.streaming` of completed turns is no longer replayed; legacy text has always come from snapshot messages / `session/messages`, and `ModelComplete` itself is not mapped to a protocol event |

## Transient event set

`TRANSIENT_SESSION_EVENT_TYPES = { model_streaming, tool_call_progress, streaming_tool_ledger_updated, model_network_status }`,
single source `@zcode/contracts`. A new event type at message-stream frequency must be added to this set
together with a reducer-ignore assertion.

## Observability

`getStats()` returns `sessions / events / evictedEvents / retainedTransient`, written with the in-process
memory local diagnostic log (`docs/monitoring/memory-diagnostics-log.md` at the repository root) as
`eventRows / eventEvicted / eventTransientRetained`, so production can verify the policy directly.

## Implementation

- `packages/contracts/src/events/session-event-retention.ts`: transient set and pure state-machine policy
- `packages/contracts/src/events/in-memory-session-event-store.ts`: store implementation
  (`@zcode/adapters/storage` keeps re-exporting the same-named factory)
- `packages/bootstrap/src/zcode-protocol/server-types.ts`: `deps.createSessionEventStore(sessionId)`
  injection point, default turn-window
- `packages/bootstrap/src/zcode-protocol/server-operations.ts` / `session-residency.ts`: record release
  calls `deleteSession`
- `packages/bootstrap/src/zcode-protocol/v4-bridge.ts`: cold-recovery cursor reads the counter
- `packages/core/tests/test-event-store.ts`: the test double reuses the contracts implementation
  (`unbounded`), removing double drift

## Acceptance cases

| Case | Setup | Assertions |
| --- | --- | --- |
| RET-001 | turn-window policy | Transient events of an in-progress turn are retained; not evicted after `turn_complete`; `turn_started(T+1)` evicts T; non-transient never evicted; `rewind_triggered` does not trigger eviction |
| RET-002 | store appends and evicts | `getLatestSequenceNumber` never goes back; `append` returns strictly increasing seq; `getEvents` ordered by seq |
| RET-003 | store | `getEventsAfter` contains only in-window transient ∪ all non-transient; `getStats` resets to zero after `deleteSession` |
| RET-004 | unbounded and turn-window run the same event sequence | Non-transient events and seq are identical, only the transient count differs |
| RET-005 | 50 turns × 200 deltas | `getStats().events ≤ non-transient + transient of 2 turns` |
| RET-006 | protocol server + fake app | The injected `createSessionEventStore` is used; `deleteSession` is called after `session/close` |
| RET-007 | protocol server, two turns | The first `session/events` contains turn 1 deltas; after turn 2 starts replay does not contain them, seq strictly increases, `eventSeq` never goes back |
| RET-008 | policy: sealed turn without successor | `collectExpired` is empty within grace, hands over the turn once after grace; does not hand it over again when a successor turn arrives first |
| RET-009 | store: one-shot session | `pruneTransientEvents` evicts its transient events after grace, sequence never goes back; in-progress turns unaffected |
| RET-010 | protocol server: turn ends without successor | `pruneSessionEventStores(now + 3min)` evicts that turn's deltas, and `session/events` replay no longer contains `model.streaming` |
| RET-011 | store: turn-window, two turns | After turn 2 starts, turn 1's `model_request` has no `messages`, `messageCount` equals the original length, other fields and seq unchanged; turn 2's `model_request` still has full messages; the object returned by `append` has full messages; unbounded mode does not slim |
| RET-012 | session-mapper | The `messageCount` mapped from a slimmed payload equals that of the full payload |
