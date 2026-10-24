# V4 Cold Resume: Decoupling Runtime Activation from the Legacy Snapshot

> Status: accepted 2026-07-24; single materialization added 2026-08-13; history-readiness vs
> runtime-readiness added 2026-10-09.
> Scope: first cold subscription of a V4 conversation. The legacy `session/resume` protocol is not removed
> and Bot real-time subscription is not migrated.

Full history: `git show b8876e8b:docs/v4-refactor/17-cold-resume-runtime-activation.md`

## 1. Problem

Before this change, the first open of a persisted session after a CLI cold start went through legacy
`resumeSession`:

```text
v4/conversation/subscribe
  -> legacy cold-resume adapter
  -> legacy resumeSession
       ├─ create record / runtime
       ├─ restore workspace, model, thought, mode, restoreWarning
       ├─ app.resume() and event wiring
       └─ build full ZCodeSessionStateSnapshot  ──> return value discarded by V4
  -> V4 durable transcript hydration
  -> getSessionUsageSeed
       └─ legacy readSession/full snapshot   ──> only reads runtime.contextUsage
  -> V4 initial snapshot
```

Two responsibilities were mixed: (1) **runtime activation**, which V4 commands and config seeds depend on;
(2) **legacy representation materialization**, which only the old `session/resume` response needs. V4
already builds its own authoritative snapshot from the durable transcript, session entry, memory events and
`ProductProjection`, so the legacy snapshot adds no recovery capability and only scales cost with history
size.

## 2. Target boundary

```text
                         ┌─ legacy session/resume
persisted session        │    -> activateSessionForResume
        │                │    -> build legacy snapshot -> legacy caller
        v                │
activateSessionForResume ┤
  ├─ persisted metadata  │
  ├─ workspace identity  └─ V4 cold subscribe
  ├─ record + event sink      -> activateSessionForResume
  ├─ model/thought/mode       -> V4 durable hydration
  ├─ restoreWarning           -> narrow context-usage seed
  └─ app.resume()             -> V4 initial snapshot
```

`activateSessionForResume` is a profile-independent lifecycle primitive:

- If the record exists, it does not repeat `app.resume()` or event wiring; an explicit `runtimeModel` still
  refreshes as before.
- If the record does not exist, it keeps all behavior of the original `resumeSession` before `snapshot(...)`.
- Errors (no session in store, model unavailable, runtime resume failure) match the old path.
- It does not branch on `desktop-continuous` / `web-remote-replayable`; the two split only in the V4
  publisher delivery profile after activation. The historyFirst increment is defined in §4.1.

Legacy `resumeSession` stays as a compatibility wrapper: `resumeSession = activateSessionForResume + snapshot`.
Legacy callers, Bot legacy state reads and test semantics are unchanged; only V4 cold subscribe calls the
activation-only primitive.

## 3. Invariants that must not regress

| Invariant                     | Constraint                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| historyReadyBeforeRuntime     | A connection supporting historyFirst gets persisted history first; execution and runtime config/usage seed open only after runtime completes |
| historicalConfigPreserved     | Historical model, thought, mode keep restoring from the session-local durable selection first                                                |
| restoreWarningPreserved       | An unavailable historical model still allows reading history, but later `sendText` is rejected by the same restore-warning gate              |
| workspaceIdentityPreserved    | Remote resume keeps using the persisted `workspaceID`; the identity key never degrades to `workspacePath`                                    |
| eventWiringPreserved          | The event sink, persistence and MCP/runtime wiring built by `createRecord` are unchanged                                                     |
| timestampsAndParentPreserved  | `createdAt`, `updatedAt`, `parentSessionId` keep backfilling from the persisted session                                                      |
| v4HistoryAuthorityUnchanged   | rows, reasoning, tool, plan, goal, queue and interaction are still restored by V4 durable materialization + memory tail                      |
| deliveryBoundaryUnchanged     | desktop stays continuous; mobile/Web remote stays replayable gap/snapshot recovery                                                           |
| restartDiscardUnchanged       | Non-terminal input of the previous runtime is still discarded per the delivery ledger; never auto-replayed                                   |
| legacyResumeResponseUnchanged | `session/resume` still returns a full, schema-equivalent legacy snapshot                                                                     |
| v4ColdReadySingleOwner        | The V4 gateway owns history-ready and runtime-ready; one initialization per session is single-flight                                         |
| hydrationBoundaryUnchanged    | `hydratePublisher` only does projection hydration and does not take over each entry's existing runtime-activation preconditions              |
| registryIsNotV4Readiness      | `context.sessions` only registers a record; query/command must not be released on it before the V4 cold operation completes                  |

