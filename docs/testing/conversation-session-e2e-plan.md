# Conversation Session E2E Plan

Goal: turn the conversation-area state enumeration in `docs/conversation-session-case-catalog.md` into WDIO E2E, and layer the live desktop verification apart from the Docker replay verification. Tests must enter through the user path: API Key login, configure the DeepSeek provider, switch to `deepseek-v4-flash`, then operate the conversation area.

Per-case coverage status: [conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md). That matrix marks an entry as automated coverage only when it has an explicit setup/action/assert, so "the scenario path passed through some state" is not mistaken for "the case is verified".

The goal-related combinations have been split from the main path into a finer dedicated matrix: [conversation-session-goal-specific-coverage-matrix.md](./conversation-session-goal-specific-coverage-matrix.md). `H` in the main matrix denotes only the basic goal protocol and cannot replace the goal combinations with queue, compact, fork/edit, session/model and environment anomalies.

## Current reporting basis

"All tests pass so the conversation area is fine" cannot be claimed. The accurate basis: the written WDIO specs can report a pass rate by their own commands, while the formal case catalog must still be counted case by case against the coverage matrix.

As of the matrix at that time, A-J has 153 cases, all accepted; 104 have automation evidence, 49 are still missing accepted cases, and the failing probe and undefined cases are 0. So "a test command all passed" only means that batch of specs passed; describing the formal matrix must report accepted, covered, partial and missing together, and pending legacy evidence or a single-batch run must not be widened into "the formal gate is closed".

The product semantics of F09, G11 and G12 were ruled on 2026-07-05 and are no longer undefined; entries that have not yet become stable automation stay as `missing` in the coverage matrix.

External environment faults are not counted in the A-J main-path statistics and are tracked separately in [conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md). That catalog currently has 40 product fault rows and 4 test-infrastructure cases; 3 of them are environment-view aliases of `F09/G11/G12` and were ruled accepted/missing with their source cases; after de-duplication the 37 newly added external-fault product cases remain `decision-needed` and cannot be written directly as stable passing assertions.

## Layers

| Layer                  | Purpose                                      | How to run                                                                                                       |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| desktop capture        | Connect to live DeepSeek, verify the real desktop chain | `E2E_PROVIDER_HTTP_MODE=capture E2E_PROVIDER_API_KEY=... pnpm --filter @zcode/desktop test:e2e -- --spec <spec>` |
| desktop replay         | Fast local certification with recorded SSE fixtures | `pnpm --filter @zcode/desktop test:e2e -- --spec <spec>`                                                  |
| docker replay-isolated | Final reproducible certification in an isolated network | `E2E_NETWORK_MODE=replay-isolated E2E_SPEC=<spec> bash scripts/test-desktop-e2e-container.sh`               |

For now expand the desktop cases first; Docker is only a staged certification and does not block case writing.

## Manual Review flow

Conversation main-path specs first sit uniformly in `packages/desktop/test/e2e/conversation-session/manual-review/pending/`. These cases execute complex user paths automatically and generate UI / network / log / session artifacts, then a human confirms the product expectation; they take no part in the default conversation quality gate.

Flow rules:

1. A newly enumerated case, or one not yet confirmed by a human, enters `manual-review/pending/`.
2. Human review only requires that the case reach the observation point and leave evidence; not every expectation has to be hard-coded as an assertion.
3. After the product expectation is confirmed, add deterministic assertions and the needed `data-testid` / protocol / log / capture / snapshot checks.
4. Once assertions are stable, move the spec back to `packages/desktop/test/e2e/conversation-session/` and update [conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md) in sync.

The default full WDIO E2E excludes `manual-review`; these human-review cases run only when a `manual-review` spec is passed explicitly or `ZCODE_E2E_MANUAL_REVIEW=1` is set. With `ZCODE_E2E_MANUAL_REVIEW=1` and no explicit `--spec`, only `manual-review/**/*.test.ts` runs by default.

## Spec split

The short file names in the table below mix the formal specs in the default conversation-session directory with candidate specs still to be confirmed under `manual-review/pending/`. After human confirmation and promotion, a file returns to the default conversation-session directory and the coverage matrix is updated to the formal path.

