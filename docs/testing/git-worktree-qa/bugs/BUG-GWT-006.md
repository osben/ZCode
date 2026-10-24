# BUG-GWT-006: commit-and-push on a detached HEAD fails silently: the error goes to an already-closed commit dialog, no toast

- Status: PARTIALLY FIXED (wave 2, 2026-10-18): failure routing + `mountedRef` guard + unmount regression test (2/2 green); single `GitCommitDialog` render path confirmed. REMAINING: live RT2+RT3 show no visible toast although the catch runs (`onRefreshGit` fires after each `git.push` FAIL). Needs live breakpoint debugging (suspects: the dialog closes at commit success via a path outside `closeCommitDialog`, or a toast portal interaction in the production bundle).
- Severity: S3 (the push scenario fails silently; git is safe because the push never runs; workaround: repeat the push from the branch via the push dialog, the commit already exists)
- Cases: H5 (FAIL)
- Environment: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (branch `qa/git-worktree-20261017`), isolated QA instance (production build, sandbox HOME)

## Repro

1. Fixture R5 `detached` (HEAD~1, origin = `$QA_ROOT/remotes/detached.git`): `"$QA_ROOT/bin/qa-run.sh" bash "$QA_ROOT/bin/make-fixtures.sh" R5`.
2. Make the repo dirty BEFORE opening the session: `"$QA_ROOT/bin/qa-run.sh" bash -c 'echo "h5-line for detached push test" >> $QA_ROOT/repos/detached/src/app.txt'`.
3. Open `$QA_ROOT/repos/detached` in the QA app and create a session (any short message, for example «Reply with H5OK only.»).
4. Status panel -> "Commit or push" -> in the dialog (title "Detached HEAD", +1 -0) type a message -> choose "Commit and push" (Enter or click the cmdk item).
5. The dialog closes right after the action is chosen; there is no toast and no error (`[data-sonner-toast]` = 0, no «Cannot push…»/«Push failed…» text in the DOM).
6. Host log, 3 of 3 attempts: `[rpc:call] git.push FAIL … "Cannot push while HEAD is detached."`; the commit was created on the detached HEAD each time.

## Expected

- `QA-PROMPT.md` §6, H5: "Push on a detached HEAD -> a clear error". The user must see the result: a toast, or an open dialog with the error text (as the push dialog does via `git.actionMenu.pushDialog.error.requestFailed`).
- The only UI path where the detached error can be shown is the commit dialog after a failed `pushAfterCommit`: `git.actionMenu.commitDialog.error.pushAfterCommitFailed` (`packages/ui/src/GitActionMenu.tsx`).
- `docs/git/requirements.md` §1.4 does not specify detached push behavior (separate SPEC-GAP on UX for pure detached), but visibility of a user action's error is a basic requirement for any git action in the UI.

## Actual

- The commit succeeds on the detached HEAD; `git.push` FAILs with "Cannot push while HEAD is detached." (3x in host logs).
- `detached.git` is unchanged (main/feature/a/release keep their SHAs): the git side is correct.
- No user feedback: the dialog closed when the action was chosen, no toasts, no DOM error text (polled 1-9 s).
- After the failure `onRefreshGit()` runs (committed=true), so the UI updates as if the operation completed normally.

## Cause (confirmed, renderer layer)

1. `GitActionMenu.tsx:1191-1193`: after a successful commit, `await pushCurrentBranch({ showToast: false })`; a push failure goes to the catch.
2. `GitActionMenu.tsx:1209-1230`: the only way to show the error in the catch is `setCommitError(...pushAfterCommitFailed...)`; the failure branch has no toast. `commitError` renders ONLY inside `GitCommitDialog` (`GitActionMenu.tsx:543`), so it is visible only while `commitDialogOpen === true`.
3. `GitActionMenu.tsx:1370-1374`: the dialog's `onOpenChange(false)` calls `closeCommitDialog()` (`:906-914`), which unconditionally resets all dialog state (`commitError`, `commitDialogState`) without checking `mutationPending`. The dialog can be dismissed at any time between choosing the action and the async operation finishing.
4. Result: push reject -> catch -> `setCommitError` into a closed dialog -> invisible error, no toast. Reproduced by a component test on the same code path (dismiss via `onOpenChange(false)` during a pending push): after reject the dialog is closed, no error text in the DOM, `toast` not called, `commit` called once.
- Hypothesis (unverified): the exact trigger for closing the dialog at cmdk item selection in production (Radix pointer/focus interaction of cmdk inside a modal Dialog in Electron). In jsdom a click on the item does not close the dialog. Not essential: any dismiss in the pending window loses the error.

## Proposed fix

Make the failure branch of `handleCommitAction` visible independent of the dialog lifecycle: show a toast with the `pushAfterCommitFailed` text (as the push dialog does via `pushDialog.error.requestFailed`), and/or do not allow dismissing the dialog (`closeCommitDialog` from `onOpenChange(false)`) while `mutationPending === true`, keeping the inline error in the dialog. Either option also covers "user closed the dialog during the push".

## Test

`packages/ui/test/gitActionMenuError.test.ts`, one `it.fails("BUG-GWT-006: keeps a push-after-commit failure visible after the commit dialog closes", …)`. Level: mounted `GitActionMenu` (jsdom + @testing-library/react), git mocked at the `gitService` RPC boundary (refresh/stagePaths/commit resolve; push is a controlled deferred reject "Cannot push while HEAD is detached."). No sleeps (`findBy*`/`waitFor`/microtask flush), self-contained, independent of `$QA_ROOT`.

Scenario: detached + dirty -> commit dialog -> message -> "Commit and push" -> push pending -> dismiss the dialog (`onOpenChange(false)` -> `closeCommitDialog`) -> push rejects -> assert the error is visible (open/reopened dialog with the error OR a failure toast). Without the marker it fails at that assertion (`expected false to be true`, `gitActionMenuError.test.ts:243`) after commit/push were each called once.
