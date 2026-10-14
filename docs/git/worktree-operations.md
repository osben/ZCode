# Git Worktree list/create/remove primitives design

Updated: 2026-10-13

## 文档定位

This document extends [Git architecture](./architecture.md) and the [Git service foundation summary](./service-foundation.md) with four low-level operations:

- `listWorktrees`：列出当前仓库的全部 worktree（主工作树 + 关联工作树）
- `createWorktree`：在指定目录基于基准分支创建新分支的关联 worktree
- `removeWorktree`: removes one linked worktree of the repository (added 2026-10-13)
- `pruneWorktrees`: prunes stale administrative records pointing at removed directories (added 2026-10-13)

上层产品背景见 `docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md`。本文只定义 Git 底层契约，不展开 Command Center / composer UI 细节。

## 边界与不变量

- Worktree 操作属于常规 Git 业务能力，沿用 `UI -> IGitService (RPC) -> GitService -> GitCliRepo -> Git CLI` 链路；UI 永远不直接调用 Git CLI 或 Repo。
- 命令执行位置跟随 workspace 所在的 Host（本地 / 远端 / Web 一致）；浏览器路径不视为本地路径。
- 输入输出中的路径均为绝对路径；`workspacePath` 是定位仓库的入口，worktree 目录本身可以成为新的 workspace 并走现有打开/去重流程。
- Excluded from this stage: branch deletion, sparse checkout, reusable worktree pools, remote path-template policy. Target path computation (Worktree location settings) belongs to the layer above; the service receives only the final absolute path.
- `removeWorktree` makes no product-level "is this the current workspace / does it have open tabs" decision — that guard belongs to the UI layer; the service enforces Git semantics only (main worktree refusal, dirty check, locked check).

## listWorktrees

### 输入

```ts
interface GitRepositoryRequest {
  workspacePath: string;
}
```

### 命令

```
git worktree list --porcelain -z
```

于 `resolveRepository` 得到的 `repoRoot` 下执行，沿用默认命令超时与输出上限。

### 输出

```ts
interface GitWorktreeListResult {
  isGitAvailable: boolean;
  isRepository: boolean;
  worktrees: GitWorktreeEntry[];
}

interface GitWorktreeEntry {
  path: string; // 绝对路径，来自 porcelain 的 worktree 行
  headCommitHash: string | null;
  branchName: string | null; // refs/heads/<name> 的短名；detached / bare 为 null
  isMain: boolean; // 主工作树（porcelain 首个条目）
  isBare: boolean;
  isDetached: boolean;
  isCurrent: boolean; // entry.path === 当前 workspace 所在 worktree 的 repoRoot
}
```

### 解析规则

- NUL 分隔属性记录；记录以 `worktree` / `HEAD` / `branch` / `bare` / `detached` 开头；`locked` / `prunable` 带可选原因参数，本阶段忽略。路径字段按字节边界读取，不做 C-quote 解码或空白裁剪。
- bare 条目没有 `HEAD` / `branch` 行，`headCommitHash` 与 `branchName` 置 null。
- `isMain` 取首个条目（Git 文档保证主工作树列在最前）。
- `isCurrent` 通过与 `git rev-parse --show-toplevel` 结果比较得出；两个路径都来自 Git 自身输出，规范化斜杠后直接比较。

### 非仓库行为

`isGitAvailable=false` 或 `isRepository=false` 时返回结构化空结果（`worktrees: []`），不抛异常，与 `listLocalBranches` 的降级方式一致。

## createWorktree

### 输入

```ts
interface GitCreateWorktreeRequest extends GitRepositoryRequest {
  branchName: string; // 在新 worktree 中创建/检出的分支
  baseBranch?: string; // 新分支的起点；缺省 HEAD。仅在分支不存在时使用
  targetPath: string; // 新 worktree 的绝对目录路径；必须不存在
}
```

### 命令

- 分支不存在（`git show-ref --verify --quiet refs/heads/<branchName>` 探测）：
  - 有 base：`git worktree add -b <branchName> -- <targetPath> <baseBranch>`
  - 无 base：`git worktree add -b <branchName> -- <targetPath>`
- 分支已存在：`git worktree add -- <targetPath> <branchName>`（直接检出已有分支；此时 `baseBranch` 被忽略）。该路径使「分支已被其他 worktree 占用」能被 Git 原生错误捕获并分类。

`--` 用于终止选项解析，防止外部输入以 `-` 开头被解析为选项。

### 输出

```ts
interface GitWorktreeCreateResult {
  ok: boolean;
  worktreePath: string | null; // 成功时为 targetPath
  branchName: string | null;
  issues: GitWorktreeMutationIssue[];
}
```

