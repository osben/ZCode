# Git Worktree List/Create/Remove Primitive Design

## Document Positioning

Extends [Git architecture](./architecture.md) and the [Git service foundation summary](./service-foundation.md) with four low-level operations:

- `listWorktrees`: list all worktrees of the current repository (main worktree + linked worktrees).
- `createWorktree`: create a linked worktree with a new branch at a given directory from a base branch.
- `removeWorktree`: remove one linked worktree of the repository.
- `pruneWorktrees`: prune stale administrative records pointing at removed directories.

Product background: `docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md`. This document defines only the underlying Git contract, not Command Center / composer UI details.

## Boundaries and Invariants

- Worktree operations are regular Git business capabilities on the chain `UI -> IGitService (RPC) -> GitService -> GitCliRepo -> Git CLI`; UI never calls the Git CLI or Repo directly.
- Command execution position follows the Host of the workspace environment (local / remote / Web alike); a browser path is not treated as a local path.
- All input/output paths are absolute. `workspacePath` locates the repository; a worktree directory itself may become a new workspace through the existing open/dedupe flow.
- Excluded from this stage: branch deletion, sparse checkout, reusable worktree pools, remote path-template policy. Target path computation (Worktree location settings) belongs to the layer above; the service receives only the final absolute path.
- `removeWorktree` makes no product-level decision such as "is this the current workspace / does it have open tabs"; that guard belongs to the UI layer. The service enforces Git semantics only (main worktree refusal, dirty check, locked check).

## listWorktrees

### Input

```ts
interface GitRepositoryRequest {
  workspacePath: string;
}
```

### Command

```
git worktree list --porcelain -z
```

Runs in the `repoRoot` from `resolveRepository`, with the default command timeout and output limit.

### Output

```ts
interface GitWorktreeListResult {
  isGitAvailable: boolean;
  isRepository: boolean;
  worktrees: GitWorktreeEntry[];
}

interface GitWorktreeEntry {
  path: string; // absolute path, from the porcelain worktree line
  headCommitHash: string | null;
  branchName: string | null; // short name of refs/heads/<name>; null for detached / bare
  isMain: boolean; // main worktree (first porcelain entry)
  isBare: boolean;
  isDetached: boolean;
  isCurrent: boolean; // entry.path === repoRoot of the worktree that contains the current workspace
}
```

### Parsing Rules

- NUL-separated attribute records; a record starts with `worktree` / `HEAD` / `branch` / `bare` / `detached`. `locked` / `prunable` carry an optional cause parameter, ignored at this stage. The path field is read on byte boundaries, with no C-quote decoding or whitespace trimming.
- A bare entry has no `HEAD` / `branch` line; `headCommitHash` and `branchName` are null.
- `isMain` is the first entry (Git documents that the main worktree is listed first).
- `isCurrent` compares against the result of `git rev-parse --show-toplevel`; both paths come from Git's own output, so after slash normalization they compare directly.

### Non-Repository Behavior

When `isGitAvailable=false` or `isRepository=false`, a structured empty result (`worktrees: []`) is returned without throwing, the same degradation as `listLocalBranches`.

## createWorktree

### Input

```ts
interface GitCreateWorktreeRequest extends GitRepositoryRequest {
  branchName: string; // branch created/checked out in the new worktree
  baseBranch?: string; // start point of the new branch; default HEAD. Used only when the branch does not exist
  targetPath: string; // absolute directory path of the new worktree; must not exist
}
```

### Command

- Branch does not exist (detected with `git show-ref --verify --quiet refs/heads/<branchName>`):
  - With base: `git worktree add -b <branchName> -- <targetPath> <baseBranch>`
  - Without base: `git worktree add -b <branchName> -- <targetPath>`
- Branch already exists: `git worktree add -- <targetPath> <branchName>` (checks out the existing branch; `baseBranch` is ignored). This path lets Git's native error report "branch used by another worktree" and be classified.

`--` ends option parsing so external input starting with `-` is not parsed as an option.

### Output

```ts
interface GitWorktreeCreateResult {
  ok: boolean;
  worktreePath: string | null; // targetPath on success
  branchName: string | null;
  issues: GitWorktreeMutationIssue[];
}
```

Failures do not throw (except infrastructure errors such as timeout / output over limit); structured issues are returned for the composer to show beside the field.

### Error Classification

