# Git Worktree List/Create/Remove Primitive Design

Updated: 2026-10-13

## Document Positioning

This document extends [Git architecture](./architecture.md) and the [Git service foundation summary](./service-foundation.md) with four low-level operations:

- `listWorktrees`：List current repository's all worktrees（main worktree + linked worktrees）
- `createWorktree`：在指定 directory based on benchmark branch create new branch's linked worktree
- `removeWorktree`: Remove one linked worktree of the repository（added 2026-10-13）
- `pruneWorktrees`: Prune stale administrative records pointing at removed directories（added 2026-10-13）

上层产品 background 见 `docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md`。本文只定义 Git underlying contract，不 expand Command Center / composer UI 细节。

## Boundaries and Invariants

- Worktree operations are regular Git business capabilities, follow `UI -> IGitService (RPC) -> GitService -> GitCliRepo -> Git CLI` chain；UI永远 not directly call Git CLI or Repo。
- Command execution position follows workspace environment的 Host（本地 / 远端 / Web 一致）；浏览器 path not视为本地 path。
- Input/output 中的 path 均为 absolute path；`workspacePath` 是定位 repository 的入口，worktree 目录本身可以成为新的 workspace 并走 existing 打开/去重流程。
- Excluded from this stage：branch deletion, sparse checkout, reusable worktree pools, remote path-template policy. Target path computation (Worktree location settings) belongs to the layer above； the service receives only the final absolute path。
- `removeWorktree` makes no product-level "is this the current workspace / does it have open tabs" decision — that guard belongs to the UI layer； the service enforces Git semantics only (main worktree refusal, dirty check, locked check)。

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

在 `resolveRepository` 得到的 `repoRoot` 下执行，沿用默认 command timeout 与 output upper limit。

### Output

```ts
interface GitWorktreeListResult {
  isGitAvailable: boolean;
  isRepository: boolean;
  worktrees: GitWorktreeEntry[];
}

interface GitWorktreeEntry {
  path: string; // absolute path，来自 porcelain 的 worktree 行
  headCommitHash: string | null;
  branchName: string | null; // refs/heads/<name> 的 short name；detached / bare 为 null
  isMain: boolean; // main worktree（porcelain 首个 entry）
  isBare: boolean;
  isDetached: boolean;
  isCurrent: boolean; // entry.path === 当前 workspace 所在 worktree 的 repoRoot
}
```

### Parsing Rules

- NUL 分隔 attributes record；record 以 `worktree` / `HEAD` / `branch` / `bare` / `detached` 开头；`locked` / `prunable` 带 optional cause parameter，本 stage ignores。path field 按 byte boundary reading，不做 C-quote decode or blank裁剪。
- bare 条目没有 `HEAD` / `branch` 行，`headCommitHash` 与 `branchName` 置 null。
- `isMain` 取首个条目（Git document guarantee main worktree 列在最前）。
- `isCurrent` 通过与 `git rev-parse --show-toplevel` 结果 comparison得出；两个 path 都来自 Git 自身 output，规范化 slash 后直接 comparison。

### Non-Repository Behavior

`isGitAvailable=false` 或 `isRepository=false` 时返回 structure 化空 result（`worktrees: []`），不 throw exception，与 `listLocalBranches` 的 degradation way 一致。

## createWorktree

### Input

```ts
interface GitCreateWorktreeRequest extends GitRepositoryRequest {
  branchName: string; // 在新 worktree 中创建/检出的 branch
  baseBranch?: string; // 新 branch 的起点；缺省 HEAD。Only when branch 不存在时 use
  targetPath: string; // New worktree 的 absolute directory path；must 不存在
}
```

### Command

- Branch 不存在（`git show-ref --verify --quiet refs/heads/<branchName>` detection）：
  - 有 base：`git worktree add -b <branchName> -- <targetPath> <baseBranch>`
  - 无 base：`git worktree add -b <branchName> -- <targetPath>`
- Branch 已经存在：`git worktree add -- <targetPath> <branchName>`（直接 checkout 已有 branch；此时 `baseBranch` 被 ignore）。This path使「branch 被 other worktree 占用」能被 Git 原生 error capture 并 classify。

`--` used to terminate option parsing，prevent external input 以 `-` 开头被 parse 为 option。

### Output

```ts
interface GitWorktreeCreateResult {
  ok: boolean;
  worktreePath: string | null; // success 时为 targetPath
  branchName: string | null;
  issues: GitWorktreeMutationIssue[];
}
```

failure 不 throw exception（timeout / output over limit 等 infrastructure error除外），统一返回 structure issue，供 composer 在 field 旁展示。

### Error Classification