Pending permission/elicitation and the current runtime queue are not durable facts an old process can
unconditionally revive; this change does not add, remove or rewrite them. The new runtime's V4 memory event
tail remains the online authority.

## 4. Narrow usage projection

V4 cold resume must not call `readSession` just for `runtime.contextUsage`. The narrow projection reuses the
legacy snapshot's computation:

```text
runtime projection contextUsed/contextWindow
  + active-branch persisted context usage/cache
  + latest matching main-turn ModelComplete breakdown
  -> ZCodeSessionContextUsage
  -> SessionUsageSeed
```

- Non-zero runtime `contextUsed` wins; otherwise fall back to the latest assistant tokens or compact
  boundary of the active branch (see `docs/context-window-usage-state.md`).
- Cache totals count only non-summary assistant messages of the active branch; a compact boundary seed does
  not revive pre-compaction cache.
- The breakdown accepts only the latest main-turn `ModelComplete` whose `used/contextWindow` align with the meter.
- Non-positive used/window returns `null` ("no model round trip yet").
- It does not read or map legacy messages, settings, todos, goal, slash commands or model availability.

### 4.1 History first (2026-10-09)

```text
subscribe → durable messages M0 → same V4 publisher → first frame enters transport outbox
                                                          ├─ UI history readable, text draft editable
                                                          └─ runtime activation(M0)
                                                               ├─ ready → align projection, open execution
                                                               └─ failed → keep history, manual retry
```

- Capability name `historyFirst`, carried in hello/clientHello and the trusted attachment; subscriptions
  without it still wait for full recovery.
- The history-phase ACK records `historyReadyMs`; the old path keeps `cliSessionRestoreMs`; full activation
  time follows the existing resume lifecycle log and is not mixed into first-paint time.
- Snapshot/state patch gains optional `runtimeInitialization`: `initializing | ready | failed`, with
  `attemptId`; failed adds structured `reasonCode/message`. Absence means the old protocol's full-ready
  semantics; no new run phase.
- Subscribe may carry `retryInitialization` (the observed failed attemptId); only a match with the current
  failed attempt starts the next one, and duplicates coalesce. A plain reconnect does not rerun a failed
  attempt; no new RPC.
- First history depends only on persisted materialization (active branch, goal/plan, existing reducer); it
  does not call the runtime or fake an executable model state. Details, attachments, workflow catalog and
  App interaction wait for ready.
- A normal recovery reads parent messages fully once; M0 is shared only within that recovery call stack;
  M1 may be read only after the runtime repairs an interrupted compact. A retry re-reads persisted facts.
  No new DB schema, global cache or TTL.
- Activation is scheduled after the first frame enters the existing post-response outbox; no fixed sleep or
  bare Promise.all to mask synchronous plugin scanning. History load failure remains a subscribe failure and
  never shows a fake empty history.
- The gateway is the sole two-phase owner; registering in context.sessions is not ready. During
  initialization, new execution commands are explicitly rejected and do not enter the accepted input queue;
  existing command query/dedupe semantics are kept.
- Initialization events and final hydration use the same publisher; ready is declared only after aligning
  memory tail, source seq, compact repair and latest config. The UI keeps no second transcript.
- Failure cleans only this attempt's half-initialized record, event sink and app, keeping the history
  publisher. An explicit retry reruns the full resume (including the SessionStart hook); rollback of hook
  external side effects is not promised.
- Switching away after initialization starts does not force-cancel the lifecycle; a late result after
  close/generation change must not update a new publisher. A record under initialization must not be
  reclaimed by residency.
- Warm/live/detached child reuse the original flow: no second runtime, no change to task time, taskType or
  global model defaults.
- desktop continuous and mobile replayable share one recovery owner and keep their own gap/snapshot,
  workspaceIdentity/remoteSessionId and subscription watermark boundaries.

### 4.2 UI and impact

