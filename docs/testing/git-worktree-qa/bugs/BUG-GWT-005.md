# BUG-GWT-005: after Retry in recovery the preparation hangs in ready — the frozen message is not admitted into the session automatically

- Status: FIXED (wave 3, 2026-10-18), verified live on a production QA build of the fix branch (RT4-C5): Retry -> `git.createWorktree` +146 ms -> `createSession{preparedSessionId}` +206 ms -> `highspeed-card.prepareTurn` +556 ms -> `sendText` +572 ms with no user action; recovery card and "Queued message" cleared; the agent wrote `live6.txt` in the worktree of the same session.
- Wave 4 (2026-10-18): the opposite ordering (Host snapshot before the Retry acknowledgement) is closed by a mounted regression; not verified live (see Wave 4 below).
- Previous status (wave 2): PARTIALLY FIXED — the continuation moved to a store-level registry surviving view promotion; the remaining "runtime CommandInbox" localization turned out to be wrong (see Wave 3 below).

- Severity: S3 (workaround: manual Restore -> Send in the same session; but the spec contract on admitting the frozen send after ready was violated)
- Cases: C5 (main, FAIL)
- Environment: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (branch `qa/git-worktree-20261017`), isolated QA instance (production build, sandbox HOME)

## Wave 3 (2026-10-18): real cause — a stale Host seed rolls Retry back

**The CommandInbox localization was disproven.** Evidence from the RT3-C5 host log and code:

- The `sendConversationCommandV4` at Retry+0 ms is `updateWorktreePreparation{status:"preparing"}` from `SessionPane.handleWorktreePreparationRetry`, not an enqueued message. After `git.createWorktree`/`ensureWorktreeExclusion` the auto path made **no** Host call (no `createSession`, no `sendText`), so nothing ever reached the CommandInbox. "Queued message" is a renderer-only timeline label (`entry.queuedPromptPreview`). `prepareTurn` is a renderer highspeed side-call inside the send path, and `taskBus.leases` is an Electron-main metric, not CommandInbox state.
- Production renderer logging is a no-op, so the live path was traced with CDP conditional breakpoints in the minified bundle (`$QA_ROOT/evidence/RT4-C5-cdp-logpoints-before-fix.log`). The queued-send effect runs after Retry as: (1) `creating`, attempt B (retry) — continuation armed, rebinds to B; (2) **`failed`, attempt A (the old attempt)** — continuation still armed; (3) `creating`, attempt B — continuation **released**; (4) `ready`, attempt B — nothing to dispatch.

Confirmed cause:

- `packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx` (Host reconcile effect, deps include `entry`) re-runs when Retry's `startPipeline(creating, B)` changes the entry, but its `preparation` prop is still the stale Host seed `{failed, A}`: the Host accepted the retry before its snapshot reached the renderer.
- `packages/ui/src/v4/composer/composerWorktreePreparationRestore.ts` treated any `hostAttempt !== entryAttempt` as a "newer Host generation" and replaced the entry with `failed(A)`.
- `packages/ui/src/v4/ConversationComposer.tsx` queued-send effect: attempt mismatch + status `failed` -> `detachQueued()` + `restore()` — the armed continuation is released permanently, so the later `ready(B)` admits nothing and the recovery record stays (MINOR-1).

Fix: attempt ids are opaque, so "newer" is decided by supersession. The pipeline store's `startPipeline` is the single owner: replacing a session's entry with another attempt (Retry, `restartPreparedWorktreeCreation` on Send in a failed prepared session, a newer Host attempt) records the replaced attempt in `entry.supersededAttemptIds`; restore ignores a Host seed carrying a superseded attempt; a genuinely newer Host attempt still replaces the entry and inherits the superseded set.

Spec: `specs/composer-worktree-setup-steps.md` (supersession paragraph + event diagram, acceptance scenario 18).

Tests (`packages/ui/test/composerWorktreePipeline.test.ts`):

- `BUG-GWT-005: the stale Host failed seed for the retried attempt cannot roll back Retry and strand the frozen submission (RT4-C5 live path)` — mounted `ConversationComposer` + real `ConversationWorktreeSetupSteps`, real Retry button, stale `{failed, A}` seed, Host seed updated afterwards.
- `BUG-GWT-005: ignores a Host seed for an attempt the renderer already superseded, but still yields to a newer Host attempt` — restore-level rule.
- `BUG-GWT-005: a prepared-session restart is not rolled back by the stale Host failed seed` — same race through the restart path.
- Red without the fix (source swapped to HEAD): mounted test `expected "vi.fn()" to be called 1 times, but got 0 times`; store trace `creating B -> failed A -> creating B (released) -> failed B`, identical to the live CDP trace. Green with the fix: 42/42 in the file (all three BUG-005 tests red with the store rule removed); 50 worktree/composer/command-center files, 467 tests green.

