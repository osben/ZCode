# BUG-GWT-008: `inside` worktree creation leaves `.worktrees/` untracked in the main checkout

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)
- Severity: S3 (workaround: ignore the entry or add `.worktrees/` to exclude by hand; no data loss)
- Cases: D2
- Environment: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (branch `qa/git-worktree-20261017`), isolated QA instance (production build)

## Repro

1. Fixture R1 (basic): repo with commits on `main` (QA-PROMPT §4).
2. QA app: Settings (Cmd+,) -> Worktrees -> location "Inside repository".
3. Cmd+K -> "New task in worktree" -> project `basic`, auto name (for example `hypersonic-avocado`), base = `main` -> Start.
4. Sidebar -> main checkout `basic` -> Review pane.
5. Or with git only (equivalent to what the service does):

```bash
cd <repo> && git worktree add -b zcode/brave-otter -- "<repo>/.worktrees/zcode-brave-otter" main
git -C <repo> status --porcelain   # -> "?? .worktrees/"
```

## Expected

In `inside` mode the worktree lives in the project (`<repoRoot>/.worktrees/<segment>`; `packages/ui/src/command-center/worktreeTaskFlow.ts` §computeWorktreeTargetPath; design doc `docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md`, "Worktrees settings"). The directory is app-created housekeeping, so the main checkout must not show it as a change: after creation `git status --porcelain` of the main checkout stays clean (`.worktrees/` excluded via `.git/info/exclude` or `.gitignore`).

## Actual

- `git worktree list` is correct: worktree at `<repo>/.worktrees/zcode-<name>`, branch `zcode/<name>`, base SHA = base tip.
- Main checkout `git status --porcelain`: `?? .worktrees/`.
- The Review pane of the main project shows a junk untracked entry `.worktrees/zcode-hypersonic-avocado` ("+0-0", diff unavailable because the entry is a directory).
- No errors in app logs.

## Cause (confirmed on every layer)

`packages/services/src/git/repo/gitCliRepo.ts:1266-1362` (`createWorktree`) runs only `git worktree add` (1328-1347) and returns success (1356-1361). Nothing in the chain writes `.worktrees/` to `.git/info/exclude` or `.gitignore` (`rg "info/exclude" packages/services packages/desktop packages/ui` finds nothing relevant). The `inside` path is built in `worktreeTaskFlow.ts:195-201`; the call goes `worktreeCreation.ts:81` -> `packages/services/src/git/gitService.ts:271-278` -> `gitCliRepo.createWorktree`; no layer touches exclude. Plain git reproduces it: after `git worktree add <repo>/.worktrees/x`, porcelain shows `?? .worktrees/` and `.git/info/exclude` has no entry.

## Fix direction and outcome

Proposed: after a successful `git worktree add` with a target inside repoRoot, idempotently add `.worktrees/` to `.git/info/exclude` (do not touch the user's `.gitignore`; create the file if missing). Preferred over filtering at the status layer because status stays honest for external git.

Shipped fix (6b16482b): a separate `ensureWorktreeExclusion` step called by the app pipeline writes `.git/info/exclude`; covered by upstream tests `gitCliRepo ensureWorktreeExclusion`. The original service-level test asserted exclusion inside `createWorktree`, was superseded and removed.

## Test (superseded)

`packages/services/test/gitService.test.ts`, `it.fails("BUG-GWT-008: inside worktree creation keeps .worktrees/ out of the main checkout status")`: real git in a temp folder, `createGitService().createWorktree` with target `<repoRoot>/.worktrees/zcode-brave-otter`, asserts the worktree exists and `git status --porcelain` of the main checkout is empty (red without marker: `expected '?? .worktrees/' to be ''`).