- SessionPane/ConversationComposer: the history snapshot controls the body, `runtimeInitialization` controls
  execution. No hint bar during initialization; only on failure an error and retry above the input box.
  After retry the error hides; draft and scroll are kept.
- Workflow journal, model operations, attachments and App entries query/interact after ready and must not
  start the runtime ahead of the first subscribe.
- Gateway/bridge/resume must change (persisted history, single-flight, failure cleanup, final state
  alignment). Host/transport only pass through the new capability and subscription intent.
- sessions-index, residency, legacy/Bot, global plugin/Skills caches: regression-verify only.
- The dependency graph should distinguish history-readable from runtime-ready; the original graph lacks the
  edge "workflow query precedes subscribe" and should be updated with the implementation.

## 5. Pruned verification matrix

Not every client x every session state; activation happens before delivery-profile split, so
representative samples per invariant:

| Representative sample                        | Focus                                                                                                      | Evidence layer                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| completed local history + desktop continuous | history rows/tool/reasoning, resend, idempotency, no legacy snapshot materialization                       | bootstrap integration                |
| completed remote history                     | workspace identity, provider registry, resend                                                              | existing V4 cold-resume integration  |
| historical model/thought/mode                | session-local config and thought hint priority                                                             | existing I63 / bootstrap integration |
| model unavailable                            | restoreWarning read/write boundary                                                                         | existing bootstrap integration       |
| completed child                              | child cold hydration, read-only navigation                                                                 | SAT09 existing evidence              |
| mobile replayable                            | equivalent first complete terminal state to desktop; gap/resync unchanged                                  | PV4-06/25 existing protocol evidence |
| legacy `session/resume`                      | full snapshot and context usage preserved                                                                  | legacy protocol unit test            |
| large session PERF03                         | activation builds no legacy snapshot; normal cold subscribe reads parent messages fully once; record trend | performance fixture                  |
| concurrent V4 subscribe/query/command        | history first frame before initialization completes; zero execution admission during init; paging readable | bootstrap unit/integration           |
| READY failure                                | history and structured error kept; half-initialized record cleaned; explicit retry single-flight           | gateway unit                         |

## 6. Non-goals and follow-ups

Adjacent over-fetches not addressed here, to avoid widening the regression surface:

- V4 `createSession` / fork registration builds a legacy snapshot to obtain a few fields;
- Bot legacy continuous subscribe, attachment send and state query;
- removing legacy `session/resume`, `readSession` or the snapshot schema;
- optimizing plugin/Skills/MCP scanning, replacing the batch reducer, wire fragment or rows-window protocol.

Each should migrate per caller with its own feature matrix, not ride along with this optimization.

## 7. Measurements (2026-07-24, local; not a cross-machine SLA)

Apple Silicon, local production `app-server`, fresh CLI process per sample, same workspace/session, same
`desktop-continuous` subscribe. Baseline built from pre-change HEAD `e3efe9006ad7489b83d1efca917b3c0df32add69`
in a detached worktree; three runs each after cache warm-up. Fixture `sess_perf_large_20260724034221_af2e36b8`:
2,000 messages / 6,671 parts (about 1,000 turns); both groups produced the same 143,690-byte initial V4 frame.

| Implementation                                                        | Median cold process -> initial frame |
| --------------------------------------------------------------------- | -----------------------------------: |
| before: V4 activation builds legacy snapshot, usage via `readSession` |                            3169.5 ms |
| after: activation-only + narrow usage projection                      |                            2701.5 ms |

The median drops **468.0 ms (14.8%)**. From Agent ready, subscribe -> initial frame median is 1998.0 ms; the
rest of the ~2.7 s is about 0.69 s of process start/ready, so the wait must not be attributed wholly to
activation or the legacy snapshot. Stage probe on the same fixture (diagnostic run, not summable): persisted
messages read/decode about 56.8 ms, transcript synth about 49.9 ms, `ProductProjection` hydrate about
679.9 ms, narrow usage re-read of active-branch messages about 60.0 ms; not extrapolatable to 10,000+
message sessions.

