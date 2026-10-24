# V4 Resume / Activation Race Audit and Test Plan

> Status: draft (2026-08-28)
> Scope: V4 conversation cold activation, projection hydration, the legacy `session/resume` entry,
> query/command timeouts, and the desktop-continuous / web-remote-replayable recovery boundaries.
> This is an audit and test plan; it does not change runtime code.

Full history: `git show b8876e8b:docs/v4-refactor/18-resume-race-audit-plan.md`

## 1. Goal and criteria

The audit looks for three provable problems, not "a Promise may be slow":

1. Two runtimes or two projection owners for the same session.
2. After timeout, abort, disconnect, deactivate or runtime replace, an old continuation still writing new state.
3. A read failure or incomplete state treated as empty, idle, unknown or a successful ACK.

Expected recovery boundaries:

```text
request
  │
  ├─ server request lease (blocks resident-pool reclaim)
  ├─ readyFlights[sessionId] (cold activation + hydration only)
  │      ├─ ColdSessionResumeCoordinator (runtime activation singleflight)
  │      └─ hydratePublisher (projection hydration singleflight)
  ├─ CommandInbox (sole command/query admission authority)
  └─ publisher / durable store (projection and history facts)

timeout / abort / disconnect / deactivate
  ├─ the old operation must stop writing, or be discarded explicitly as a stale generation
  └─ "not read" must never be rewritten as "read an empty set"
```

Authorities stay distinct:

| State / fact                          | Authority                                          | Non-authoritative lookalike                              |
| ------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| runtime activated                     | `context.sessions` + activation result             | whether `readyFlights` exists, whether the client RPC returned |
| cold V4 may admit query/command       | gateway `readyFlights` (snapshot at call start)    | `context.sessions.has(sessionId)`                        |
| command FIFO / idempotency            | CLI `CommandInbox` + durable command facts         | renderer optimistic overlay, RPC ACK arrival time        |
| projection watermark                  | publisher `seq/revision/logEpoch`                  | ACK epoch, connection time                               |
| history body                          | successful transcript / event store read           | the empty array built after a `loadPersistedEvents` failure |
| desktop / mobile recovery semantics   | trusted `clientMode` / `deliveryKind`              | whether the RPC came back from remote, UI profile guessing |

## 2. Confirmed problems (dynamically reproduced)

### R1 - hydration persisted-read failure silently becomes an empty projection (high)

Location: `performHydration` in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`.
The code catches `host.loadPersistedEvents`, reports `v4.hydrate`, then returns
`{ events: [], synthesized: false, sourceEventSeq: 0 }`, so a cold subscribe with a disk read failure still
returns a successful first frame with `ack.mode=snapshot`, `revision=0`.

Minimal Vitest probe (run; fails on the current implementation):

```ts
const host = makeHost();
host.sessions.clear();
host.resumeOutcome = "resumed";
host.loadPersistedEventsImpl = async () => {
  throw new Error("persisted read failed");
};
const gateway = makeGateway(host);

await expect(gateway.subscribe(subscribeParams())).rejects.toThrow("persisted read failed");
```

Actual: the Promise resolved with an empty snapshot. This violates `17-cold-resume-runtime-activation.md` §4
("hydration errors keep the original lifecycle error") and `10-protocol-spec.md` §7.3 (a persisted-read
failure must not be disguised). Risk: the user sees "success but no history" and can send commands at a
wrong watermark; mobile replayable may use the empty snapshot as the recovery baseline.

### R2 - concurrent legacy `session/resume` creates duplicate runtimes (high)

Location: `activateSessionForResume` in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`.
There is only `await waitForDeactivation` and no per-session activation flight. Two requests can both pass the
`context.sessions.get` check before `context.sessions.set(sessionId, record)`, each run
`materializeSessionRecord`, and the later write overwrites the earlier record; both apps may continue
`resume()` while only one stays in the registry.

Real sqlite + `ZCodeProtocolAgentServer` probe (run; fails on the current implementation):

```ts
await Promise.all([
  requestResult(server, { id: "resume-a", method: zcodeProtocolMethods.sessionResume,
    params: { workspace, sessionId } }),
  requestResult(server, { id: "resume-b", method: zcodeProtocolMethods.sessionResume,
    params: { workspace, sessionId } }),
]);
expect(createdAppOptions.filter((o) => o.sessionId === sessionId)).toHaveLength(1);
```