| code                       | Trigger condition                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-unavailable`          | No usable Git binary in the environment                                                                                                               |
| `not-a-repository`         | Workspace is not inside a Git repository                                                                                                              |
| `invalid-branch-name`      | Branch name empty or fails `git check-ref-format --branch` (reuses branch switching validation)                                                       |
| `target-path-invalid`      | targetPath empty or not absolute                                                                                                                      |
| `target-path-exists`       | targetPath already exists. Git allows creating a worktree in an existing empty directory; the deterministic refusal comes from the service pre-check  |
| `branch-already-exists`    | stderr contains `a branch named ... already exists` (for example a concurrent creator of the same branch)                                             |
| `branch-in-other-worktree` | stderr contains `is already used by worktree at` (reuses the existing classification wording; includes a branch occupied by the main worktree)        |
| `target-branch-not-found`  | stderr contains `invalid reference:` (baseBranch does not exist)                                                                                      |
| `unknown`                  | Any other Git failure                                                                                                                                 |

`invalid-branch-name` / `branch-already-exists` / `target-branch-not-found` / `branch-in-other-worktree` / `unknown` share literals with `GitBranchMutationIssueCode`; worktree adds `target-path-*` / `not-a-repository` / `git-unavailable`.

### Invariants

- Pre-check order: repository available → branch name → targetPath non-empty absolute → branch name format → targetPath does not exist → probe branch existence → run command.
- On command failure stderr goes through the classifier; timeout / output over limit throw through `ensureGitCommandSucceeded` and are not swallowed into `unknown`.
- Git creates the branch ref before mkdir, so `worktree add -b` may leave a half-made branch after directory creation fails (for example EACCES). Rollback rule: when the branch did not exist before the call (`branchAlreadyExists=false`), the branch exists after the command fails, the classifier result does not contain `branch-already-exists` (excluding a concurrent creator's branch), and the branch tip still equals this call's start point (`baseBranch` or `HEAD`, meaning nobody committed on it), run compare-and-delete: `git update-ref -d refs/heads/<branchName> <observedTip>` (not `branch -d`, since the branch need not be merged; if the tip has moved, keep the branch and log `warn`).
- A rollback failure (including an infrastructure error from the probe or `update-ref -d`) only logs `warn`; it does not overwrite the original failure's `issues` or change the return value.
- When the branch already existed before the call (checking out an existing branch), no rollback happens even if the command fails.

## removeWorktree

### Input

```ts
interface GitRemoveWorktreeRequest extends GitRepositoryRequest {
  /** Absolute directory of the worktree to remove; must be a linked worktree of this repository (never the main worktree). */
  targetPath: string;
  /** true skips the dirty and locked checks (git worktree remove -f -f). */
  force?: boolean;
}
```

### Command

```
git worktree remove -- <targetPath>          # force unset/false
git worktree remove -f -f -- <targetPath>    # force true
```

Runs in the `repoRoot` from `resolveRepository`. `--` ends option parsing.

### Output

```ts
interface GitWorktreeRemoveResult {
  ok: boolean;
  issues: GitWorktreeMutationIssue[];
}
```

Failures do not throw (except infrastructure errors); structured issues are returned.

### Error classification (new literals)

| code                 | Trigger condition                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree-not-found` | No linked entry with `entry.path === targetPath` in the pre-checked `listWorktrees` (porcelain); also covers the main worktree (identified by `isMain`, refused the same way) |
| `worktree-dirty`     | stderr contains `contains modified or untracked files` (dirty refusal without force)                                                                                          |
| `worktree-locked`    | stderr contains `is locked` (locked/prunable reasons are ignored by listing, but remove is still refused by Git)                                                              |
| everything else      | Reuses the existing `GitWorktreeMutationIssueCode` (`git-unavailable` / `not-a-repository` / `target-path-invalid` / `unknown`)                                              |

### Invariants

- Validation order: repository available → targetPath non-empty absolute → porcelain probe confirms a linked non-main worktree of this repository → run the command.
- Removal completes through the single `git worktree remove` command (administrative records and directory together); no manual `rm -rf`, no partial cleanup on Git failure.
- The branch itself is not deleted; `removeWorktree` affects only the working directory and the worktree administrative records.

## pruneWorktrees

### Input

```ts
interface GitRepositoryRequest {
  workspacePath: string;
}
```

### Command

```
git worktree prune --verbose --expire now
```

Runs in `repoRoot`. `--expire now` keeps the outcome deterministic (nothing stays back "not yet expired"); `--verbose` prints one line per pruned record, used only for the count.

### Output

```ts
interface GitWorktreePruneResult {
  ok: boolean;
  /** Number of stale administrative records reported by `git worktree prune --verbose`; parse failure counts as 0. */
  prunedCount: number;
  issues: GitWorktreeMutationIssue[];
}
```

### Invariants

