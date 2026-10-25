# Commit dialog: detached-HEAD warning

Status: implemented (2026-10-18). Origin: Git/Worktree QA MINOR-4
(`docs/testing/git-worktree-qa/actual-issues-2026-10-18.md`). Owner decision: warn before
committing on a detached HEAD.

## Problem

On a detached HEAD, the commit dialog (`GitActionMenu`) commits without saying so. The new commit
belongs to no branch, disappears from branch history as soon as the user switches away and can be
garbage-collected later. Push already refuses with a visible toast ("Committed, but push failed:
Cannot push while HEAD is detached."), but by then the commit has been created.

## Contract

- **Trigger.** "Commit" and "Commit and push" in the commit dialog, when the repository summary
  loaded for that dialog (`refresh` at dialog open or after a branch change) reports
  `headRefType: "detached"`. The dialog's own refreshed summary is the source of truth, not the
  menu's possibly stale `gitSummary` prop. "Push only" and branch checkouts are unaffected.
- **Order.** The existing validations (missing identity, no selected changes) run first and keep
  their inline errors. The warning comes next, before message generation, staging, commit or push,
  so cancelling spends no generation request and changes nothing in Git.
- **Surface.** A confirmation through the shared `confirmDialogStore` / `ConfirmDialogHost`:
  - title: "Commit on a detached HEAD?"
  - description: the commit will not be on any branch and can be lost after switching branches;
    create or switch to a branch first to keep it.
  - confirm: "Commit anyway"; cancel: the default Cancel label.
- **Confirm** runs the requested action unchanged, including push after commit and its existing
  failure toast.
- **Cancel or dismiss** leaves the commit dialog open with the typed message, the include-unstaged
  choice and no error. Nothing is staged, committed or pushed.
- The question is asked once per action click. A branch HEAD never shows it.

## Acceptance scenarios

1. Detached HEAD → Commit → warning → Cancel: no `stagePaths`/`commit`/`push` call, the dialog
   stays open with its message.
2. Detached HEAD → Commit → warning → Commit anyway: one commit, success toast, dialog closes.
3. Detached HEAD → Commit and push → Commit anyway: the commit happens, then the existing
   push-failure toast appears (BUG-GWT-006 behaviour preserved).
4. Branch HEAD → Commit: no warning; commit proceeds as before.

## Validation

Mounted `GitActionMenu` tests with a mocked `gitService` cover scenarios 1–4; a live check in the
isolated QA instance uses the `detached` fixture.
