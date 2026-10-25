# BUG-GWT-003: a failed `git.createWorktree` is logged as "OK" and leaves a half-created branch in git (no rollback of the `-b` branch when creation is refused)

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)

- Severity: S3 (workaround: Retry after restoring permissions reuses the same branch; git garbage and the false "OK" log line hamper diagnosis and recovery)
- Cases: C5 (main, defect 2), C8 (echo: same class "OK on failure")
- Environment: macOS 27.2 (darwin, arm64), git 2.56.0, commit `bd6a05b3` (branch `qa/git-worktree-20261017`), isolated QA instance (production build, sandbox HOME)

## Repro from scratch

UI (as in the cases):

1. Fixture R1 `basic`; beforehand `mkdir -p $QA_ROOT/repos/basic-worktrees && chmod 555 $QA_ROOT/repos/basic-worktrees` (verified: `mkdir` inside -> Permission denied).
2. Open `$QA_ROOT/repos/basic`, composer -> toggle Worktree ON -> Send ("Create file c5-marker.txt …").
3. Observe step failed + recovery; then `git -C $QA_ROOT/repos/basic branch -vv` — a branch `zcode/<auto>` without a worktree remains; the host log tail shows `[rpc:call] git.createWorktree OK (64.2ms)`.
4. Variant C8: fixture R2 `empty` (unborn HEAD `main`), Worktree ON (popover "Base branch main") -> Send -> instant failed; the log shows `[rpc:call] git.createWorktree OK (47.0ms)`; Retry fails deterministically again.

Unit level (no UI; reproduces the core with real git):

```bash
T=$(mktemp -d)/repo && git -C $T init -q && git -C $T -c user.email=t@t -c user.name=t commit -q --allow-empty -m c1
P=$(mktemp -d) && chmod 555 $P
git -C $T worktree add -b zcode/x -- $P/x; echo "exit=$?"   # exit=128, Permission denied
git -C $T branch --list                                    # -> zcode/x  (half-created branch!)
```

## Expectation

- Case C5: "clear error + recovery; no git garbage — no half-created branches" (`$QA_ROOT/cases/C5.md`; QA-PROMPT §C5), spec `specs/composer-worktree-setup-steps.md` §Preparation states (`failed`).
- Service contract: `createWorktree` reports the creation error to the caller, and a failed creation does not change the set of repository branches (whoever reads the host logs sees the failure, not "OK").

## Fact

- C5 (EACCES): the UI failure is caught correctly (step failed + recovery), BUT git keeps a branch `zcode/dancing-walrus` @5371bb3 with no worktree record and no directory; the log says `[rpc:call] git.createWorktree OK (64.2ms)` (`…/logs/2026-10-17.log:19231`). Retry after `chmod 755` reached ready by reusing the same garbage branch (no second branch appeared).
- C8 (unborn HEAD, base `main`): `[rpc:call] git.createWorktree OK (47.0ms)` (`…/logs/2026-10-17.log:23987`) despite an actual refusal `fatal: invalid reference: main`; git is clean (no commits, so a half-created branch is impossible), Retry fails deterministically again.
- Unit check on this commit (real git, temp dir): with a read-only parent `createWorktree` returns `{ ok: false, issues: [{ code: "unknown", detail: "…could not create leading directories…Permission denied" }] }` — the service DOES give the error to the caller; but the branch `zcode/half-created` stays in the repo (`git branch --list` is non-empty). With unborn HEAD + base `main`: `{ ok: false, issues: [{ code: "target-branch-not-found", detail: "fatal: invalid reference: main" }] }`.

Two independent defects under the "OK on failure" shell:

1. a half-created garbage branch after a failed `worktree add -b` (the S3 core, reproduces at the services layer);
2. an "OK" line in the RPC log on actual failure (hampers diagnosis; this is what the cases recorded as "git.createWorktree returned OK").

## Evidence

