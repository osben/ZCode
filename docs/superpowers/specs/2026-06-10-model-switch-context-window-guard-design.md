# Model Switch Context Window Guard Design

Product rule: when the current session's used context exceeds the target model's effective input budget, a model switch must not happen directly — compact with the current model first, and switch only after fresh usage proves it fits. V4 composer previously called `switchModelConfig` directly with no guard (legacy toolbar had one) — a `bug-candidate`; this spec is the source of truth for the intended behavior.

Semantics adjustments versus the old guard: a running task is no longer rejected. The confirm button reads "立即停止并压缩" ("stop now and compact"); the CLI atomically stops current foreground work, freezes but preserves the existing queue, and runs this guard compact ahead of the queue. Plain `/compact` keeps its FIFO and is unaffected.

User rulings (2026-07-15), folded into the rules below:

- Running task + insufficient window → offer "stop now and compact": after confirmation, stop foreground work; no implicit UI intent waiting for the turn to finish naturally.
- Existing queue does not block the guard compact; the compact preempts the queue without deleting or reordering it.
- Only the model-switch guard has preemption semantics; plain `/compact` FIFO (A08/B13) is unchanged.
- After success, the queue returns to its pre-guard state: previously `autoDrain=true` resumes consuming after the switch lands; previously held stays held.
- Compact failure or still-over-window → safe stop state: no model switch, stopped turns stay stopped, queue preserved and held.
- An in-flight auto compact is not duplicated: wait for its terminal state, re-check usage, never interrupt or start a second compact.

Goals:

- Guard applies only to model selection on an existing active session; draft-workspace default model selection is unchanged.
- Before switching, test `currentUsedTokens > targetEffectiveContextWindow`.
- Insufficient window shows a confirmation dialog: "压缩" ("compact") when idle, "立即停止并压缩" when running.
- Idle: compact immediately with the current model. Running: atomically stop foreground work, then compact.
- The guard compact ignores existing queue/held choices but preserves queue contents, order, and submitter info.
- Switch only after compact succeeds and fresh usage fits the target budget.
- After a successful switch, resume queue consumption only if `autoDrain` was true before the guard.
- Desktop continuous and mobile web-remote replayable share the same CLI session/command state machine.

Non-goals: plain `/compact` FIFO unchanged (append to tail when running, to held queue when held); auto compact thresholds and lifecycle unchanged; no guard for draft sessions; no queue item deletion/edit/reorder; no auto-resume of stopped assistant turns, tool work, or goal continuations; no forced "switch anyway" escape; no guard/queue/compact/model-switch business state in relay, desktop main, or remote bridge.

Domain scope and high-risk cross-products:

| Domain                   | State owner                                                    | Responsibility here                                                                      | High-risk crossings                                                                        |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| V4 composer/model config | `packages/ui/src/v4/SessionPane.tsx` + CLI `switchModelConfig` | resolve target, show confirmation, consume authoritative projection, submit final switch | late selections, revision CAS, custom/native provider metadata                             |
| Context usage/compact    | CLI session runtime + V4 projection                            | compact with the current model, produce marker and fresh usage                           | compact ACK ≠ completion, duplicate compacts, failure/cancel                               |
| Stop/queue               | CLI command core                                               | freeze auto-drain, stop foreground work, preserve queue, make guard compact preempt FIFO | late stop terminals, held queue, input added while running, goal pause                     |
| Client delivery          | shared host/CLI session                                        | desktop continuous and mobile replayable observe the same command facts                  | reconnect, model changed on the other end, `workspaceIdentity`/`remoteSessionId` isolation |

Current facts:

- Model entry: `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` hands selections to `onSelectModel`; model write goes through `switchModelConfigWithRecovery` with revision CAS in `packages/ui/src/v4/SessionPane.tsx`.
- Authoritative usage: `usage.contextWindow.usedTokens/maxTokens/autoCompactThresholdTokens` in `packages/shared/src/zcode-protocol-v4/snapshot.ts`.
- Target metadata: `ModelProviderModelConfig.contextWindow/maxOutputTokens`; `resolveModelProviderContextWindow()` owns fallbacks and `[1m]`.
- Plain compact: `commandPayloadSchemas.compact` is an empty payload; CLI `goal-compact.ts` appends it to the FIFO when busy/held.
- Stop: CLI `session-flow.ts` pauses the active goal, then aborts the current controller; B02–B04 require queue preservation and auto-drain off.
- Projection: a command ACK proves admission only — the guard must wait for the compact marker terminal state and subsequent fresh usage, never treat ACK as compact success.
- The legacy `manual-review/pending/conversation-session-model-switch-auto-compact.test.ts` is historical evidence, not current V4 coverage.

Budget rule (aligned with agent auto compact policy):

```text
outputReserve = positive(maxOutputTokens) ?? 64_000
effectiveReserve = min(outputReserve, contextWindow)
targetEffectiveContextWindow = max(0, contextWindow - effectiveReserve)
needsGuard = currentUsedTokens > targetEffectiveContextWindow
```