2026-08-12, PERF03-E fixture (10,622 messages / 35,811 parts): a normal production cold subscribe
materialized parent messages 5 times (single read median 385.1 ms; 4 repeats cost up to about 1540.6 ms).
After the operation-scoped reuse of §4.1, fresh-process subscribe -> initial frame median dropped from
3991.9 ms to 2681.6 ms (-1310.3 ms, 32.8%), with the same 158038-byte frame, 29950 rows, 60-row window,
`toSeq=74164` and 0 running subagents. See
[`v4-conversation-cold-hydration.md`](../performance/v4-conversation-cold-hydration.md#perf03-h-单次冷恢复物化2026-08-12).

## 8. History-first acceptance (2026-10-09)

The gateway's per-recovery promise shares M0 and the old activation coordinator keeps runtime single-flight.
Persisted metadata/target/entries and the memory tail are still read fresh; the usage seed aligns after the
live buffer is filled; parent materialization does not spread to children. Plain core and legacy resume do
not inject M0. Normal initialization/failure retry align via state patch; only a real history structure
change (such as compact repair) uses a snapshot boundary, so a tail-window snapshot does not discard rows
the UI already paged.

### 8.1 Run and regression evidence

- After removing the initialization hint bar: Composer regression 17/17 and pending HF01/HF02 2/2 pass
  (run `desktop-e2e-20261009124509259-p39833-e0ca33f5fc0a7314`). During the barrier: no hint bar, draft
  editable, send disabled; failure still shows error and retry; ready is judged when the send button is available.
- macOS Electron, rebuilt CLI and Desktop: HF01/HF02 pass (final run
  `desktop-e2e-20261009122057441-p88058-2c6e51fda3f594c9`). HF01 uses a real SessionStart file-event barrier
  and verifies readable body, editable draft, disabled send and resend after release. HF02 corrupts a
  branch field of the isolated fixture after M0 is shown, goes through the real final-materialization
  failure path, and verifies the error bar, kept history/draft/scroll, and that after repairing the data a
  double-click retry runs the resume hook exactly once more.
- Gateway/publisher/cold-resume/cold-event-merge: 117 of 120 pass; 3 legacy model/thought restore
  assertions fail and reproduce on baseline `23819deddc`; an existing gateway stale-vs-executionFailed
  assertion also fails on baseline and is not widened here.
- UI/Host capability negotiation and connection isolation: 77/77; status bar: 17/17. Root related scan:
  14,036 pass, 1 source assertion failed and passed after being updated for the ready gate.
- Root typecheck/lint, CLI 30-package typecheck, architecture check, fixture check and open-source word check
  pass. CLI lint is not fully green: 20 Bootstrap max-lines errors exist on baseline too.
- The new E2E stays pending (not promoted or added to the Docker gate). Not run on physical phones, SSH,
  Windows or Linux; continuous/replayable, workspace identity, compact/rewind and warm/child evidence comes
  from protocol/integration regressions and is not a full remote-control network acceptance. UI performance
  with very large histories was not re-measured.

### 8.2 Same-condition first-frame comparison

Apple Silicon / Node 24; same isolated SQLite fixture (2 messages), fresh CLI process and HOME per run,
three alternating runs, a valid Personal Provider, asserting the ready frame keeps the fixture's model
selection. Baseline built from the Bootstrap and shared sources of `23819deddc`; both CLIs use the same
resource directory (15 plugins discovered, 11 enabled). Timing starts at subscribe after the
`runtime/capabilities` response, with a real SessionStart hook fixed at 2 s. This is a controlled sample,
not a natural cold-start percentage or a UI first-paint measurement.

| Boundary                         | Before (ms)        | After (ms)         | Median before -> after |
| -------------------------------- | ------------------ | ------------------ | ---------------------- |
| subscribe -> CLI history frame   | 3349 / 3094 / 2834 | 12 / 37 / 17       | 3094 -> 17             |
| subscribe -> runtime ready frame | 3349 / 3094 / 2834 | 3541 / 3305 / 3583 | 3094 -> 3541           |

The first frame no longer waits for the runtime; full initialization is not improved. Plugin discovery was
607-992 ms before and 1020-1236 ms after in this fresh-HOME sample; that stage was not optimized and the
small single-machine sample is not a cross-machine SLA. An earlier comparison used a temporary baseline that
did not discover the built-in plugins and was discarded. The Desktop hook uses an event barrier (not the 2 s
timer), and its timing includes test checks and manual barrier release, so it is not mixed with the CLI sample.
