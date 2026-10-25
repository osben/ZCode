# Session Resident Pool (in-process hybrid resident pool of the app-server)

## Scope

Defines the implementation contract of the session resident pool inside the ZCode Protocol app-server.
Product boundary and renderer lifecycle: root `docs/session-idle-deactivation.md`.

## Goals

Each CLI process uses an idle TTL as the primary reclaim policy and bounds burst resident counts with
high/low water marks:

```ts
DEFAULT_SESSION_RESIDENT_TARGET_COUNT = 8;
DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT = 16;
DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
```

An eligible session idle beyond the TTL is deactivated regardless of the resident count. When
`context.sessions.size > highWater`, reclaim does not wait for the TTL and proceeds by LRU down to
target. If the number of protected sessions exceeds highWater, overshoot is allowed: no task is
cancelled, no new session is rejected, and there is no hard RSS cap.

## Core invariant

`DEACTIVATED` must be equivalent to "the current CLI process never loaded this session":

- `context.sessions` has no record;
- the persisted session, messages, entries and task sqlite index remain;
- the V4 publisher, hydration, attachment cache and in-memory event store are released (the record
  release path explicitly calls `eventStore.deleteSession`; eviction of transient events while resident
  is in `session-event-store-retention.md`);
- no `session.removed` is sent;
- when V4 uses the session again, the entry point explicitly decides whether activation is needed, then
  goes through
  `gateway readyFlights -> ColdSessionResumeCoordinator.ensureResumed -> activateSessionForResume -> projection hydration`;
  `hydratePublisher` itself still only does projection hydration. Legacy resume keeps the original
  activation/snapshot entry.

## Components

### `SessionResidentPool`

Location: `bootstrap/src/zcode-protocol/session-resident-pool.ts`.

Narrow host interface:

```ts
interface SessionResidentPoolHost {
  listSessionIds(): string[];
  readResidencyFacts(sessionId: string): SessionResidencyFacts | null;
  deactivate(sessionId: string): Promise<void>;
  onDeactivated?(sessionId: string): void;
  onError?(sessionId: string, error: unknown): void;
}
```

Responsibilities:

- keep `sessionId -> lastTouchedAt`;
- keep `sessionId -> eligibleSinceAt`;
- keep the process-wide operation lease count and the per-session lease count;
- keep `sessionId -> deactivation Promise` as the cold resume gate;
- clear `eligibleSinceAt` when a protecting fact exists or the session is touched; start a new TTL from
  the current time when it first becomes eligible again;
- reclaim fresh eligible sessions whose TTL has expired first;
- if the remaining resident count still exceeds highWater, pick LRU by ascending
  `max(lastTouchedAt, record.updatedAt)` down to target;
- re-read facts before each execution so new work appearing after candidate selection is caught;
- report a single close failure only, without blocking other candidates.

### `SessionResidencyFacts`

```ts
interface SessionResidencyFacts {
  persisted: boolean;
  hasResidencyBlockingWork: boolean;
  hasPendingInteractions: boolean;
  hasQueuedCommands: boolean;
  hasSubscribers: boolean;
  hasLegacySubscriber: boolean;
  lastActivityAt: number;
}
```

A session is eligible only if:

```text
persisted
&& !hasResidencyBlockingWork
&& !hasPendingInteractions
&& !hasQueuedCommands
&& !hasSubscribers
&& !hasLegacySubscriber
&& pool.operationLeaseCount(sessionId) === 0
```

`deliveryKind !== undefined` must not be a protection condition: it is not a subscription refcount, and
reads may write it too. The legacy `session/subscribe` has no unsubscribe RPC, so
`record.legacyStreamSubscribed` is set only on a real subscribe and conservatively protects the
replayable/bot stream until the CLI process ends.

### Authoritative runtime facts

`AgentRuntime` exposes a synchronous read-only interface:

```ts
hasResidencyBlockingWork(): boolean
```

It aggregates:

- runtime command drain;
- runtime command queue;
- active turn;
- active turn start reservation;
- running background Bash, Agent, Workflow and MCP monitor in the runtime task registry;
- runtime-owned detached work counts: session title, goal title (including fallback persistence), MCP
  startup, background-notification ledger writes and goal heartbeat;
- pending/running work of the project-memory extraction scheduler;
- project-memory recall prefetch not yet settled.

Runtime-owned detached work must increment its count when the Promise starts synchronously and
decrement in the `finally` of the same Promise. A new detached sidecar must use the same tracker; the
pool adapter must not guess one by one.

Bootstrap ORs in:

- `record.activeAbortController !== undefined`, the protocol-adapter active safeguard;
- `record.residencyFinalizationCount > 0`, covering the command fact, ensure-model, snapshot and
  broadcast finalization still running after background prompt, compact and goal continuation released
  the active lock.

A finalization lease is registered when the background runner starts and released in the `finally`
after all state-mutation finalization is done. It cannot be replaced by delaying the clearing of
`activeAbortController`, which is the ready lock of input admission.

```text
runtime sidecar start ──sync +1──> blocking
      promise finally ───── -1───> eligible candidate

protocol background start ─ +1 finalization
      active work complete ─ clear activeAbortController
      mutation complete ──── -1 finalization
```

Automation, scheduled/off-peak tasks, browser use, goal continuation and compact create no side
criterion: they must land on the prompt/runtime/finalization owner chain above. SSH/WSL/Docker only
changes where the pool's CLI process runs, not the source of facts.

## Operation lease

`ZCodeProtocolAgentServer.handleRequest` acquires a lease before dispatch and releases it after the
whole async dispatch completes:

```text
handleRequest(request)
  -> pool.acquireOperation(sessionIdFromRequest)
       -> process-wide operationCount++
       -> wait for in-flight deactivation of the same session
       -> session operationLeaseCount++
  -> touch(sessionId) and reset idle TTL
  -> dispatchRequest(request)
  -> release
  -> touch(sessionId) and reset idle TTL
       -> session operationLeaseCount--
       -> process-wide operationCount--
       -> rebalance()
```

`sessionIdFromRequest` reads:

- the top-level `sessionId` of normal params;
- the `conversation/<sessionId>` topic of V4 conversation subscribe/resync/unsubscribe;
- the `sessionId` of each command key in `v4/commands/query`;
- workspace/global requests without a sessionId hold only the process-level lease.

The process-level lease keeps cross-session awaits such as the provider registry from racing with
sampler reclaim; the per-session lease also enters the eligibility facts, for testability and to express
ownership.

## Rebalance

Triggers:

1. Every protocol request lease release.
2. The existing process resource sampler `onSample` as a low-frequency fallback.

Algorithm:

```text
rebalance()
  if globalOperationCount > 0: return
  resident = host.listSessionIds()

  for each resident
    facts = read fresh facts
    if !eligible(facts)
      eligibleSinceAt.delete(sessionId)
    else if no eligibleSinceAt
      eligibleSinceAt.set(sessionId, now)

  expired = eligible candidates where now - eligibleSinceAt >= idleTimeout
  for candidate in expired ordered by eligibleSinceAt then LRU
    fresh = readResidencyFacts(candidate)
    if eligible(fresh) and TTL still expired
      executeDeactivation(candidate, reason=idle_timeout)

  remaining = host.listSessionIds()
  if remaining.length > highWater
    candidates = remaining fresh eligible ordered by lastUsedAt
    for candidate until remainingCount <= target
      fresh = readResidencyFacts(candidate)
      if !eligible(fresh): continue
      executeDeactivation(candidate, reason=high_water_lru)
```

Ordering uses sessionId as a stable tie-breaker for equal timestamps. The TTL is based only on the
in-process `eligibleSinceAt`; a very old on-disk `record.updatedAt` is never the idle start of a
just-cold-resumed session. `touch` and protection state transitions reset the TTL; LRU touch and
`record.updatedAt` only decide the high-water candidate order.

Both protocol request release and the existing 60-second process resource sampler call rebalance; no new
timer is added. So the default TTL fires about 10 to 11 minutes after a session becomes eligible.

The server assembly layer resolves compatible config by this contract:

- legacy `sessionResidentTargetCount` expresses only low-water and does not override high-water;
- when only `targetCount` is passed, assembly must resolve an effective high-water not below target, so a
  smaller default high-water cannot make the whole Agent CLI throw at construction;
- an explicitly passed invalid high/target combination is still rejected by the `SessionResidentPool`
  constructor validation.

## Deactivation execution

First synchronous slice of `deactivateSessionRecord(context, sessionId)`:

```text
record = sessions.get(sessionId)
v4Gateway.assertSessionRuntimeDeactivatable(sessionId)
record.unsubscribe()
v4Gateway.deactivateSession(sessionId)
sessions.delete(sessionId)
promise = record.app.close()
```

`assertSessionRuntimeDeactivatable` is a pure check and must precede the first side effect. If the check
rejects, the record, runtime event subscription and gateway runtime state all remain usable.
`app.close()` is asynchronous cleanup after detaching; failures are isolated and recorded by the pool
and are not part of the rollback-able synchronous pre-check transaction.