- native/custom/`modelIdByKind` all resolve through the same target metadata path; `[1m]` models reuse `resolveModelProviderContextWindow()`.
- Missing/invalid current usage or target metadata keeps the legacy fail-open (stale metadata never wedges existing switches); covered by unit tests, not an E2E matrix.
- Missing/invalid post-compact usage is fail-closed: without proof it fits, do not switch.

Product state and sequence:

```text
desktop-continuous / web-remote-replayable renderer
                         |
                  select target model
                         |
             resolve target effective budget
                         |
             +-----------+-----------+
             | used <= budget        | used > budget
             v                       v
       switchModelConfig CAS    confirmation dialog
                                     |
                     +---------------+---------------+
                     | idle/completed                | running/stoppable
                     v                               v
              button: “压缩”              button: “立即停止并压缩”
                     |                               |
                     +---------------+---------------+
                                     |
                         guard compact command
                                     |
             CLI: snapshot previous autoDrain + set false
                                     |
             CLI: stop foreground work + wait active lock idle
                                     |
             CLI: start compact before every preserved queue item
                                     |
                  compact terminal projection + fresh usage
                                     |
                revalidate session / selection / revision
                         +-----------+-----------+
                         | fits                  | failed/stale/too large
                         v                       v
              switchModelConfig CAS       keep old model
                         |                 keep queue held
              restore autoDrain only
              when it was previously true
```

Command/protocol design:

- The renderer must not send `stop` + plain `compact` as two commands: between them the queue can auto-drain or another client can insert commands, and plain compact lands at the FIFO tail anyway.
- The strict command schema exported from `packages/shared/src/zcode-protocol-v4/index.ts` gains a dedicated preemption command (suggested name `preemptCompact`):
  - Must carry `baseRevision`; stale confirmations are rejected before the CLI starts the destructive stop.
  - `commandId` is the idempotency boundary; an existing manual/guard compact running or queued returns `compactOperationLock`.
  - CLI command core, in one adjudication: read the original `autoDrain`, set it false, apply the existing Stop semantics (pause goal, abort the foreground controller), wait for idle, then call the single `startManualCompact` path.
  - The preemption command never enters the plain input FIFO; queue items are preserved verbatim. Input arriving during the compact still enqueues and cannot interrupt it.
  - The compact terminal state is expressed by the existing timeline marker/usage projection; no new relay/main state.
  - The renderer calls the existing `switchModelConfigWithRecovery` only when the compact succeeded, fresh usage qualifies, and the original session/selection is still valid.
  - After a successful switch, `setAutoDrain(true)` runs with the new revision, only if it was true before the guard. On failure, unknown usage, or still-over-window, auto-drain is not restored.
  - If the initiating renderer disconnects after the compact, the CLI keeps the old model and held queue; on reconnect the user continues from the authoritative projection — no ghost model switch.

UI behavior:

- The dialog appears only for `needsGuard=true`. Idle title stays "需要压缩上下文后再切换模型" with button "压缩"; running/stoppable explains that the current response stops immediately and the queue is preserved, with button "立即停止并压缩".
- Cancel/Esc/overlay close stops nothing, compacts nothing, switches nothing.
- While the guard runs, repeat confirmations of the same action are disabled and the existing compact lifecycle is shown; no fabricated user message.
- If the user selects a different model in the same session while waiting, the old target's selection token is invalidated; an already-started compact may finish, but the old target must never late-override the new selection.
- Switching to another task lets the original session's compact finish per CLI facts, but never switches the model on the new task.
- Desktop, Web, and mobile Web share components and i18n per `DESIGN.md` (existing ConfirmDialog, semantic colors, compact sizes, both themes, responsive).

Dimensions and pruning:

| Dimension     | Equivalence classes                                                               | Handling                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Session phase | draft / completed / running / compacting                                          | draft pruned; completed and running accepted; existing auto compact reuses N14                                                        |
| Queue         | empty / auto-drain queue / held queue                                             | all three kept; counts `1/2/3+` fold into the "contents and order unchanged" invariant, representative value 2                        |
| Guard result  | cancel / compact success fits / success still too large / failed or usage unknown | cancel, fits, and fail-closed must all be proven                                                                                      |
| Client        | desktop continuous / mobile replayable                                            | same product semantics, separate projection evidence; replay-gap logic stays out of desktop                                           |
| Provider      | native / custom / mapped runtime id / metadata unknown                            | resolver pairwise in unit tests; E2E uses a controllable native fixture                                                               |
| Active work   | assistant output / tool or goal foreground / independent background work          | shared existing Stop-foreground invariant; background work's stop scope is not widened                                                |
| Workspace     | local / SSH-WSL-Docker identity                                                   | commands isolated per session; remote validated via `workspaceIdentity + remoteSessionId` focus, not a full OS/provider cross-product |

