# Git Branch Switching and Creation Underlying Capability Design

## Document Positioning

Incremental design on top of the existing Git architecture and service layer:

- Local branch list reading
- Branch switching
- New branch creation and switching
- Structured blocked reasons when switching fails

Only the Git underlying capability is covered; UI interaction, popup style and form details are out of scope (except the UI landing section at the end).

## Implementation Locations

- `packages/shared/src/git.ts`: local branch list and switch / create-and-switch DTOs.
- `packages/services/src/git/git.ts`: `IGitService` exposes `getLocalBranches`, `switchBranch`, `createBranchAndSwitch`.
- `packages/services/src/git/repo/gitCliRepo.ts`: `git for-each-ref` local branch reading; `git switch --no-guess` switching and `git switch -c` creation; failure / in-progress operation checks mapped to structured results.
- `packages/services/test/gitService.test.ts`: real Git repository integration tests (success, no-op, dirty allowed switching, overwrite block, conflict, in-progress operation, illegal branch name, existing branch, worktree occupied).

## Background

The Git service layering is stable:

- `packages/shared/src/git.ts` defines Git DTOs.
- `packages/services/src/git/git.ts` defines `IGitService`.
- `packages/services/src/git/gitService.ts` aggregates high-level semantics.
- `packages/services/src/git/repo/gitCliRepo.ts` is the thin Git CLI wrapper.

Existing capabilities: repository resolution, status / diff / branch comparison, stage / unstage / discard / commit, identity / refresh. Branch capability introduces no new platform-layer channel and does not bypass `GitService -> GitCliRepo -> Git CLI`.

## Goals

- Give UI a stable data source for the project's local branches.
- Real branch switching.
- New branch creation and switching.
- Structured blocked reasons on failure that can drive UI.
- Unified abstraction across local / remote / web.
- Keep Git native behavior; do not tighten to "dirty means no switching".

## Non-goals

- No stash, force switch, or discard-then-switch.
- No remote branch browsing and pull.
- No branch rename / delete.
- No rebase, merge, cherry-pick, submodule or other complex workflows.
- No commit-panel UI promise.

## Core Decisions

### 1. Follow Git's native blocking model

"Uncommitted changes forbid switching" is not a product rule. Git allows switching with uncommitted changes that the target branch would not overwrite; a blanket rule would be more conservative than Git and surprise users. UI needs to show the real blocked item, not "repository is not clean enough". Switching logic is based on the real `git switch` result.

### 2. No boolean `canSwitch` interface

Git has no stable, complete, low-cost dry-run for switching. Pre-judging from `status` diverges from the real `git switch` result (tracked / untracked overwrite, in-progress operations and other blockers). `switchBranch` / `createBranchAndSwitch` return a structured result: success returns the new `summary`, failure returns `issues`. UI may use `summary`, `getChanges` and `getIdentity` for a weak pre-click hint but never as the final admission check.

### 3. Branch capability stays in the existing Git service domain

`Types -> Config -> Repo -> Service -> Runtime -> UI`. No new `IPlatformService` capability, no separate channel.

## Capability Range

### Local Branch List

- Lists only `refs/heads/*`; no remote-tracking branches.
- Branch is a repo-level concept; not trimmed by workspace subdirectory.
- In detached HEAD, `currentBranchName` is empty but the local branch list is still returned.

### Switch Branch

- Input: target local branch name.
- Success returns the latest repository summary.
- Switching to the current branch is a successful no-op.
- When Git natively prevents switching, a structured blocked reason is returned.

### New Branch Creation and Switch

Creates from current `HEAD` and switches. First version promises: user-supplied branch name; optional `startPoint`; no automatic remote-branch inference; no complex tracking strategy.

## Interface

```ts
 getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
 switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
 createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
```

```ts
export interface GitSwitchBranchRequest extends GitRepositoryRequest {
  targetBranchName: string;
}

export interface GitCreateBranchRequest extends GitRepositoryRequest {
  branchName: string;
  startPoint?: string;
}
```

