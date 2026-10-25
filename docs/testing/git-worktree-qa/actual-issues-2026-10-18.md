# ACTUAL ISSUES — Git/Worktree QA (verified live 2026-10-18, build b60bdde3)

The single source of actual issues for the next fix cycle.

> **Status after wave 3 (2026-10-18, branch claude/git-worktree-qa-bugs-0c60cd):**
> OPEN-1 FIXED (live on the branch's production build, RT4-C5, 2 runs); OPEN-2 not reproduced
> (5/5 New-task Send delivered after the fix, caveats below); MINOR-1 FIXED together with OPEN-1;
> MINOR-2 FIXED (Git reason in `{reason}`, hint about a repository without commits); MINOR-3
> deferred (session-recovery / project-picker subsystem, not worktree); MINOR-4 FIXED (owner
> decision: warn; spec `specs/git-commit-detached-head-warning.md`, verified live); MINOR-5 not
> reproduced (0 send-RPC during typing, including `inserttext` with a 14 s wait).
> Before wave 3, 12 of 13 bugs were closed and confirmed live (001-004, 006-013); wave 3 closed
> 005, so 13 of 13. Waves 1-2 were verified by marker tests plus RT3 UI retests (QA_ROOT/cases/RT3-\*.md).
> Below is ONLY what reproduces now.

---

## OPEN-1 (BUG-GWT-005, S3): after Retry the queue does not drain into a turn — message admission does not happen

**State (wave 3): FIXED.** The localization "runtime CommandInbox" was refuted: after Retry the renderer sent neither `createSession` nor `sendText` (the RPC at Retry+0 ms is `updateWorktreePreparation{preparing}`). Real cause (CDP trace): the reconcile effect of `ConversationWorktreeSetupSteps`, holding a stale Host seed `{failed, A}`, rolled the Retry record `creating(B)` back to `failed(A)`, and the queued-send effect detached the continuation. Fix: `supersededAttemptIds` (restore ignores the seed of a replaced attempt). Live: Retry -> createWorktree +146 ms -> createSession +206 ms -> prepareTurn +556 ms -> sendText +572 ms, file created in the worktree, recovery card removed. Details in `bugs/BUG-GWT-005.md` §Wave 3.

**Original description (before wave 3):** Fix 2f76fd5e made Retry queue the message (`sendConversationCommandV4` +0 ms), the prepared session opens by itself, the worktree is created (+99 ms), and the continuation lives in a store-level registry and survives promotion. But within 120 s there were 0 turn-activating RPCs (`prepareTurn`/turn-start/activate), `taskBus.leases = 0` in all snapshots, no file was created, and the recovery card and "Queued message" stayed. Manual Restore -> Send -> Confirm worked: `prepareTurn` +456 ms, file within 10 s, same session. Fourth live evidence (C5, RT-C5, RT2, RT3-C5).

- Spec: `specs/composer-worktree-setup-steps.md` §Contract retry-admission ("a ready record that admits nothing violates the contract") plus stuck-ready routing (updated in wave 2).
- Narrowed localization at that time: the runtime **CommandInbox does not lease the queued message after the worktree is ready**; the renderer part was fixed and covered by regression (`packages/ui/test/composerWorktreePipeline.test.ts` plus upstream `v4ConversationComposerWorktreeLateAck.test.ts`).
- Repro from scratch: R1 basic -> `chmod 555 $QA_ROOT/repos/basic-worktrees` -> worktree on + send "Create file x.txt with text X" -> failed -> `chmod 755` -> Retry -> watch 120 s (no prepareTurn) -> Restore -> Send works.
- Evidence: `QA_ROOT/cases/RT3-C5.md` (RPC timeline), screenshots RT3-C5-0..3; no git garbage (wave-1 rollback works).
- Fix direction at that time: runtime — once the prepared session turns ready (worktree created), CommandInbox must lease the frozen queued message and start the turn (the same path as manual Send: `sendConversationCommandV4` -> `prepareTurn`).

## OPEN-2 (observation, 005 family, S4): rare silent loss of Send from "New task"

Once per round: Send from the New task empty composer was accepted by the UI and the editor cleared, but there was 0 `sendConversationCommandV4` in the logs and no session; after reload the same send arrived. In the RT-C5 epoch it reproduced 2/2 with a live stuck-ready pipeline; on build b60bdde3 once without a stable link (probably keep-warm dispose at the same moment). Accompanied by a "ghost draft" (the sent text revived in the composer). To check when fixing OPEN-1 (possibly the same lease path).

**Wave 3: not reproduced.** On the production build with the OPEN-1 fix: 5 times session-view -> New task -> Send (3x `keyboard type`, 2x `keyboard inserttext`) — each time the send RPC went out, the session was created, the editor was empty, no ghost draft (`$QA_ROOT/evidence/RT4-OPEN2-newtask-3x.png`, `RT4-final-refactor-newtask.png`). Caveats: the worktree intent stayed on (every send created a worktree session; the variant with the intent off was not obtained by automation), and the stuck-ready pipeline (the original precondition) did not occur — after the OPEN-1 fix it no longer arises. If the loss recurs, localize it as a renderer dispose race.

## MINOR (observations, S4, non-blocking)

1. **[FIXED, wave 3 — consequence of OPEN-1]** **The recovery card does not disappear after a successful Retry** (RT3-C5/RT3-B nuances) — it stayed until manual Restore although the session was open and the queue stood.
2. **[FIXED, wave 3]** An unclassified Git refusal shows the Git line ("Could not create the worktree: could not create leading directories of '…': Permission denied", live RT4-C5), and `target-branch-not-found` hints about a repository without commits (`worktreeCreation.ts`, test `worktreeCreationFailureReason.test.ts`). Originally: **`{reason}` in worktree preparation errors was generic** ("Could not create the worktree" without permission/EACCES; "Base branch "main" was not found" without mention of an empty repo) — wave 1 closed raw keys, reason polish was not done.
3. **[DEFERRED]** Session-recovery and project-picker subsystem (not worktree); needs separate localization; "basic" was also missing from the picker on b60bdde3 in the live wave-3 run. **New task resets the project selection** (path-dependent: from session-view -> "Select project", no chip; from the empty state it survives) + "basic" is missing from the New task workspace picker (only 6 recent) — RT3-C7obs.
4. **[FIXED, wave 3]** The owner decided to warn. Commit / Commit and push on a detached HEAD ask for confirmation ("Commit on a detached HEAD?" -> "Commit anyway"); Cancel changes nothing and leaves the dialog with the message. Spec `specs/git-commit-detached-head-warning.md`, test `gitActionMenuDetachedCommitWarning.test.ts`; live on the `detached` fixture (`$QA_ROOT/evidence/RT4-MINOR4-detached-warning.png`). Originally: **a detached commit went out of branches without a warning** (H5-derived UX question; push correctly refuses with a visible toast).
5. **[NOT REPRODUCED, wave 3]** 0 `sendConversationCommandV4` in the typing window in all runs: 3x `keyboard type` and 2x `keyboard inserttext` (original method, 14 s wait before Enter). Timing anomaly: `sendConversationCommandV4` once appeared in the log about 14 s BEFORE the Send click (at the moment of inserttext) — no duplicate; keep observing during OPEN-1 work.

## Closed in this wave (for reference, reconfirmed live on b60bdde3)

010 (Worktree marker/classification survive restart with a closed workspace — RT3-F7), 011 (Conflicted badge — RT3-A8), 012 + "1 files" (formatPlural en/zh/uk, guard dialog and dirty-cue — RT3-B6/RT3-1files), 006 (visible toast "Committed, but push failed: …" 2/2 — RT3-H5), 013 (destination chip about 100 ms after programmatic open — RT3-A2/A4). Wave 1 (b67cc63f): 001, 002, 003, 004, 007, 008, 009.

## Checks on this build

typecheck PASS, lint PASS, architecture:check --changed PASS, oxfmt (our files) clean, all formerly-marker test files rc=0 (markers removed in wave 2), G1 start/end PASS, 0 [error] per round, isolation not violated, port 9339 free.