- `$QA_ROOT/cases/C5.md` (DEFECT 2: half-created branch + "git.createWorktree OK (64.2ms)"), `$QA_ROOT/cases/C8.md` (same for unborn).
- Host log: `$QA_ROOT/home/.zcode/v2/logs/2026-10-17.log:19231` (`git.createWorktree OK (64.2ms)`, 21:52:21) and `:23987` (`git.createWorktree OK (47.0ms)`, 22:25:52).
- Screenshots: `$QA_ROOT/evidence/C5-1-failed-rawkeys.png`, `$QA_ROOT/evidence/C8-1-failed-rawkeys.png`, `$QA_ROOT/evidence/C8-2-after-retry.png`.

## Cause

Confirmed (file:line, checked on this machine):

1. Half-created branch: `packages/services/src/git/repo/gitCliRepo.ts:1328-1347` — success is decided by the child process exit code (`result.exitCode !== 0` -> `ok:false`, lines 1352-1354). The command is `git worktree add -b <branch> -- <path> [<base>]`; Git itself writes `refs/heads/<branch>` BEFORE creating the worktree directory (verified: exit 128 "could not create leading directories … Permission denied", yet the branch exists). The service returns `ok:false` but does NOT roll back the just-created branch, so the half-created branch stays in git (C5: `zcode/dancing-walrus`; Retry then takes the `branchAlreadyExists` path, `gitCliRepo.ts:1327,1332-1333`, and reuses the garbage branch, masking the garbage).
2. False "OK" in the log: `packages/rpc/src/logging-middleware.ts:41-48` — `LoggingServerChannel.call` writes `[rpc:call] git.createWorktree OK (Xms)` for ANY call that finished without throwing; `createWorktree` reports errors through a resolved result object `{ok:false, issues}` (`gitCliRepo.ts:1352-1354`), not an exception. The desktop host wraps the server in `LoggingChannelServer` (`packages/desktop/src/host/index.ts:2100`), so an actual failure is logged as OK — these are lines 19231/23987 from the cases.

Refuted (part of the original bug wording): at the RESULT level `createWorktree` does NOT return ok:true on EACCES/unborn — verified by a unit run of real git on this commit (both cases give `ok:false` with issues), and the UI pipeline correctly maps `ok:false` to "failed" (`packages/ui/src/command-center/worktreeCreation.ts:99-104` -> `packages/ui/src/v4/composer/composerWorktreePipeline.ts:167-170`). The "false success" exists only in the RPC log text, not in the data flow.

Hypothesis (not verified): when called WITHOUT baseBranch in an empty repo, `git worktree add -b` exits 0 after creating an orphan worktree ("No possible source branch, inferring '--orphan'"), so a real ok:true with a meaningless (orphan) worktree is possible; the composer in C8 passed base `main`, so that path was not exercised in the case.

## Proposed fix

- `gitCliRepo.createWorktree`: if `worktree add -b` exits non-zero and the branch did not exist before the call (`branchAlreadyExists === false`), roll back the half-created branch (for example `git update-ref -d refs/heads/<branch>` / `git branch -D`, guarded so a previously existing branch is never touched). The UI layer does not change.
- Separately (rpc/logging layers, optional for S3): in `LoggingServerChannel` distinguish "resolved" from "succeeded" for services returning a result object (log an `ok:false` payload as FAIL or add an ok flag), so incident investigation does not rely on a false "OK".

## Test

- `packages/services/test/gitCliRepo.test.ts`, `it.fails("BUG-GWT-003: failed worktree creation reports the error and leaves no half-created branch")` — real git in a temp dir: read-only parent (`chmod 0o555`), `createWorktree(…, "zcode/half-created", <ro>/zcode-half-created, "release")`; asserts: `result.ok === false` (the service must report the error — holds today) and `git branch --list zcode/half-created` is empty after the failure (does NOT hold today — the half-created branch remains).
- Red run (without the marker): `AssertionError: expected 'zcode/half-created' to be ''` at `packages/services/test/gitCliRepo.test.ts:842:76`; 1 failed | 31 passed (32). Red for the right reason: the `ok:false` assertion passed, only the "no half-created garbage branch" assertion failed.
- Green run (with `it.fails`): 1 passed file — 31 passed | 1 expected fail (32) (real-run.sh, Node 26.11.1, git 2.56.0).