## Shared DTOs (`packages/shared/src/git.ts`)

### Branch List

```ts
export interface GitLocalBranch {
  name: string;
  isCurrent: boolean;
  upstreamName: string | null;
  commitHash: string | null;
  commitTimestampMs: number | null;
}

export interface GitLocalBranchListResult {
  headRefType: GitHeadRefType;
  currentBranchName: string | null;
  branches: GitLocalBranch[];
}
```

Sorting: current branch first, the rest by most recent commit time descending, then name ascending.

### Switch / Create Result

```ts
export type GitBranchMutationAction = "switch" | "create-and-switch";

export type GitBranchMutationIssueCode =
  | "invalid-branch-name"
  | "branch-already-exists"
  | "target-branch-not-found"
  | "tracked-changes-would-be-overwritten"
  | "untracked-changes-would-be-overwritten"
  | "conflicts-present"
  | "operation-in-progress"
  | "branch-in-other-worktree"
  | "unknown";

export interface GitBranchMutationIssue {
  code: GitBranchMutationIssueCode;
  message: string;
  paths?: string[];
  detail?: string | null;
}

export interface GitBranchMutationResult {
  ok: boolean;
  action: GitBranchMutationAction;
  branchName: string | null;
  didChange: boolean;
  created: boolean;
  summary: GitRepositorySummary;
  issues: GitBranchMutationIssue[];
}
```

- `ok=true`, `didChange=true`: switch really completed.
- `ok=true`, `didChange=false`: successful no-op (for example switching to the current branch).
- `ok=false`: blocked by Git's native rules, or illegal input.

## Repo Layer (`GitCliRepo`)

```ts
listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult>;
switchBranch(workspacePath: string, targetBranchName: string): Promise<GitBranchMutationResult>;
createBranchAndSwitch(
  workspacePath: string,
  branchName: string,
  startPoint?: string,
): Promise<GitBranchMutationResult>;
```

### listLocalBranches

```bash
git for-each-ref refs/heads \
  --format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)
```

- Stable format; no parsing of human-readable output.
- `cwd` is `repoRoot`.
- In detached HEAD, no entry may have `isCurrent=true`.

### switchBranch

```bash
git switch --no-guess <branchName>
```

(The `--` form is avoided in the actual implementation to keep the command structure intact.)

- `--no-guess` stops Git from inferring a remote-tracking branch and creating a local branch.
- Minimal pre-checks only: repository exists, target branch name non-empty.
- The real blocked judgment is based on `git switch` stderr and exit code.

### createBranchAndSwitch

Validate the name first:

```bash
git check-ref-format --branch <branchName>
```

Then:

```bash
git switch --no-guess -c <branchName> [startPoint]
```

- Created from current `HEAD` by default.
- `startPoint` is a reserved extension point; the first UI does not expose it.
- An existing branch returns a structured error; there is no overwrite-style creation.

## Blocking Model

### Blockers passed through and structured