## Wave 4 (2026-10-18): snapshot before the Retry acknowledgement

Pre-existing ordering, not observed live; found while reviewing the Wave 3 fix.

Cause (confirmed by a red mounted test):

- If the Host snapshot `preparing(B)` arrives while `onRetryPreparation` is still pending, `restoreComposerWorktreePipelineFromPreparation` adopts B as `creating` (A superseded).
- The setup-steps effect re-runs and `settleStaleCreating` sees `creating` with no runner. `reconcileCreatingComposerWorktreePipeline` lists worktrees, finds none, marks B `failed`, and reports it via `onPreparationFailed(B)`.
- When the acknowledgement resolves, the Retry handler's `status !== "failed"` guard (or, with a relaxed guard, the reconcile resuming after its own await) still leaves nobody to start Git for B, so the armed submission is never admitted.

Fix: the renderer that issued Retry is the single owner of starting Git for the acknowledged attempt.

- `markComposerWorktreeRetryPending` (runner module, `composerWorktreePipeline.ts`) is held from before `onRetryPreparation` until the handler ends. The stale-creating reconcile skips a session with a pending retry or an in-flight runner, and re-checks both after each of its own awaits.
- `retryComposerWorktreePipeline` proceeds from `failed` for the retried attempt, or from `creating` for exactly the acknowledged attempt with no runner in flight; otherwise it resolves `skipped`. Restore still never starts Git.
- When the handler ends without starting a runner while the entry is `creating` (acknowledgement threw or named another attempt), the setup-steps effect re-runs on `actionPending` and hands the session back to the stale-creating reconcile.

Spec: `specs/composer-worktree-setup-steps.md` (owner paragraph, "Snapshot before acknowledgement" diagram, acceptance scenario 18).

Test (`packages/ui/test/composerWorktreePipeline.test.ts`): `BUG-GWT-005: Retry still starts Git and admits the frozen submission once when the Host snapshot for the retried attempt arrives before the Retry acknowledgement` — mounted composer + real setup steps, deferred `onRetryPreparation`, `preparing(B)` fed and async work flushed before the acknowledgement resolves.

- Red without the fix: `expected { status: 'failed', … } to match object { status: 'creating', … }` — the stale-creating reconcile settled B before the acknowledgement.
- Each half is needed: with the pending-retry mark disabled, the same intermediate assertion fails (reconcile settles B); with `retryComposerWorktreePipeline` proceeding only from `failed`, `onSendText` is `called 0 times` (nobody starts Git for B).
- Green with the fix: 43/43 in the file; 57 worktree/composer/command-center/session-pane files, 596 tests green. The Wave 3 tests stay green.

## Original report (QA, before waves 3-4)

### Repro from scratch

1. Fixture R1 `basic` (`"$QA_ROOT/bin/qa-run.sh" bash "$QA_ROOT/bin/make-fixtures.sh" R1`).
2. Break creation beforehand: `mkdir -p $QA_ROOT/repos/basic-worktrees && chmod 555 $QA_ROOT/repos/basic-worktrees`.
3. Open `$QA_ROOT/repos/basic` in the QA app, turn Worktree on in the empty state, Send: "Create file c5-marker.txt with text C5. Reply with pwd."
4. Wait for the failure (~4 s): step `data-worktree-setup-step="failed"` + recovery card `data-testid="composer-worktree-recovery"` ("Unsent message saved …").
5. Restore permissions: `chmod 755 $QA_ROOT/repos/basic-worktrees`.
6. Click Retry (button with key `worktreeSetup.retry`). The Git part succeeds: worktree created, no second branch.
7. Watch >=40 s (poll `data-worktree-setup-steps` every 3 s): the step stays `data-worktree-setup-step="ready"` forever; the session does not open, the frozen message is not admitted; clicking the task in the sidebar does not activate it either.
8. Workaround: Restore on the recovery card -> text in the editor -> Send -> the same prepared session accepts the message and the agent works in the worktree.

### Expectation

- `specs/composer-worktree-setup-steps.md` §Contract: "After Git reports a ready path, activate the same session with the frozen submission. The Host validates and constructs the runtime with `executionWorktree` as its initial execution directory, then admits that submission exactly once" (same in §Submission and editor behavior) and: "If activation fails before admission, the preparation entry stays `preparing` with its session identity, so the frozen submission remains recoverable and **one retry can admit it exactly once**".
- Case C5: "after restoring permissions Retry creates the worktree" and the message is admitted; a hang in ready without auto-activation is not provided by the contract.