Actual: 2 apps for the same `sessionId`. The process-level residency lease only blocks resident-pool
reclaim; it does not serialize two resumes of one session. Risk: event sink, model config,
`record.app.resume()` and the final `context.sessions` owner overwrite each other; a returned snapshot may come
from a runtime that is no longer the registry owner.

## 3. High-risk candidates (not fixed; need dedicated tests)

- **R3 - V4 query timeout contract not wired (high).** `PROTOCOL_V4_LIMITS.conversationQueryTimeoutMs = 10_000`
  in `packages/shared/src/zcode-protocol-v4/core.ts` has no consumer. The calls in
  `packages/services/src/zcode-agent/zcodeAgentService.ts` (`commandsQuery`, `conversationUsage`, `rowsRange`,
  `plans`, `fileChanges`, `fileRewindPreview`, attachment read/preview) pass no per-request `timeoutMs`, so the
  `ZCodeProtocolClient` default of 3 minutes applies. A timeout triggers
  `ZCodeAgentProcessManager.onRequestTimeout`, which evicts the whole client/process except for
  `workspace/cancelGenerateText`. To verify: should a query fail at 10 s instead of 180 s; should long
  `fileChanges` / attachment reads share the query timeout or have their own budget; command/subscribe need
  separate deadlines so wiring the query constant does not kill normal turns.
- **R4 - `ColdSessionResumeCoordinator.clear()` does not cancel the underlying operation (medium-high).**
  `clear()` only clears the `flights` map and cannot interrupt a Promise already handed to the host. The
  gateway's `cleanupSessionRuntime()` also deletes `readyFlights` / `hydrationInFlight`; if deactivate happens
  before the hydration buffer exists, the old continuation can still enter `hydratePublisher`. The production
  request lease blocks normal resident-pool reclaim, so this is a conditional race on explicit gateway
  deactivate, connection teardown and shutdown.
- **R5 - attachment/begin vs READY boundary is easy to misread (medium).** `attachmentBegin` only calls
  `coldResume.ensureResumed` without waiting for gateway READY / hydration; `attachmentRead` /
  `attachmentPreviewSource` go through READY + hydration. The v4 spec lists `attachment/begin` as a legacy
  boundary not merged into READY, but `docs/runtime-tools/embedded-search-native-build.md` says all entries
  enter "the same singleflight materialization". Spec drift: decide whether begin needs only a runtime record,
  or whether entries that use the projection right after begin must wait for the same READY. Not a confirmed
  bug until decided; protect the boundary with a begin||subscribe||command ordering test.
- **R6 - record registration window after activation/hydration failure (medium).** The spec allows lifecycle
  state to remain after a failure post-registration and promises no auto-rollback; READY releases the map, and
  the next entry may see `hasLiveConversation=true` and call `hydratePublisher` directly. Test: first READY
  fails after registration, then second subscribe/query/command must stay explainable and produce no empty
  projection.
- **R7 - legacy resume / UI restore has no per-session generation (medium).** `packages/ui/src/lib/zcodeSessionRestore.ts`
  desktop restore is two independent RPCs (`resumeSession` -> `readSession`);
  `packages/services/src/zcode-session/zcodeSessionService.ts` resume may also append thought/model fixes and
  broadcasts. With concurrent open, reconnect or workspace switch, an earlier snapshot may arrive late and
  overwrite newer state. Verify with two deferred restore calls that a late old result cannot become the final
  UI/task-index fact.
- **R8 - `waitForSessionIdle` has two authorities + a fixed 5 s (medium).** `session-flow.ts` polls both
  `record.activeAbortController` and `runtime.getActiveForegroundExecutionId()`; they release in different
  order (one is a legacy-compat field); after 5 s it throws `V4SessionIdleTimeoutError` with no
  generation/operation token saying who still owns execution. Cover: stop -> new turn, runtime execution id
  change, old controller released late, the 5 s boundary.
- **R9 - session_entries read failure degrades to empty (medium-low).** `v4-bridge.ts` returns `[]` when the
  `sessionEntries` read for goal-completion verification fails and main hydration continues. Unlike R1 it only
  affects goal/verification derived state, but can misjudge pending/paused/complete as "no goal". Distinguish
  "optional derived fact missing" from "body/timeline read that must fail".