| code                       | Trigger condition                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `git-unavailable`          | Environment 中找不到可用的 Git binary                                                                                         |
| `not-a-repository`         | workspace 不在 Git repository 内                                                                                              |
| `invalid-branch-name`      | Branch name empty or not passed `git check-ref-format --branch`（reuse branch switching verification）                        |
| `target-path-invalid`      | targetPath empty or not absolute path                                                                                         |
| `target-path-exists`       | targetPath 已存在。note：Git allows 在已存在的空 directory 创建 worktree，确定性拒绝由 service 层前置 check 保证              |
| `branch-already-exists`    | stderr 含 `a branch named ... already exists`（concurrent create same name branch 等）                                        |
| `branch-in-other-worktree` | stderr 含 `is already used by worktree at`（reuse existing classification wording；含 branch 被 main worktree occupy 的情况） |
| `target-branch-not-found`  | stderr 含 `invalid reference:`（baseBranch 不存在）                                                                           |
| `unknown`                  | 其它 Git 失败                                                                                                                 |

`invalid-branch-name` / `branch-already-exists` / `target-branch-not-found` / `branch-in-other-worktree` / `unknown` 与 `GitBranchMutationIssueCode` 复用同一字面量；worktree 新增 `target-path-*` / `not-a-repository` / `git-unavailable`。

### Invariants

- 前置 check 顺序：repository available → branch name → targetPath non-empty absolute → branch name format → targetPath 不存在 → 探测 branch 存在性 → execute command。
- 命令 failure 时 stderr 经过 classifier mapping；timeout / output over limit 走 `ensureGitCommandSucceeded` throw exception，不吞并为 `unknown`。
- Git 在 mkdir 之前创建 branch ref，因此 `worktree add -b` 可能在 directory 创建失败（如 EACCES）后留下半成品 branch。Rollback 规则：本次调用前 branch 不存在（`branchAlreadyExists=false`）、命令失败后 branch 已存在、且 classifier 结果不含 `branch-already-exists`（排除并发创建者的 branch）时，执行 `git branch -D <branchName>`（使用 `-D`，因为 base 可能未合并）。
- Rollback 自身失败（包括探测或 `branch -D` 抛出的 infrastructure error）只记录 warn，不覆盖原始失败的 `issues`，也不改变返回值。
- 本次调用前 branch 已存在时（直接 checkout 已有 branch）不回滚，即使命令失败。

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

Executed in the `repoRoot` produced by `resolveRepository`。`--` ends option parsing。

### Output

```ts
interface GitWorktreeRemoveResult {
  ok: boolean;
  issues: GitWorktreeMutationIssue[];
}
```

Failures do not throw（except infrastructure errors）；they return structured issues。

### Error classification (new literals)

| code                 | Trigger condition                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worktree-not-found` | No linked entry with `entry.path === targetPath` in the pre-checked `listWorktrees` (porcelain)；also covers the main worktree（identified by `isMain`，refused the same way） |
| `worktree-dirty`     | stderr contains `contains modified or untracked files`（dirty refusal without force）                                                                                          |
| `worktree-locked`    | stderr contains `is locked`（locked/prunable reasons were ignored before, but remove is still refused by Git）                                                                 |
| everything else      | Reuses the existing `GitWorktreeMutationIssueCode`（`git-unavailable` / `not-a-repository` / `target-path-invalid` / `unknown`）                                               |

### Invariants

- Validation order: repository available → targetPath non-empty absolute → porcelain probe confirms a linked non-main worktree of this repository → run the command。
- Removal completes through the single `git worktree remove` command（administrative records and directory together）；no manual `rm -rf`，no partial cleanup on Git failure。
- The branch itself is not deleted；`removeWorktree` affects only the working directory and the worktree administrative records。

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

Executed in `repoRoot`。`--expire now` keeps the outcome deterministic（nothing stays back "not yet expired"）；`--verbose` prints one line per pruned record，used only for the count。

### Output

```ts
interface GitWorktreePruneResult {
  ok: boolean;
  /** Number of stale administrative records reported by `git worktree prune --verbose`；parse failure counts as 0. */
  prunedCount: number;
  issues: GitWorktreeMutationIssue[];
}
```

### Invariants

- Prune removes only stale records whose directory no longer exists；it never touches existing worktree directories or branches。
- Output lines are counted only；the raw stderr wording is not surfaced to the layer above。

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

- `listWorktrees`：Only main worktree → single entry；after real `createWorktree` 创建关联 worktree → two entries with correct path/branch；detached worktree 的 `branchName=null`；contain spaces、non-ASCII characters及line break 的 worktree path原样保留；non-repository path → empty result。
- `createWorktree`：成功创建 directory 与 branch 且 HEAD 指向新 branch、起点为 baseBranch；branch 被 other worktree 占用 → `branch-in-other-worktree`；targetPath 已存在 → `target-path-exists`；非法 branch 名 → `invalid-branch-name`；create 失败且 branch 为本次创建时 → 该 branch 被回滚（不存在），branch 已存在时不触发回滚。
- `removeWorktree`: after creating a linked worktree and removing it → directory and record gone，`listWorktrees` back to a single entry；main worktree path → `worktree-not-found`；path outside the repository → `worktree-not-found`；uncommitted changes without force → `worktree-dirty`，with force → success；non-repository → `not-a-repository`。
- `pruneWorktrees`: after deleting a created worktree directory by hand, prune → `prunedCount >= 1` and `listWorktrees` no longer lists it；clean repository → `prunedCount = 0`，`ok = true`。