失败不抛异常（超时/输出超限等基础设施错误除外），统一返回结构化 issue，供 composer 在字段旁展示。

### 错误分类

| code                       | 触发条件                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `git-unavailable`          | 环境中找不到可用的 Git binary                                                                  |
| `not-a-repository`         | workspace 不在 Git 仓库内                                                                      |
| `invalid-branch-name`      | 分支名为空或未通过 `git check-ref-format --branch`（复用分支切换的校验）                       |
| `target-path-invalid`      | targetPath 为空或不是绝对路径                                                                  |
| `target-path-exists`       | targetPath 已存在。注意：Git 允许在已存在的空目录创建 worktree，确定性拒绝由服务层前置检查保证 |
| `branch-already-exists`    | stderr 含 `a branch named ... already exists`（并发创建同名分支等）                            |
| `branch-in-other-worktree` | stderr 含 `is already used by worktree at`（复用既有分类文案；含分支被主工作树占用的情况）     |
| `target-branch-not-found`  | stderr 含 `invalid reference:`（baseBranch 不存在）                                            |
| `unknown`                  | 其它 Git 失败                                                                                  |

`invalid-branch-name` / `branch-already-exists` / `target-branch-not-found` / `branch-in-other-worktree` / `unknown` 与 `GitBranchMutationIssueCode` 复用同一字面量；worktree 新增 `target-path-*` / `not-a-repository` / `git-unavailable`。

### 不变量

- 调用前校验顺序：仓库可用 → 分支名 → targetPath 非空且绝对 → 分支名格式 → targetPath 不存在 → 探测分支存在性 → 执行命令。
- 创建成功前不得创建任何目录或分支（Git 单命令完成目录+分支创建，无部分成功状态）。
- 命令失败时 stderr 经分类器映射；超时 / 输出超限走 `ensureGitCommandSucceeded` 抛错，不吞并为 `unknown`。

## removeWorktree

### Input

```ts
interface GitRemoveWorktreeRequest extends GitRepositoryRequest {
  /** Absolute directory of the worktree to remove; must be a linked worktree of this repository (never the main worktree). */
  targetPath: string;
  /** true skips the dirty and locked checks (git worktree remove --force). */
  force?: boolean;
}
```

### Command

```
git worktree remove -- <targetPath>          # force unset/false
git worktree remove --force -- <targetPath>  # force true
```

Executed in the `repoRoot` produced by `resolveRepository`. `--` ends option parsing.

### Output

```ts
interface GitWorktreeRemoveResult {
  ok: boolean;
  issues: GitWorktreeMutationIssue[];
}
```

Failures do not throw (except infrastructure errors); they return structured issues.

### Error classification (new literals)

| code                 | Trigger                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktree-not-found` | No linked entry with `entry.path === targetPath` in the pre-checked `listWorktrees` (porcelain); also covers the main worktree (identified by `isMain`, refused the same way) |
| `worktree-dirty`     | stderr contains `contains modified or untracked files` (dirty refusal without force)                                                                                          |
| `worktree-locked`    | stderr contains `is locked` (locked/prunable reasons were ignored before, but remove is still refused by Git)                                                                 |
| everything else      | Reuses the existing `GitWorktreeMutationIssueCode` (`git-unavailable` / `not-a-repository` / `target-path-invalid` / `unknown`)                                               |

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

Executed in `repoRoot`. `--expire now` keeps the outcome deterministic (nothing stays back "not yet expired"); `--verbose` prints one line per pruned record, used only for the count.

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
- Output lines are counted only; the raw stderr wording is not surfaced to the layer above.

## 测试要求

- `listWorktrees`：仅主工作树 → 单条目；经真实 `createWorktree` 创建关联 worktree 后 → 两条目且路径/分支正确；detached worktree 的 `branchName=null`；包含空格、非 ASCII 字符及换行的 worktree 路径原样保留；非仓库路径 → 空结果。
- `createWorktree`：成功创建目录与分支且 HEAD 指向新分支、起点为 baseBranch；分支被其它 worktree 占用 → `branch-in-other-worktree`；targetPath 已存在 → `target-path-exists`；非法分支名 → `invalid-branch-name`。
- `removeWorktree`: after creating a linked worktree and removing it → directory and record gone, `listWorktrees` back to a single entry; main worktree path → `worktree-not-found`; path outside the repository → `worktree-not-found`; uncommitted changes without force → `worktree-dirty`, with force → success; non-repository → `not-a-repository`.
- `pruneWorktrees`: after deleting a created worktree directory by hand, prune → `prunedCount >= 1` and `listWorktrees` no longer lists it; clean repository → `prunedCount = 0`, `ok = true`.