- **R10 - global usage picks an arbitrary active client (low).** `getAppUsageStats` uses
  `activeClientsByWorkspaceKey.values().next().value`; the first entry may be stale/disposed or in provider
  sync. Needs a process-replace + concurrent usage query test to confirm a defined active-client selection/retry rule.

## 4. Entry x state x event matrix

| ID  | Entry                       | Start state          | Concurrency/timeout event                              | Expected                                                                                         |
| --- | --------------------------- | -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| C01 | legacy `session/resume`     | cold, no record      | second resume for the same session                     | one runtime owner; both requests share one activation result                                     |
| C02 | legacy `session/resume`     | cold                 | A sets a model, B sets a different model               | no two interleaved apps; final model follows a defined last-writer/serialization rule            |
| C03 | V4 subscribe                | cold                 | activation done, hydration read fails                  | return lifecycle/hydration error, not an empty snapshot                                          |
| C04 | V4 subscribe                | cold                 | A activating, B subscribes (desktop + mobile)          | one READY; the two delivery profiles split only after ready                                      |
| C05 | V4 subscribe                | cold                 | A activating, `disposeSession` / deactivate            | A must not revive a publisher after cleanup; or fail explicitly and be retryable                 |
| C06 | rows/plans                  | cold                 | query and subscribe start together                     | query waits only for the READY registered at call start; never reads an old/empty index          |
| C07 | command/query               | cold                 | command/query before READY map registration            | either call-start snapshot per spec, or an entry-level gate; fix the contract and test microtask order |
| C08 | attachment/begin            | cold                 | begin\|\|subscribe\|\|command                          | verify the "activation only / no hydration" boundary; no implicit second runtime                 |
| C09 | attachment/read             | cold                 | runtime registered, projection not hydrated            | must go through READY + hydration, not only `sessionExists`                                      |
| C10 | hydration                   | warm publisher       | persisted load fails                                   | never treat failure as empty events; if the warm publisher is kept, state whether the snapshot is still trusted |
| C11 | hydration                   | during load await    | live raw event arrives                                 | after source cursor and buffer merge: no lost event, no permanent gap                            |
| C12 | command sendText            | warm                 | `waitForSessionIdle` 5 s timeout then old turn ends late | new command must not be wrongly admitted or kill the next-generation turn                      |
| C13 | command sendQueuedNow/edit  | warm                 | stop / foreground execution id change                  | old stop may only noop, never abort a new execution                                              |
| C14 | projection commit waiter    | raw gap              | missing event arrives after the 25 s timeout           | waiter failure is final; the late event must not apply                                           |
| C15 | physical wire               | fragment in flight   | recovery arrives after the 30 s assembly timeout       | fail-closed unlocked only by exact recovery; old online fragments do not pollute the new generation |
| C16 | UI conversation store       | live                 | runtime restart / proxy replace / old subscribe ACK late | generation drops the old ACK; new subscription keeps correct clientMode/deliveryKind           |
| C17 | UI restore                  | resume->read         | second restore finishes first, first arrives late      | the old snapshot must not overwrite the new generation                                           |
| C18 | provider/model              | cold resume          | registry sync interleaves with resume/command          | provider registry revision and session model must not regress                                    |
| C19 | remote workspace            | cold                 | same path, different workspaceIdentity concurrently    | session, READY, cache, owner do not cross workspaces                                             |
| C20 | usage/query                 | many workspaces active | first client disposed / replaced                     | choose a healthy client; a stale client is not authoritative                                     |

## 5. Test implementation order

- **Phase A: lock the two confirmed failures.** Add the R1 probe to `v4-gateway.test.ts` (first as `it.fails`
  or an isolated audit fixture, so "empty projection" is not mistaken for a normal regression). Add the R2
  probe to `v4-cold-resume.test.ts`, asserting the number of `createZCodeApp` calls and the final registry
  owner for one session; it fails first, then discuss the per-session activation owner fix.
