# Git Branch Switching and Creation Underlying Capability Design

## Document Positioning

This document is an incremental design of existing Git architecture and underlying service capabilities, focusing on:

- Local branch list reading
- Branch switching
- New branch creation and switching
- Structured blocked reason return in case of switching failure

This document only discusses Git underlying capability design, not expanding UI interaction, pop-up style, form details.

## Current Landing Status

As of April 15, 2026, the underlying capability has been landed to the following positions according to this solution:

- `packages/shared/src/git.ts`
  - Added local branch list, branch switching / creation switching shared DTO
- `packages/services/src/git/git.ts`
  - `IGitService` exposes `getLocalBranches`, `switchBranch`, `createBranchAndSwitch`
- `packages/services/src/git/repo/gitCliRepo.ts`
  - Added `git for-each-ref` local branch reading
  - Added `git switch --no-guess` switching and `git switch -c` creation and switching
  - Added switching failure / in-progress operation check and failure result structured mapping
- `packages/services/test/gitService.test.ts`
  - Added real Git repository integration test, covering success path, no-op, dirty allowed switching, covered block, conflict, in-progress operation, illegal branch name, existing branch, worktree occupy

## Background

The current project already has stable Git service layered architecture:

- `packages/shared/src/git.ts` defines Git DTO
- `packages/services/src/git/git.ts` defines `IGitService`
- `packages/services/src/git/gitService.ts` is responsible for high-layer semantics aggregation
- `packages/services/src/git/repo/gitCliRepo.ts` is responsible for Git CLI thin encapsulation

Existing capabilities have covered:

- Repository parsing
- status / diff / branch comparison
- stage / unstage / discard / commit
- Identity / refresh

Therefore, this time requirement should not introduce new platform layer channel, nor bypass existing `GitService -> GitCliRepo -> Git CLI` chain.

## Target

- For UI provide "current project pulled local branch" stable data source
- Provide real branch switching capability
- Provide "new branch creation and switching" capability
- In case of switching failure return can drive UI structured blocked reason
- Maintain local / remote / web three terminal unified abstraction
- Keep Git native behavior, not artificially tighten for "as long as dirty does not allow switching"

## Non-target

- Not do stash, force switch, discard changes then switch
- Not do remote branch browsing and pull
- Not do branch rename / delete
- Not do rebase, merge, cherry-pick, submodule and other complex Git workflow
- Not in this design directly promise UI submit panel

## Core Decision

### 1. Follow Git native blocking model

This time does not adopt "as long as there are uncommitted changes does not allow switching" product rule.

Reasons:

- Git native allows "there are uncommitted changes, but these changes will not be covered by target branch" switching
- If product layer one-size-fits-all, will比 Git more conservative, and user expectation inconsistent
- UI needs prompt is "real blocked item", rather than "repository is not clean enough"

Therefore, switching logic based on real `git switch` result.

### 2. Not separately provide boolean type `canSwitch` interface

Do not recommend adding `canSwitchToBranch(): boolean` similar interface.

Reasons:

- Git doesn't have stable, complete, low-cost dry-run switching command
- Only based on `status` do pre-judgements, easy and real `git switch` result inconsistent
- `tracked` cover, `untracked` cover, in-progress operation and other blocked items, best with real switching command result as authoritative source

Therefore, recommend by `switchBranch` / `createBranchAndSwitch` directly return structured result:

- Success: return new `summary`
- Failure: return `issues`

If UI needs in click before make weak prompt, can continue reuse existing `summary`, `getChanges`, `getIdentity` capability, but cannot take them as final准入 judgment.

### 3. Branch capability continues placed in existing Git service domain

New capability still falls in:

`Types -> Config -> Repo -> Service -> Runtime -> UI`

Do not newly add `IPlatformService` capability, do not newly add separate channel.

## Capability Range

### 1. Local Branch List

Used to support UI display "current repository already existed local branch".

Restrictions:

- Only list `refs/heads/*`
- Do not list remote-tracking branch
- Branch is repo level concept, not按 workspace 子目录裁剪
- If current处于 detached HEAD 时，`currentBranchName` 为空，但仍返回 local branch list

### 2. Switch Branch

Input target local branch name, try switch.

Behavior:

- Success时返回 latest repository summary
- If switch to current branch, is considered success no-op
- If Git native prevent switching, return structured blocked reason

### 3. New Branch Creation and Switch

Default from current `HEAD` create new branch and switch.

First version only promise:

- User input branch name
- Optional input `startPoint`
- Do not auto infer remote branch
- Do not automatically set complex tracking strategy

## Interface Design

It is recommended to in `IGitService` newly add 3 个 methods:

```ts
 getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
 switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
 createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
```

It is recommended newly add request types:

```ts
export interface GitSwitchBranchRequest extends GitRepositoryRequest {
  targetBranchName: string;
}

export interface GitCreateBranchRequest extends GitRepositoryRequest {
  branchName: string;
  startPoint?: string;
}
```

## Shared DTO Design

It is recommended to in `packages/shared/src/git.ts` newly add following types.

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

Sorting recommendations:

- Current branch排 first -其余按最近 submission time倒序
- Time same again按名称升序

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

Semantic explanation:

- `ok=true` 且 `didChange=true`：真实完成 switch
- `ok=true` 且 `didChange=false`：成功 no-op，例如 switch 到 current branch
- `ok=false`：被 Git 原生 rules prevent, 或 input illegal

## Repo Layer Design

It is recommended to in `GitCliRepo` newly add following capability:

```ts
listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult>;
switchBranch(workspacePath: string, targetBranchName: string): Promise<GitBranchMutationResult>;
createBranchAndSwitch(
  workspacePath: string,
  branchName: string,
  startPoint?: string,
): Promise<GitBranchMutationResult>;
```

### 1. listLocalBranches

It is recommended command:

```bash
git for-each-ref refs/heads \
  --format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)
```

Design key points:

- Use stable format, avoid parsing human-readable output
- `cwd` still 以 `repoRoot` execute
- detached HEAD 时，`branches` 中可能没有 `isCurrent=true`

### 2. switchBranch

It is recommended command:

```bash
git switch --no-guess -- <branchName>
```

Actual implementation时，为避免 `--` 误伤 command 结构，推荐 use:

```bash
git switch --no-guess <branchName>
```

Design key points:

- `--no-guess` 避免 Git 因 remote-tracking branch 自动 infer并创建 local branch
- 先做 minimal 前置 verification：仓库 exists、target branch name non-empty
- 真正的 blocked judgment based on `git switch` 的 stderr 与 exit code 为准

### 3. createBranchAndSwitch

It is recommended first verification branch name:

```bash
git check-ref-format --branch <branchName>
```

Then execute:

```bash
git switch --no-guess -c <branchName> [startPoint]
```

Design key points:

- Default from current `HEAD` create
- `startPoint` 先作为底层 extension口 reserved，UI first version can not expose
- If branch 已经存在，直接返回 structure 错误，不 do cover式 create

## Blocking Model

### 1. Should directly透传并 structure 化的 blocking item

#### Tracked 文件 will be cover

Git common提示：

- `Your local changes to the following files would be overwritten by checkout`

Mapping为：

- `tracked-changes-would-be-overwritten`

#### untracked 文件 will be cover

Git common提示：

- `The following untracked working tree files would be overwritten by checkout`

Mapping为：

- `untracked-changes-would-be-overwritten`

#### Current exists conflict

可以通过现有 `status` 里的 `isConflicted` 快速发现，也可以在 failure 时兜底 parse stderr。

Mapping为：

- `conflicts-present`

#### 仓库 exists进行中操作

例如 merge、rebase、cherry-pick、revert、bisect。

建议 repo layer increase lightweight check:

- `MERGE_HEAD`
- `CHERRY_PICK_HEAD`
- `REVERT_HEAD`
- `REBASE_HEAD`
- `rebase-merge/`
- `rebase-apply/`
- `BISECT_LOG`

Mapping为：

- `operation-in-progress`

这样做 reasons 是这类 status 不一定都通过 `git switch` 给出足够 stable error semantics，提前 identify 更利于 UI 解释。

#### Branch 正在 other worktree 中使用

Git common提示中会出现：

- `is already checked out at`

Mapping为：

- `branch-in-other-worktree`

### 2. 不 should 作为 blocking item situation

- 仓库 dirty，但这些改动不会被 target branch cover
- 存在无关 path 的 untracked file，且 target branch 不会 occupy 这些 path
- 切换到 current branch

这几类都 should 尽量 follow Git 原生 behavior。

## Service Layer Design

`GitService` 继续 undertake "high-layer semantics closure" 的职责。

It is recommended behavior:

- `getLocalBranches` 直接返回 repo layer result
- `switchBranch` / `createBranchAndSwitch` 在 repo success 后重新 读取 `getStatus`
- 对 repo 返回的原始 failure result do unified mapping，保证 UI 永远 receive stable DTO

It is recommended在 service 层做一次额外收口：

- 如果当前 `workspacePath` 是 monorepo 子 directory， branch operation 仍然作用于整个 `repoRoot`
- 返回的 `summary.workspacePath` 仍保留当前 workspace 视角，保持 UI 与 other Git 能力 consistent

## 缓存与刷新

当前 `GitCliRepo` 内部会复用进行中的：

- `resolveRepository(workspacePath)`
- `getStatus(workspacePath)`

Branch switch 与 create 属于 real write operation，可能导致：

- `branchName`
- `trackingBranchName`
- `ahead/behind`
- `isDirty`
- diff / branch comparison 基准