- Prune removes only stale records whose directory no longer exists; it never touches existing worktree directories or branches.
- Output lines are only counted; the raw stderr wording is not surfaced to the layer above.

## ensureWorktreeExclusion (inside placement)

### Positioning

When a worktree is created under `<repoRoot>/.worktrees/<branch>` (inside placement), the directory lies inside the main checkout and `git status` in the main checkout would list `.worktrees/` as untracked in Review. This primitive keeps the main checkout status clean without touching any tracked file.

### Requirement

- For inside placement the app guarantees a clean main-checkout status: after a successful creation, the line `.worktrees/` is present in the repository's shared exclude file.
- The exclude file is resolved by Git itself: `git rev-parse --git-path info/exclude` run in `repoRoot`. This is `.git/info/exclude` for a normal checkout and the common-dir file for linked worktrees and separate git-dirs. A relative result is resolved against `repoRoot`.
- The rule is local and best-effort: it never modifies `.gitignore` or any tracked file (a tracked `.gitignore` edit would itself dirty the status).
- Idempotent: when an equal line (after trim and CRLF normalization) already exists, nothing is written. Duplicate lines are never appended.
- Append-only: existing content is never rewritten. A missing trailing newline is terminated before the appended line. The `info/` directory and the file are created when absent.
- Target scope: the call is a no-op success when `targetPath` is not strictly inside `<repoRoot>/.worktrees/`. Both sides are compared through the realpath-normalized identity so symlinked roots (e.g. `/var` vs `/private/var`) match.
- Concurrent calls for the same exclude file are serialized inside the process so two creations cannot both observe "missing" and append twice.

### Input

```ts
interface GitWorktreeExcludeRequest extends GitRepositoryRequest {
  /** Absolute path of the worktree that was just created or reused. */
  targetPath: string;
}
```

### Output

```ts
type GitWorktreeExcludeResult = { ok: true } | { ok: false };
```

### Failure Handling

- Any failure (repository not available, Git path probe failure, filesystem error) is logged at `warn` and returned as `{ ok: false }`. The method never throws for these, and a failure never fails worktree creation or the reuse path; the UI treats it as informational.
- The UI calls the primitive through the shared `executeWorktreeCreation` path after the outcome is `created` or `existing-worktree`, and in the composer reconcile path when a registered worktree is settled as ready (a crash between creation and exclusion is recovered there). It awaits the call so the exclusion is in place before Review refreshes. Its result is not part of the creation outcome.

### Owner and Event Order

- Owner: the Git service (`GitCliRepo`) is the only writer of the shared exclude file; the UI only sends the command.
- Order: `createWorktree` succeeds → UI awaits `ensureWorktreeExclusion` → Review status refresh. The exclusion is not stored in app state, so there is no second source of truth to repair.

```text
UI executeWorktreeCreation ──create ok──▶ GitService.createWorktree
        │                                   (worktree dir + branch)
        └──await──▶ GitService.ensureWorktreeExclusion
                       ├─ target outside .worktrees/ → no-op ok
                       └─ append `.worktrees/` to info/exclude if missing → ok / warn + ok:false
```

### Test Requirements

- Missing exclude file: after an inside-placement creation the file contains the line; `git status --porcelain` in the main checkout no longer lists `.worktrees/`.
- Second call adds no duplicate line.
- Existing content (including a missing trailing newline) is preserved and only the line is appended.
- Target outside `.worktrees/` is a no-op success and writes nothing.
- A call from a linked worktree workspace writes to the shared common-dir exclude file.

## Test Requirements

- `listWorktrees`: only the main worktree → single entry; after a real `createWorktree` creates a linked worktree → two entries with correct path/branch; a detached worktree has `branchName=null`; worktree paths containing spaces, non-ASCII characters and line breaks are preserved as is; a non-repository path → empty result.
- `createWorktree`: success creates the directory and branch, HEAD points to the new branch, and the start point is baseBranch; branch occupied by another worktree → `branch-in-other-worktree`; targetPath exists → `target-path-exists`; illegal branch name → `invalid-branch-name`; creation fails and the branch was created by this call → the branch is rolled back (does not exist); no rollback when the branch already existed.
- `removeWorktree`: after creating a linked worktree and removing it → directory and record gone, `listWorktrees` back to a single entry; main worktree path → `worktree-not-found`; path outside the repository → `worktree-not-found`; uncommitted changes without force → `worktree-dirty`, with force → success; non-repository → `not-a-repository`.
- `pruneWorktrees`: after deleting a created worktree directory by hand, prune → `prunedCount >= 1` and `listWorktrees` no longer lists it; clean repository → `prunedCount = 0`, `ok = true`.