- **Phase B: timeout / cancellation harness.** Deferred gate + fake timers, not real 10/25/30 s: gateway (all
  interleavings of READY, hydration, deactivate, dispose); services (assert the `timeoutMs` passed by V4
  queries and whether the process manager is evicted after timeout); UI (assembler/recovery deadline, runtime
  generation, old ACK/frame after replace).
- **Phase C: finite state permutations and property tests.** Per session only these dimensions:

  ```text
  runtime = cold | activating | warm | hydrating | disposed | replaced
  entry   = resume | subscribe | query | command | attachment
  event   = resolve | reject | timeout | abort | disconnect | deactivate | restart
  client  = desktop-continuous | web-remote-replayable
  ```

  First all permutations for one session and at most two concurrent entries; then add remote identity and
  child sessions. Each permutation checks invariants only, not unobservable internal timing. Wire the
  dimensions into `packages/formal-proof` if needed, but do not merge `context.sessions`, READY and
  CommandInbox into one abstract state.

## 6. Acceptance invariants

- At most one runtime owner per `workspaceKey + sessionId` at any time.
- Before cold READY completes, a query/command that saw READY does not enter the old CommandInbox; a READY
  failure produces no fake `unknown` or empty projection.
- A persistent read error is distinguishable from "truly empty"; logs are diagnostics only and do not change
  error semantics.
- After timeout/abort/disconnect, an old continuation must not create a publisher, advance a revision or send
  an initial frame.
- `desktop-continuous` stays direct continuous; `web-remote-replayable` recovers only via replayable
  snapshot/gap/resync.
- Workspace isolation always uses `workspaceIdentity?.trim() || workspacePath`; paths only serve as execution cwd.
- Every timeout has an owner, budget, cancellation propagation and a late-result policy; the default 3-minute
  client watchdog alone is not enough.

## 7. Verification record

Baseline: `node scripts/check-workspace-freshness.mjs` passed (branch ahead 31 / behind 3 of `origin/main`).
`v4-gateway.test.ts` + `v4-cold-resume.test.ts` have 4 pre-existing failures (3 cold-integration sendText, 1
stale retry); the remote-identity one relates directly to C19 and needs separate attribution. The R1 and R2
temporary probes exposed the issues as expected and were deleted; no runtime code was changed.

## 8. C01-C20 execution results (2026-08-28)

C01-C20 were run as a finite case matrix (not exhaustive Promise micro-timing); probes were added locally and
removed after the run.

| Case | Result                          | Evidence / conclusion                                                                                          |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| C01  | race exposed                    | two legacy resumes with the same `sessionId` created 2 apps. Confirms R2.                                      |
| C02  | race exposed                    | concurrent resumes with different `runtimeModel` still created 2 apps; model config cannot replace an activation owner. |
| C03  | wrong semantics exposed         | cold hydration read throw still returns a successful empty snapshot. Confirms R1.                              |
| C04  | pass                            | desktop continuous and mobile replayable concurrent subscribe call activation once; first snapshots equal.      |
| C05  | race exposed                    | `disposeSession` before activation ends: the old continuation still creates a publisher and returns a snapshot. Confirms R4/C05. |
| C06  | pass                            | `rowsRange\|\|subscribe` and command/query during READY share the existing gate; no duplicate activation.      |
| C07  | pass, contract must stay        | a command before READY registration returns `proto.sessionNotFound`: current "snapshot at call start" semantics, not auto-wait. |
| C08  | pass                            | `attachment/begin\|\|subscribe\|\|command` share one activation; begin not waiting for hydration is pinned.    |
| C09  | pass                            | `attachment/read` waits for host activation + projection hydration when detached/cold.                          |
| C10  | semantic risk exposed           | a warm publisher's persisted-read failure is swallowed and a snapshot still returns, with a `v4.hydrate` error logged; low impact when the body is not cleared but error/success are indistinguishable. |
| C11  | pass                            | live queue/stream in the hydration await window merges back; seq stays monotonic.                              |
| C12  | pass                            | `waitForSessionIdle` 5 s timeout fails closed, does not resend the queue item, and does not send a new turn while the old lock is held. |
| C13  | pass                            | the promotion lease for stop/foreground execution id change prevents notification preemption.                  |
| C14  | pass                            | after the 25 s projection-commit timeout failure is final; late raw events no longer apply.                    |
| C15  | pass                            | physical wire 30 s assembly timeout recovery/fail-closed cases pass.                                           |
| C16  | pass                            | the UI session data layer drops old-generation ACK/frame after runtime restart / transport replace.            |
| C17  | partial pass                    | the restore helper returns matching results for two interleaved deferred restores, but has no shared owner, so it cannot prove the upper store/broadcast has no old-snapshot overwrite. |
| C18  | pass                            | provider registry -> cold subscribe order, model-switch cache and stale-model protection pass.                 |
| C19  | partial pass                    | UI/service remote `workspaceIdentity` isolation passes; the cold-resume integration remote identity + sendText still hits the branch's pre-existing failure. |
| C20  | low-risk selection issue exposed | usage binds an arbitrary first active client; if it is disposed mid-request the request fails without switching to a second healthy client. |