Pruning decisions: plain `/compact` × preemption pruned (command-entry invariant; A08/B13 unchanged); queue-count full cross-product pruned (queue is neither deleted nor reordered; representative value suffices); draft × guard pruned (no active session usage); unknown metadata × E2E pruned to resolver unit tests (product stays fail-open); provider × desktop/mobile pruned (metadata resolver and delivery projection proven in layers); direct V4 switch to an undersized model is the `bug-candidate` closed by N05/N09–N14 once implemented.

Accepted cases:

| ID  | Setup                                                                              | Action                                                                                    | Assertions                                                                                                                            | Evidence                                                               |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| N05 | completed, queue=0, used over target budget                                        | select target, then cancel/confirm                                                        | cancel changes nothing; confirm compacts with the old model; switch only after fresh usage fits                                       | dialog, compact request/marker, snapshot usage/config                  |
| N09 | running, queue=0, used over budget                                                 | click “立即停止并压缩”                                                                    | foreground turn interrupted; guard compact then starts; switch after success                                                          | stop/compact timeline, provider request model, config projection       |
| N10 | running, queue=2, autoDrain=true                                                   | confirm guard                                                                             | queue contents/order unchanged; compact runs ahead of the queue; auto-drain restored after switch; queue consumed by the target model | CLI queue projection, request order, model config                      |
| N11 | completed/interrupted, queue=2, autoDrain=false                                    | confirm guard                                                                             | no held-queue clear/keep dialog; compact starts immediately; queue stays held; the switch triggers no consumption                     | inputRouting, queue IDs/order, compact/config projection               |
| N12 | running or completed, compact failed/cancelled, usage unknown or still over budget | confirm guard                                                                             | no switch; stopped turn not resumed; queue preserved and held; clear user feedback                                                    | failed marker, usage/config, queue autoDrain                           |
| N13 | guard confirmed, compact pending/running                                           | new model selected in the same session, task switch, or config updated from the other end | the old selection token must not late-switch the wrong model/task; the newest selection wins per latest config/revision               | command/revision, session-scoped projection, final config on both ends |
| N14 | auto compact already running, target context insufficient                          | select model                                                                              | no stop, no second compact; wait for the existing compact, re-check, then apply the latest valid selection                            | single compact lifecycle, pending selection, config CAS                |

Error handling:

- Preempt command rejected for stale revision: no stop, no compact; re-evaluate from the latest snapshot.
- Operation lock: no duplicate compact; an existing auto compact is awaited then re-checked; another manual compact's terminal state is reused without faking success.
- Compact start failure after stop: old model unchanged, queue held, interrupted/failed facts preserved.
- Compact succeeds but fresh usage invalid or still over window: old model unchanged, queue held, toast explains the cancelled switch.
- Later model switch failure: existing model-config error handling; auto-drain not restored.
- `setAutoDrain(true)` restore failure: the completed model switch is not rolled back; queue stays held with a prompt for the user to continue manually.

Test and E2E handoff:

- Docs precede tests: update `docs/conversation-session-case-catalog.md` and `docs/testing/conversation-session-e2e-coverage-matrix.md` first, marking N05/N09–N14 `planned`; the legacy MG pending spec must no longer be recorded as coverage.
- Unit/integration: metadata resolver (native, custom, `modelIdByKind`, `[1m]`, `maxOutputTokens`, 64k fallback, unknown fail-open); budget/guard (fits, cancel, completed compact, running preempt, failed/unknown/too-large fail-closed); command core (stale revision has no side effects, queue preserved/ordered, goal pause + controller idle barrier, compact operation lock, plain compact FIFO regression); UI (button per phase; late selection/task/revision does not apply the old target); delivery (both clients settle from the same CLI command/projection; remote identity never matches by `workspacePath` alone).
- E2E: case-local provider fixtures build a small target context window and post-compact usage — no reliance on production models. N05, N09, N10 first as formal coverage; N11–N14 start in manual-review/pending and promote once evidence stabilizes. Desktop formal E2E proves UI, provider request order, and queue/config projection; mobile replayable uses focused service/integration cases for the same command facts, disconnect recovery, and identity isolation. "Path passes through running/queue" never substitutes for setup/action/assert — every covered case must show stop, compact, usage, switch, and queue results separately.

Acceptance criteria:

- Selecting an undersized model on a completed session asks to compact first; cancel changes nothing.
- A running session's confirm button is "立即停止并压缩"; confirming stops the current foreground work.
- Regardless of queue presence or held state, the guard compact preempts the queue immediately while queue contents and order stay intact.
- The compact uses the pre-switch model; the switch happens only after fresh usage fits.
- After success only a previously-on auto-drain is restored; a held queue is never started implicitly.
- Compact failure, unknown usage, or still-over-window keeps the old model and held queue.
- Plain `/compact` running/held FIFO shows no regression.
- Desktop continuous and mobile replayable observe the same stop/compact/model/queue facts with no relay/main business state.