### Fact

- After Retry the step hung in `ready` for >=40 s (polling x10: `steps=["ready"]`): the session did not open, the frozen message was not accepted.
- After `git.createWorktree OK` (72.0 ms) the logs show no activation/send call (no v4 command admitting the first input).
- Opening the task "Worktree zcode/dancing-walrus" from the sidebar does not activate the session.
- The manual path works: Restore -> Send -> same session, the agent created `c5-marker.txt` (C5), pwd = worktree — data and session identity intact; only the automatic admission is lost.
- Git state after Retry is correct: worktree created (28 entries), same branch, no new orphan branches from Retry (the half-created branch of the first failure is a separate defect of case C5, not this bug).

### Evidence

- Case protocol: `$QA_ROOT/cases/C5.md`.
- Screenshots: `$QA_ROOT/evidence/C5-2-retry-ready-stuck.png` (hung ready), `C5-3-restored.png` (Restore), `C5-4-final.png` (manual send worked).
- Red/green test runs: `$QA_ROOT/evidence/BUG-GWT-005-red-run.txt`, `$QA_ROOT/evidence/BUG-GWT-005-green-run.txt`.

### Cause as analysed originally (renderer layer; superseded in part by Wave 3)

1. `packages/ui/src/v4/ConversationComposer.tsx:1380-1446` — queued-send effect: on a `failed` pipeline the renderer immediately detaches the only continuation of the frozen send: `detachQueued()` (`pendingWorktreeSendRef.current = null`, lines 1385-1388, call at 1444) + `queued.restore()` (1445). The dispatch closure `runSend` (the only activation path) no longer exists; the frozen send remains only a passive recovery record.
2. `packages/ui/src/v4/ConversationComposer.tsx:1381-1382, 1413-1428` — on `ready` the effect dispatches ONLY with a live `pendingWorktreeSendRef.current` (`if (!queued) return;`). After a failure it is null, so a ready worktree triggers nothing and the step stays ready forever.
3. `packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx:281-334` — the Retry button handler handles only `outcome === "failed"` (`onPreparationFailed`); the `"ready"` outcome has no activation/admission step (no re-attach of the recovery record, no dispatch).
4. `packages/ui/src/v4/ConversationComposer.tsx:1401-1405` — even a still-attached send would be dropped: Retry issues a NEW attempt id (`packages/ui/src/v4/SessionPane.tsx:2278` — `crypto.randomUUID()` in `handleWorktreePreparationRetry` -> `updateWorktreePreparation`), `retryComposerWorktreePipeline` (`packages/ui/src/v4/composer/composerWorktreePipeline.ts:332`) writes it into `params`; the guard `queued.attemptId !== worktreePipeline.params.attemptId` -> detach + restore. A double guardrail, and no path re-binds the frozen send to the retry attempt.
5. Clicking the task in the sidebar does not help: the prepared session's composer mounts with an empty `pendingWorktreeSendRef` and no automatic send; only a new manual Send works (the ready branch at `ConversationComposer.tsx:2111-2124` uses the ready pipeline) — which is the observed Restore -> Send workaround.

Originally proposed fix: renderer layer — after failed -> Retry -> ready, re-admit the frozen send from the session-scoped recovery record exactly once (for example the Retry flow re-binds the recovery submission to the new attempt id and the queued-send effect dispatches it on ready, keeping consume-exactly-once); keep Host idempotency by attempt id; never admit the first message twice.

### Original test

- `packages/ui/test/composerWorktreePipeline.test.ts`, one `it.fails("BUG-GWT-005: admits the frozen first submission exactly once after a retried creation turns ready", …)`: mounted `ConversationComposer` + real pipeline/store/retry (`retryComposerWorktreePipeline`, `beginWorktreePipelineCreation`); git mocked only at the `createWorktree` RPC boundary (first call EACCES-reject, Retry success); no sleep (only `vi.waitFor`/`act`), self-contained. Scenario: send -> creating -> failed (recovery record confirmed) -> Retry with a new attempt id -> ready -> expect `onSendText` called exactly once with `executionWorktree` and `preparedSessionId`.
- Red without the marker: `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times` at `composerWorktreePipeline.test.ts:1442:26`, 1 failed | 35 passed (36); the failure is the bug itself (the failed state and ready after Retry were reached, admission did not happen). With the `it.fails` marker the file was green 3 times in a row: 35 passed | 1 expected fail (36).