Extra timeout check: `PROTOCOL_V4_LIMITS.conversationQueryTimeoutMs=10_000` still has no consumer; the
`ZCodeProtocolClient` default watchdog test confirms 180 s. R3 is a statically confirmed contract gap; no
real 10 s slow-query integration test yet.

Test totals: bootstrap 7 files, 246 tests, 242 passed, 4 pre-existing failures (3 cold-integration sendText,
1 stale retry/file rewind); services 4 files, 118 passed; UI 6 files, 172 passed (plus a temporary C17
deferred probe); shared/client/task-index 4 files, 126 passed.

Conclusion: R1, R2 and R4/C05 are reproduced defects; C10 and C20 are risks needing product-semantics
decisions; the C19 remote sendText failure is attributed separately from this resume race.

## 9. R1, R2, R4/C05 fix design (pre-implementation spec)

### 9.1 State owners and boundaries

State is not centralized in the V4 gateway or the renderer. Runtime lifecycle and projection recovery are
two different state machines:

```text
workspaceKey + sessionId
        │
        ▼
┌──────────────────────────────┐
│ SessionActivationRegistry     │  CLI / protocol server, shared by legacy + V4
│ idle → activating → active    │
│       ↘ failed / cancelled    │
│ flight: promise + generation  │
└──────────────┬───────────────┘
               │ activation result (sole runtime owner)
               ▼
┌──────────────────────────────┐
│ V4 projection gate            │  gateway, ready/hydration only
│ idle → hydrating → ready      │
│       ↘ failed / cancelled    │
│ publisher / raw seq / buffer  │
└──────────────────────────────┘

deactivate / dispose
        │
        └─ invalidate generation + abort
             └─ the old continuation checks its token and may only noop / reject
```

| State                                        | Authority                                                                                            | Must not take on                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| runtime activated, record/app owner          | `context.sessions` + `SessionResidentPool`, writes serialized by `SessionActivationRegistry`         | gateway `readyFlights`, UI pending overlay                             |
| activation concurrency                       | `activationFlights` shared by protocol server/bootstrap, keyed by `workspaceKey + sessionId`         | living only in the V4 gateway (legacy `session/resume` bypasses it)    |
| V4 hydration/READY                           | gateway projection state, `readyFlights`, publisher/raw sequence                                     | deciding whether a runtime exists                                      |
| durable history                              | persisted session/event store                                                                        | treating a read failure as an empty array                              |
| command admission/idempotency                | CLI `CommandInbox` + durable command facts                                                           | renderer ACK or a second queue built by the gateway                    |
| UI stale-request filtering                   | UI local generation/pending overlay                                                                  | being the source of truth for session/runtime                          |

`workspaceKey` is uniformly `workspaceIdentity?.trim() || workspacePath`; remote workspaces also pass
`workspaceIdentity` and `remoteSessionId` end to end; never key activation on path or a bare `sessionId`.

### 9.2 R1: persisted hydration must fail closed

`performHydration` currently turns a `loadPersistedEvents` exception into a successful empty projection,
disguising "read failed" as "history truly empty" and giving subscribers `ack.mode=snapshot, revision=0`.

1. `performHydration` keeps the original error cause, converts it to a typed V4 fault carrying session/key,
   and throws; it must not return `events: []` as an error fallback.
2. The gateway records `idle | hydrating | ready | failed | cancelled` and a generation per key. On failure
   it cleans only **the same flight**, creates no publisher, writes no initial frame and advances no
   revision; the next request retries with a new generation.