全部变化。

因此建议补一个 repo 级 cache 失效 method，例如：

```ts
invalidate(workspacePath: string): void;
```

并在以下 operation 后调用：

- `stage`
- `unstage`
- `discard`
- `commit`
- `switchBranch`
- `createBranchAndSwitch`

这样可以避免刷新过程中复用到 switch 前 old 快照。

## Recommended Call Flow

### 1. 打开 branch 下拉

1. UI 调用 `getLocalBranches`
2. 展示 local branch list
3. 当前 branch 根据 `isCurrent` 高亮

### 2. 用户点击切换某个 branch

1. UI 调用 `switchBranch`
2. 如果 `ok=true`
   - 用返回的 `summary` 更新 repository status
   - 触发相关 data refresh
3. 如果 `ok=false`
   - 根据 `issues` 决定提示文案
   - 如果 blocking reason 与 uncommitted 改动相关，可 further guide user 进入 submit 流程

### 3. 用户输入 new branch 名并确认

1. UI 调用 `createBranchAndSwitch`
2. 成功则更新 repository status
3. 失败则展示 structure 错误

## 与 submit 能力的关系

本 design 不需要 newly `commit` 底层 capability。

Reasons:

- Current service 已经具备 `stagePaths`
- Current service 已经具备 `commit`
- Current service 已经具备 `getIdentity`
- Current service 已经具备 `getChanges`

这意味着 UI subsequent 如果要做 "检测到 block 后，guide user 先 submit 再 switch"，底层能力已经足够。

It is recommended practice is:

- First complete "switch failure -> return structured issues"
- Then由 UI 决定 whether popup submit guide

而不是在本 design 中 directly introduce `commitAndSwitch` 这类 combination action。

## 测试 recommendations

It is recommended to在 `packages/services/test/gitService.test.ts` 增加 coverage：

- 能 list local branch，且当前 branch marker correct
- clean 仓库 switch branch success
- switch 到 current branch 返回 no-op 成功
- dirty 仓库 but 改动与 target branch 无 conflict 时 allow switch
- tracked 文件会被 target branch cover 时 switch failure
- untracked 文件会被 target branch cover 时 switch failure
- 仓库 exists conflict 时 return structure 阻塞
- 仓库 exists merge / rebase 等进行中 status 时 return structure 阻塞
- 新建 branch 并 switch 成功
- 新建 branch 名 illegal
- 新建 already exists branch failure
- monorepo 子 directory workspace 下调用仍 correct作用于 repoRoot

## 后续扩展点

如果后续产品继续 extension，可以在这个 design 上 natural 演进：

- Support remote branch list 与 "基于远端 branch 创建 local branch"
- Support branch rename / delete
- Support switch 前的可选 stash 流程
- Support more fine branch metadata，例如 ahead/behind、最近 submission 摘要

这些 capability 都不 should 影响本 design 的 core boundary：

- Branch operation 仍属于 Git service domain
- 阻塞 judgment 仍尽量 based on Git 原命 command result 为 authoritative source
- UI 负责 guide，service 负责提供真实且 stable 的 ability result

## UI Landing Supplement（2026-04-15）

基于本文底层 capability，当前 UI 侧补充了以下交互约定：

- 功能入口放在聊天输入框下方，采用独立的 branch pill 触发器，不和模型 / 模式选择混在同一行
- 触发器 default 显示当前 branch；`detached HEAD` 时展示 detached 状态文案
- 展开后使用带 search 的 local branch list：
  - 当前 branch 高亮
  - 当前 branch exists uncommitted 改动时，展示 "uncommitted changes：N 个文件"
  - 底部 provide "create and check out new branch..." 入口
- 点击已有 branch 时直接调用 `switchBranch`
- 点击 create 入口后 popup lightweight form， submit 时调用 `createBranchAndSwitch`
- 如果 switch failure 属于 `tracked / untracked changes would be overwritten`
  - 不再直接 toast
  - 改为 popup 阻塞 card，列出会被 cover 文件及 +/- 统计
  - user can continue进入 "submit and switch branch" popup
- "submit and switch branch" popup first version do simplification:
  - 默认 submit 当前 workspace scope 内全部 uncommitted 改动
  - 不提供 "包含取消暂存的改动" switch
  - 不提供 push / PR / draft 选项
  - commit 成功后自动 retry `switchBranch`
- 切换 / create 成功后，UI 会同时刷新：
  - 当前 branch 入口文案
  - header Git 摘要
  - Git side pane 数据
- 切换 failure 时优先根据 structure 化的 `issues` mapping user 可读提示，不直接 expose 底层 Git 原始 error

这样可以 keep 责任 boundary clear：

- service 继续 only 负责 return真实 Git 结果
- UI 负责入口 layout、提示文案和刷新 chain 编排