`deactivateSession` reuses the runtime cleanup of `disposeSession` with `notifyIndexRemoved=false`. It
clears the publisher, hydration, flush state, projection waiter, attachment cache, raw sequence,
telemetry normalization state, and the per-session settled LRU and admission sequence of
`CommandInbox`, and does not call `indexPublisher.removeSession`. If `CommandInbox` still has an
in-flight/live pin, fresh facts must block deactivation; the execution surface also rejects again
before tearing down the publisher.

The Promise of `app.close()` is stored in the pool's in-flight map. Later requests for the same session
wait for it to settle. A close failure is logged as warn through `onError`; the gate must be released
and must not block cold resume forever.

## Detached subagent child publisher

A running subagent child reuses the parent runtime's external event sink and has no bootstrap record of
its own, but its raw child events build an independent conversation publisher in the V4 gateway
(`ingestDetachedLiveSession`). It is not in `context.sessions`, so neither the resident pool above nor
the deactivation execution surface covers it.

Bug root cause: the child is a one-shot session with a single turn; once the publisher is built it has
neither a record release path nor a successor turn. On a real machine every subagent run left one more
publisher (full projection plus up to 2000 log entries) resident until the CLI process exited (the
`v4.detachedLive` counter only grew).

Lifecycle contract:

1. The gateway records the child → parent ownership in
   `ingestDetachedLiveSession(childId, event, parentSessionId)`.
2. When the parent record is released (`session/close`, creation failure, idle deactivation) via
   `cleanupSessionRuntime(parent)`, all of its detached child publishers **without their own record**
   are released too; a child that already has a record (explicitly resumed) follows its own record
   lifecycle.
3. Time fallback: the child's `turn_complete` / `turn_error` records the terminal time. The protocol
   server calls `pruneDetachedChildPublishers()` on the existing 60s resource sampling tick; a child
   whose terminal state exceeds `DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000`, which currently has no
   conversation subscriber and no record, is released. A new `turn_started` of the child revokes the
   terminal record.
4. Subscribing again after release uses the existing cold resume: the child is persisted in the session
   store as `subagent_child`, and `hasLiveConversation` returning false restores it as a historical
   session; no second recovery chain is added.
5. Release sends no `session.removed`: the detached child is not in the sessions-index.

## Renderer

This implementation changes no protocol schema and adds no notification. After the last pane lease is
released, the renderer `SessionDataLayer` follows the existing keep-warm timer:

```text
unsubscribe -> ConversationProjectionStore.close -> entries.delete(topic)
```

That unsubscribe makes the CLI `hasSubscribers` false. The CLI pool and the renderer cache connect
naturally through the existing subscription lease and hold no lifecycle state of each other.

## Test-first checklist

### Core

- An idle runtime returns the unified protection fact false.
- Any of active/queued/reserved/draining makes `hasActiveOrQueuedTurnWork` true.
- Running background work in the runtime task registry makes the unified protection fact true, and
  terminal states restore false.
- Any unfinished detached tracker, MCP startup, title fallback, memory extraction/recall makes the
  unified protection fact true.

### Bootstrap pool

- Default idle TTL is 10 minutes, highWater 16, target 8.
- After TTL expiry reclaim happens even with fewer residents than target; touch/protection state resets
  the TTL.
- highWater 4, target 2, resident 5: reclaim by LRU down to 2.
- When protected sessions exceed highWater, overshoot is allowed.
- Each of runtime owned work / protocol finalization / pending / queue / subscriber / draft / operation
  lease protects alone.
- Legacy stream subscribe protects, and `deliveryKind` of a normal `session/read` is not a lease.
- After candidate ordering, changed fresh facts skip the candidate.
- An operation lease blocks sampler rebalance and converges immediately after release.
- An in-flight deactivation close blocks new operations of the same session.
- After close rejects the gate is released and other candidates continue.
- Deactivation clears `CommandInbox` settled/admission memory, and an in-flight/live pin rejects the
  cleanup.

### Integration

- Real sqlite session: TTL starts after subscribe + unsubscribe and deactivation triggers on timeout.
- sessions-index gets no `session.removed`.
- Re-subscribing creates a new app, and snapshot rows contain both persisted user and assistant text.
- Re-subscribing before the close gate is released does not materialize a new record.
- An active runtime and a running background runtime stay registered under capacity overshoot.
- Legacy and V4 background prompt/compact/goal continuation stay registered after clearing the active
  lock until state mutation completes.

## Non-goals

- A global pool across CLIs/workspaces.
- A hard RSS/heap byte cap.
- Adaptive memory pressure.
- User settings or new environment variables.
- A renderer reclaim notification.
- Changing desktop continuous or mobile replayable recovery semantics.
- Pushing session/task business state down into the Host, Desktop main or relay.