- Tracked files would be overwritten. Git message: `Your local changes to the following files would be overwritten by checkout`. Code: `tracked-changes-would-be-overwritten`.
- Untracked files would be overwritten. Git message: `The following untracked working tree files would be overwritten by checkout`. Code: `untracked-changes-would-be-overwritten`.
- Conflicts present. Detected through `isConflicted` in `status`, with stderr parsing as fallback on failure. Code: `conflicts-present`.
- Operation in progress (merge, rebase, cherry-pick, revert, bisect). The repo layer checks lightweight markers: `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `rebase-merge/`, `rebase-apply/`, `BISECT_LOG`. Code: `operation-in-progress`. `git switch` does not always give stable error semantics for these, so early identification helps UI explanation.
- Branch checked out in another worktree. Git message contains `is already checked out at`. Code: `branch-in-other-worktree`.

### Not blockers (follow Git native behavior)

- Dirty repository whose changes the target branch does not overwrite.
- Untracked files on unrelated paths that the target branch does not occupy.
- Switching to the current branch.

## Service Layer

`GitService` closes high-level semantics:

- `getLocalBranches` returns the repo-layer result directly.
- `switchBranch` / `createBranchAndSwitch` re-read `getStatus` after repo success.
- Raw failure results from the repo are mapped uniformly so UI always receives stable DTOs.
- When `workspacePath` is a monorepo subdirectory, branch operations still act on the whole `repoRoot`; the returned `summary.workspacePath` keeps the current workspace view for consistency with other Git capabilities.

## Cache and Refresh

`GitCliRepo` reuses in-flight `resolveRepository(workspacePath)` and `getStatus(workspacePath)`. Switch and create are real writes that change `branchName`, `trackingBranchName`, `ahead/behind`, `isDirty` and the diff / branch comparison baseline. A repo-level cache invalidation method is added:

```ts
invalidate(workspacePath: string): void;
```

It is called after `stage`, `unstage`, `discard`, `commit`, `switchBranch` and `createBranchAndSwitch`, so refresh never reuses a pre-switch snapshot.

## Call Flow

1. Open branch dropdown: UI calls `getLocalBranches`, shows the list, highlights the current branch by `isCurrent`.
2. User clicks a branch: UI calls `switchBranch`. On `ok=true`, update repository status from the returned `summary` and trigger related data refresh. On `ok=false`, choose messaging from `issues`; if the blocker relates to uncommitted changes, guide the user into the commit flow.
3. User confirms a new branch name: UI calls `createBranchAndSwitch`; success updates repository status; failure shows the structured error.

## Relation to Commit

No new `commit` underlying capability is needed: the service already has `stagePaths`, `commit`, `getIdentity` and `getChanges`. A "commit then switch" guide is UI orchestration on top of "switch failure returns structured issues"; there is no combined `commitAndSwitch` action in this design.

## Test Coverage

In `packages/services/test/gitService.test.ts`:

- Lists local branches with the current-branch marker correct.
- Clean repository: switch succeeds.
- Switch to the current branch: successful no-op.
- Dirty repository with changes that do not conflict with the target: switch allowed.
- Tracked file would be overwritten: switch fails.
- Untracked file would be overwritten: switch fails.
- Conflicts present: structured block.
- Merge / rebase or other in-progress state: structured block.
- Create-and-switch succeeds.
- Illegal new branch name.
- Existing branch name fails.
- Monorepo subdirectory workspace still acts on `repoRoot`.

## Future Extension Points

- Remote branch list and creating a local branch from a remote branch.
- Branch rename / delete.
- Optional stash flow before switching.
- Richer branch metadata (ahead/behind, latest commit summary).

These must not change the core boundaries: branch operations stay in the Git service domain; blocked judgment stays based on the real Git command result; UI guides, the service provides real, stable results.

## UI Landing

- Entry below the chat input: an independent branch pill trigger, not on the same row as model / mode selection.
- The trigger shows the current branch; in `detached HEAD` it shows detached-state copy.
- The expanded panel is a searchable local branch list: the current branch is highlighted; if the current branch has uncommitted changes, it shows "uncommitted changes: N files"; the bottom has a "create and check out new branch..." entry.
- Clicking an existing branch calls `switchBranch` directly.
- The create entry opens a lightweight form; submit calls `createBranchAndSwitch`.
- If a switch fails with `tracked / untracked changes would be overwritten`, no toast: a blocking card lists the files that would be overwritten with +/- stats, and the user can continue into a "commit and switch branch" dialog.
- First version of "commit and switch branch": commits all uncommitted changes in the current workspace scope; no "include unstaged changes" toggle; no push / PR / draft options; after a successful commit, `switchBranch` is retried automatically.
- After a successful switch / create, UI refreshes the branch entry text, the header Git summary and Git side pane data.
- On failure, UI maps structured `issues` to readable copy and does not expose raw Git errors.

Responsibility boundary: the service only returns real Git results; UI owns entry layout, copy and the refresh chain.