| Spec                                                       | Catalog coverage                          | Current priority | Description                                                                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-session-first-send.test.ts`                  | A01, C01, C03                             | P0               | First send creates a session, next turn after completion                                                                                                      |
| `conversation-session-prewarming-queue.test.ts`            | A02                                       | P0               | When the first-turn request has been sent but the first SSE event has not returned, further ordinary text must enter the queue and must not interrupt the first turn |
| `conversation-session-running-queue.test.ts`               | A03-A08                                   | P0               | While running, ordinary text, `/goal`, `/compact` are queued by their own command kind and no parallel compact starts                                         |
| `conversation-session-running-actions.test.ts`             | A09, A10, E06 running branch, K02, K03, K10 | P0             | While running, stable assistant fork is still judged by target stability; the last real-user query can be edited and preempts the current turn, historical queries show no edit; historical assistant replies show no retry |
| `conversation-session-stop-held-queue.test.ts`             | B02-B04, B06                              | P0               | After stop the held queue is kept and not auto-consumed; further input is still appended to the tail                                                          |
| `conversation-session-stop-empty.test.ts`                  | B01, B05                                  | P0               | After stop with queue=0 enters interrupted completed, later ordinary text immediately starts the next turn                                                    |
| `conversation-session-queue-operations.test.ts`            | B09-B11                                   | P0               | Held-queue edit, reorder, delete affect only the queue itself and do not trigger consumption                                                                  |
| `conversation-session-compact-manual-queue.test.ts`        | F01, F03, F08, C08, C09                   | P0               | Manual compact coexists with a held queue; after stop the held queue is not auto-consumed and after compact success it is not auto-consumed either; with a held queue under success completed further input is only appended |
| `conversation-session-compact-actions.test.ts`             | F04-F07, H05, K05, E06 compacting branch  | P0               | During compacting, ordinary input and `/goal` are queued, duplicate `/compact` rejected, stop compact, fork forbidden                                         |
| `conversation-session-interrupted-actions.test.ts`         | D02, E02, E03                             | P0               | After interrupted, edit is allowed; a stopped assistant partial offers no usable fork entry; the held queue is kept in the parent session and not auto-consumed |
| `conversation-session-edit.test.ts`                        | D01, D03-D08, D10                         | P1               | Edit the latest real-user query and rerun, queue kept, ordinary text and `/goal` queued while running, running latest-edit preempts the rerun, assistant cannot be edited, edit rerun after interrupted raises no turnIndex parse error |
| `conversation-session-fork.test.ts`                        | E01, E04, E06 running branch, K06 user branch | P1           | assistant fork under completed success; user offers no fork; fork forbidden while running                                                                     |
| `conversation-session-tool-actions.test.ts`                | D09, E05, K06 tool branch, K07 tool branch | P1              | Use a real Read tool block to assert that the tool call block exposes no edit/fork entry                                                                      |
| `conversation-session-goal.test.ts`                        | H01-H04, H06, B07                         | P1               | goal set/update, queued while running and in a held queue; H02 updates a completed target after the verifier finishes naturally, without fabricating data from a stop terminal state; the goal continuation/verification window creates no standalone `validating` lock |
| `conversation-session-goal-queue.test.ts`                  | Goal specific G1                          | P1               | Multiple queued goals, mixed text/goal/compact, goal queue item edit/delete/reorder, consumption order of an immediate guide goal                              |
| `conversation-session-goal-session-model.test.ts`          | Goal specific G0/G1/G3/G4                 | P1               | Queued goal consumption uses the latest model/thinking depth; a running or queued goal does not leak across session switches; a new draft asserts only that it inherits no historical goal/queue; fork of a historical assistant is disabled while a goal runs |
| `conversation-session-goal-run-cases.test.ts`              | Goal manual-judgement combinations        | P1               | manual-review live probe: request capture is evidence only; updating an existing goal accepts the new goal entering the queue or the target; collection such as an ordinary input under an existing paused target not forming a running window, manual/auto compact and goal-control recovery only records the outcome |
| `conversation-session-turn-steer-probe.test.ts`            | M01-M05                                   | P1               | `manual-review/pending` candidate keeping the hard-assertion evidence of text, `/goal`, `/compact` in the first-turn running/tool window under queue behavior; takes no part in the default conversation gate |
| `conversation-session-model-switch-queue.test.ts`          | Model switch cross: queue / held queue    | P1               | Switch model before a queued text is consumed while running; switch model with a held queue after stop then "send now"; both assert the model/thinking depth at consumption by network requests |
| `conversation-session-model-switch-compact.test.ts`        | Model switch cross: manual compact        | P1               | After completed, switch to secondary then `/compact`, asserting the summary uses the secondary model; the summary's thinking level is observed by the compact chain's default-high basis |
| `conversation-session-model-switch-auto-compact.test.ts`   | Model switch cross: auto / guard compact  | P1               | Migrated to the V4 helper and stream-first assertions; N05 confirm/cancel currently stably exposes a product gap of "no guard dialog, direct model switch"; N06 asserts non-interruption only when a real trigger marker exists, and on a healthy no-op only proves that the pendingAction continues normally |
| `conversation-session-model-switch-tool-edit-fork.test.ts` | Model switch cross: tool / edit / fork    | P1               | The tool-prompt-window model switch is an executable probe first; after completed, switch model then edit/fork and assert later requests use the secondary configuration |
| `conversation-session-config-and-multisession.test.ts`     | J01-J04                                   | P1               | Multi-session concurrency, active-session visible-message isolation                                                                                           |
| `conversation-session-model-config.test.ts`                | I01-I05, J05                              | P1               | Opened and passing: asserts session-level model/thinking depth restore, new-session inheritance, queue consumption using the current session configuration, an inactive session not polluted by the active draft |
| `conversation-session-compact-interrupted.test.ts`         | F02                                       | P1               | Manual compact is still allowed under completed interrupted                                                                                                   |
| `conversation-session-compact-auto.test.ts`                | G01-G04, G08-G10                          | P2               | manual-review live probe: when auto compact triggers, assert it precedes the pendingAction; when needsCompact is not reached record a no-op and prove the pendingAction continues normally |
| `conversation-session-compact-auto-actions.test.ts`        | G05-G07                                   | P2               | When auto compact enters `started`, cover ordinary text and `/goal` queued during the long-task window, duplicate `/compact` rejected; on a healthy no-op `skipped` assert only the marker and the pendingAction |

Compact transport migration note (2026-07-15):

- `conversation-session-compact.test.ts` and `conversation-session-model-switch-compact.test.ts` still assert compact as non-stream.
- `conversation-session-model-switch-auto-compact.test.ts` now uses the V4 helper and tightens the reachable normal success to a single streaming SSE leg; the N06 healthy no-op passed in a real run, while N05 confirm/cancel failed because the product lacks a guard dialog, a failure that happens before the compact transport.
- Until the first two are changed to the assertion "normal success is the only streaming leg" and rerun, they do not count as compact transport coverage or promotion admission; MG likewise is not transport evidence because of the N05 product gap.
- The order of non-stream fallback after a stream failure is proven separately by the formal `conversation-session-compact-stream-fallback.test.ts` and is not tolerated as either transport in the normal success cases above.

## Minimum assertion contract

Every case contains at least:

- UI: assert with `data-testid` and `data-*`; a screenshot is not a pass condition.
- Error Banner: positive / non-fault cases must by default assert there is no `ChatViewErrorBanner` / `ChatErrorBanner`; it may appear only when the case explicitly declares fault, negative, error recovery or provider/network failure, and then the error source, dismiss state and the subsequent queue / action state must be asserted.
- Network: DeepSeek capture/replay can prove whether a model request was made and the request order.
- Runtime DOM projection: `chat-view`'s `data-session-id`, `data-state`, `data-queue-count`.
- Queue: content, kind, status and order of `chat-queue-item-*`.
- Message: message id, role and text of `chat-user-message-*`, `chat-assistant-message-*`.

## Currently landed assertions and candidate contracts

- `conversation-session-turn-steer-probe.test.ts` moved into the default conversation E2E on 2026-06-24 and was demoted back to `manual-review/pending` after the V4 migration. The current file name still hits WDIO's guide seed, so the spec first switches back to `queue` via the settings page and keeps the candidate execution evidence of M01-M05 as hard assertions; this evidence does not mean the current V4 version has completed human review, formal replay or Docker admission. The M06 guide/steer semantics are still provided by the pending `conversation-session-running-guide-steer.test.ts` as adjacent historical evidence.
- Ordinary input, `/goal` and `/compact` while running must enter the same authoritative queue by their own command kind; `/compact` shows a queued toast and a maintenance command item, is not an ordinary user message, and cannot bypass the queue to start a parallel compact.
- Prewarming is the window where the first-turn request has been sent but the model's first SSE event has not returned; further ordinary text in that window must enter the renderer queue, must not interrupt the first turn, and must not send a second model request early.
- When a first send or next turn has just entered streaming, `activeInputId` is the owner mark of the input the session is consuming; auto drain must check runtime busy, `activeInputId` and the streaming assistant placeholder together, to avoid triggering `A prompt is already running for this session`.
- When a queue exists after stop, the queue enters the held state and is not auto-consumed by default; only the queue item's "send now / continue queue" explicitly requests a post-stop drain.
- When the runtime has completed after stop and cleared `activeInputId`, the user may send `/compact`; it must not be misjudged as still running by a stale composer `streaming` state.
- If history is insufficient for a manual compact, the terminal marker may be `skipped`; a success-path E2E must first build at least two completed rounds of history and then assert `started -> completed`.
- The fork entry is open for the ZCode agent provider but allows only a stable `completed(success)` assistant message; a stopped interrupted partial offers no usable fork entry. After fork it switches to the derived session and the parent session queue is not copied.
- User-query edit is an explicit rerun action; with a held queue after stop it should still rerun immediately, the queue is kept and not auto-drained; assistant/tool expose no edit entry.
- A tool call is expected to render as `TID_CHAT_TOOL_CALL_BLOCK` inside the assistant message, not as a separate message; the tool negative-capability assertion only checks that the tool block has no edit/fork entry, and the assistant message's own fork entry is judged separately by the assistant rules.
- While an edit rerun is running, later ordinary text and `/goal` can only enter the queue and cannot preempt the current rerun turn.
- A held queue is not a reason to disable fork/edit of a stable completed assistant; while the same session is compacting, fork/edit are forbidden; while running, the latest real-user query edit goes through the stop barrier, a historical user query offers no edit, a historical assistant reply offers no retry; a stopped interrupted assistant partial cannot be forked either.
- `/goal` under completed sets or updates the session goal and keeps starting the goal continuation; when the same session is running or a held queue exists after stop, `/goal` is only appended as a `goal` queue item, cannot preempt the current turn and cannot bypass the held queue to start a request automatically.
- After a `/goal` continuation is cancelled by Stop, the UI runtime must leave streaming and `activeInputId` must be cleared; the current E2E only asserts the goal content is kept and does not hard-code target `active/paused`.
- The goal continuation/verification window should not expose a standalone `validating` product state that locks user operations; the UI `chat-view` target status in that window still expresses the target's own state, e.g. `active`.
- Compacting is a long-task state of the same session and forbids fork or another `/compact`; ordinary text and `/goal` may enter the queue. After a manual stop of compact the marker becomes `interrupted`, the queue is kept and not auto-consumed by default.
- Multiple sessions are truly concurrent: while A runs, switching to B/C and sending a prompt must let B/C each enter running; a streaming event of an inactive session must not overwrite the active session's `chat-view`, visible messages or sidebar selection.
- Model and thinking depth are session-level configuration: switching to a historical session must make the toolbar restore that session's model/thought; a new session inherits the user's last selection; real queue consumption must use the current session's latest configuration, and another session's configuration change must not pollute an inactive running session.
- Model switching is a horizontal cross dimension: beyond the basic session configuration, E2E probes have been added for queue auto-drain, held-queue send-now, manual compact, auto compact, model-switch context-guard compact, tool prompt, edit rerun and post-fork requests; N05 guard compact is currently an explicit failing probe (V4 has no dialog) and must not be described as executable-passing; whether the tool prompt, auto compact pendingAction and the target model switch after a guard compact complete still awaits deterministic replay.
- The DeepSeek replay fixture supports matching by the last user message; the stop-held "send queue item now" also has a priority fixture so that a slow-stream marker in history does not make replay take the 90-second slow stream.
- Auto compact replay uses a spec-level model configuration with a low context window to trigger `needsCompact`; the fixture expresses the request sequence "the first two compact summaries fail, the third succeeds" with `maxMatches`. The live auto compact case in `manual-review/pending` does not force a low window and, when the marker is not triggered, records only the no-op path.
- An auto compact before an edit rerun must appear as a system-prefix maintenance step: in a replay / deterministic low-window case the network request order must be the compact summary request before the main-model request of the post-edit user query; if a `manual-review/pending` live probe does not capture the matching request body, it relies on UI/session completion and the marker/artifact record.
- The live request capture of Goal manual-review combinations is not the only pass condition: when an existing goal is updated the new `/goal` may first enter the queue or become the target directly; an ordinary input after an existing paused target may first be kept as a queue without forming a running window; in manual/auto-compact scenarios the seeded message may be stopped because live traffic keeps it from idle, the compact marker/outcome is observed only in a short window, and if the composer has not yet restored input before/after compact or during the compact window only the compact marker, queue and chat snapshot are recorded; control-recovery collection after a completed goal also uses only the goal request hit as evidence, and a capture miss or a seeding/element wait timeout is not a product failure.

## Currently undefined items

(Per the statement above, F09, G11, G12 were ruled on 2026-07-05; the list below is the original undefined wording kept as stated.)

- F09: after a manual compact fails, is the session `completed(success)`, `completed(interrupted)`, `error`, or does it stay completed with only a failed marker.
- G11: after auto compact fails 3 times in a row, is the pendingAction dropped, queued and paused, or does it continue without compaction.
- G12: after auto compact is stopped, is the pendingAction dropped, queued and paused, or kept pending.

## Known limitations

- Live capture needs a real `E2E_PROVIDER_API_KEY`; without a key only replay certification can run.
- The 3 retries of auto compact already have replay coverage; environment cases such as 429/503, network off, disk full and app/agent close recovery have entered the external-fault catalog, but the product expectation must be confirmed first and then stable assertions built with mock/replay.
- Undefined cases are not automated for now: F09, G11, G12.
- The confirmed product protocol says there is no standalone paused product state after Stop, but the current agent core still marks an active goal target as `paused`; this needs a separate decision before the E2E assertion is tightened.
- The file-change summary toggle / rewind needs a stable tool-writing replay fixture; the existing DeepSeek text fixture cannot reliably produce `fileChanges`, so it is not in the first batch of desktop replay certification.