3. A durable store's "successful empty result" and "read failure" must be distinguishable in type, logs and
   wire semantics. Logs are diagnostics and do not rewrite the protocol result.
4. If a healthy warm publisher exists, whether the old snapshot may still be returned must be written into the
   call contract: entries needing a fresh durable read still fail; errors are not swallowed unconditionally.
   Desktop `continuous` and mobile `replayable` follow the same fail-closed boundary.

### 9.3 R2: activation single-flight at the shared runtime owner

`activateSessionForResume` has no shared promise between `waitForDeactivation`, persisted read and
materialize, so two legacy resumes can both see "no record", each create an app, and the last
`context.sessions.set` overwrites the first.

1. Add a bootstrap/protocol-server-level `SessionActivationRegistry` (or an equivalent shared owner) with at
   least `ensureActivated(key, hints, signal)` and `invalidate(key, reason)`.
2. `ensureActivated` does a synchronous get-or-create of the flight before the first `await`; later callers
   await the same promise. The flight does: wait for deactivation -> re-check `context.sessions` ->
   load/materialize -> register record/app -> `resume`. Legacy `session/resume`, the V4 cold gate and the
   attachment/host bridge must all call this entry.
3. `finally` cleans the map only by identity/generation check; an old flight must not clear a new one. A
   rejected promise is not cached; the next request retries with a new flight.
4. Concurrent `runtimeModel` hints must not be last-writer-wins. Suggestion: the persisted model is canonical;
   without one, the first activation caller decides and later conflicting callers must not rewrite an
   activated runtime (add a typed `session.activationConflict` fault if the product needs explicit
   feedback). This policy goes into the protocol spec and tests.
5. If the generation is invalid when activation succeeds, the app is not registered as current owner;
   best-effort close/cleanup the new app and return cancelled/stale to waiters, leaving no invisible runtime leak.

`readyFlights` may stay, but only as the V4 projection barrier for "activation + hydration"; it must not
become a second runtime owner nor let the gateway materialize a session itself.

### 9.4 R4/C05: cancellation, generation and late continuations

`ColdSessionResumeCoordinator.clear()` only clears the map and does not cancel the underlying Promise;
`disposeSession`/`deactivateSession` also do not invalidate in-progress activation/hydration continuations, so
after dispose an old continuation can recreate a publisher and emit a snapshot.

1. Activation and hydration flights carry `{ operationId, generation, AbortController, state }`.
   `disposeSession`, `deactivateSession` and gateway dispose first call the shared `invalidate(key)`, then
   delete derived state such as publisher/buffer.
2. Check the token before and after every side-effecting await: at least load complete, buffer creation,
   `ensurePublisher`, writes to `hydratedSessions`/`rawSequenceStates`, and the initial frame flush. A
   non-current token may only noop/reject.
3. Pass `AbortSignal` into host/store/app APIs that accept it; for uncancellable third-party Promises the
   generation check remains the required safety fence.
4. Dispose during unfinished activation: the subscriber must get a typed cancelled/disposed error, not a
   successful snapshot. If the app is created afterwards, the activation owner must close it and the old
   `finally` must not touch the new generation.
5. `clear()` must not only do `flights.clear()`; at least cancel and mark all flights by key, and pair cleanup
   with flight identity.

### 9.5 Implementation order and tests to add

Fix the temporary probes into permanent tests first, then change the implementation:

- R2: repeat C01/C02 (same/different model); assert app creation count 1, unique record identity, deterministic
  conflict-hint behavior.
- R1: C03/C10 read failure must reject with no frame/revision write; after the store is repaired a new
  generation retries successfully; a successful empty history still returns normally.
- R4/C05: run dispose/deactivate/gateway dispose before and after each await window of activation/hydration;
  assert no publisher, no initial frame, no old map write, no stale runtime leak; also cover an old flight's
  `finally` running after a new flight.
- Regression: desktop `desktop-continuous` and web `web-remote-replayable` concurrent entries, remote identity,
  attachment and command FIFO all go through one activation owner; replayable recovery semantics must not
  spread into the desktop main path.

Write the unit/integration tests first, then runtime code; afterwards run `pnpm typecheck`, `pnpm lint` and
the affected E2E.
