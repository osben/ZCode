# Git UI Landing Status

Update date: 2026-07-07

## Current Target

Current stage already connected Git pane's "read real repository changes" main chain, and supplement top lightweight write operation entry. Current target is let user without leaving current workspace can both continue browsing changes, also through top entry complete submit or push.

## Commit Message Generation Model Chain

- Top "commit" popup adopts with standard overlay of compact lightweight operation panel: top displays current branch and this selection range `+/-` statistic, middle is commit message input area, bottom is commit action list.
- Top of popup current branch entry reuses `GitBranchSwitcher`，点击后 only expands可切换 local branch list； switching success 会重新读取 current branch's commit range，避免继续展示 old branch's staged / unstaged 快照。
- Popup top `+/-` statistic prioritizes reuse current conversation file modification summary，避免当前 conversation只改了少量文件时被 work area 里 other uncommitted changes放大；没有 conversation summary 时才回退到 current submission range's Git 统计。
- Commit message input area supports manual fill，也支持 click 图标先生成；如果 user 直接 click `commit` / `commit and push` 且 message 为空，UI 会先生成 Conventional Commit 消息再继续执行 action。
- Submit panel 默认包含未暂存改动，user 可以关闭 `包含未暂存的更改`，此时 submit、统计和生成消息都 only reference 已暂存改动。
- 生成提交消息会随 request 携带当前 conversation recent 的 user / assistant 文本 context，用于让 model 理解本轮 modification intent； context 按消息数和字符数裁剪，且生成结果不得显式 write "根据对话"、"按 user 要求" 等元叙述。
- 生成提交消息 reuse 当前 workspace 的 current model selection； Git service 只负责读取 Git status/diff、构造 limited prompt、校验 Conventional Commit output。
- Model 调用 chain 统一为 `Git service -> IZCodeAgentService -> ZCode Protocol workspace/generateText -> AgentRuntime -> modelAdapter.generateText`。
- UI 不再为提交消息生成 pre-take Start Plan / zcode-plan 的 request期鉴权 material，也不向 Git service 传 scoped runtime headers。
- Start Plan 的 request期 runtime headers 由 AgentRuntime 在 `modelAdapter.generateText` 每次真实 request 前通过 `providerRuntimeHeaders.request` 自动刷新；该机制与普通对话、prompt enhance 等 independent model request 一致。
- Git service 不再直连 OpenAI / Anthropic compatible HTTP endpoint，也不 parse provider response / SSE； protocol layer 返回 pure text 后由 Git service 做 output 清洗和 error 收敛。

## Completed UI

### 1. Top Entry

- `WorkspaceHeader` top toolbar already accessed Git entry
- 当当前 work area can detect `+/-` 行数统计时，顶部会展示 "Git 图标 + +/- 统计" 的integrated capsule button
- This statistic also 显示 when Git pane not opened，avoid user必须先点开 Git 才知道当前有改动
- Click 该 entry 会 open 或 close right Git pane

### 2. Right Git Pane

- Git 复用现有右侧共享 pane，与 browser / code-viewer 共 same slot
- pane 顶部保留 title 和 close button
- 主体区已收敛为更轻的 single column reading mode，避免一开始就堆叠过多 operation 区

### 3. Top Git Operation Entry

- 在 `WorkspaceHeader` 顶部 tool栏里，terminal switch button 左侧新增 "submit or push" capsule entry
- Main button按 current Git status优先执行 `submit`，没有未提交更改但存在可推送 submit 时执行 `push`
- Entry 右侧不再提供三点 / 下拉 menu，避免把 submit、push entry 拆成两套并列 path
- `submit` 会打开独立 submit 弹窗，默认把当前 workspace 作用域内的全部未提交更改一起暂存并 submit
- Submit popup 内额外 provide `submit and push`，成功 submit 后立即 reuse 同一 Git service 推送当前分支
- `push` 会打开独立 push 弹窗，执行真实 `git push`；若当前分支尚未建立 upstream，会在首次 push 时自动补充 `--set-upstream`

### 4. Source Switch

- 支持 4 个 source：
  - `Not staged`
  - `Staged`
  - `All branch changes`
  - `Previous round changes`
- 当前 selected source由 `App` 提升管理，保证 top entry statistic 和 Git pane 内容始终来自 same source

### 5. File List and Diff

- 列表项展示 workspace 相对 path full path
- File item 支持 expand / collapse
- Expanded后直接展示 inline diff，不再重复显示 path 和 `+/-` 统计
- 非 `Not staged` item 会按 section 展示 status badge，例如 `Untracked`、`Conflicted`、`Staged`
- diff 使用现有 `PatchDiff` 组件，并复用 code preview 主题 configuration

### 6. File Tree Sidebar

- 点击 "Show file tree" 后，会在 Git pane 右侧展开一个 directory sidebar
- Sidebar width 支持 drag adjust，并保留最近一次 drag 后的 width
- Sidebar top provide "filter files..." search box，按当前 directory tree 中的 file relative path do instant filter
- Sidebar 会展示 directory and file leaf nodes；filter 时会保留 hit file 的祖先 directory，方便继续 along hierarchy positioning
- 选择 directory 后，会过滤 main area file list
- 选择 file leaf node 后，会把 main area收敛到该 single file；再次 click当前选中 directory 或 file can回到完整 list
- File tree 支持 directory fold / unfold

### 7. Conversation Input Area Bottom Bar

- Conversation input box interior now only保留 editing related controls（input area、attachment、send / stop button）
- 当前 agent、current model、mode setting、token context statistics from input box shell体拆出，统一放到 input box 下方的 bottom bar
- Git branch switch entry 与这些 status controls 共用同一条 bottom bar，并固定到最右侧，减少 input box interior horizontal拥挤
- 当前 agent 图标优先 follow "当前正在查看的 task provider"，avoid switch to history task / fork task 时出现展示与真实会话不一致

## Current Data Source

### Real Git Data

以下 source 现在已经 connect 到真实 `IGitService`：

- `Not staged`
- `Staged`
- `All branch changes`

接线方式：

- `useGitRepository` 统一 through `services.gitService` 读取 `refresh / getChanges / getBranchComparison`
- `App` 只拉一次真实仓库快照， header 和 Git pane 复用同一份 status，避免重复执行 Git 命令
- Single file diff 改为在 Git pane 中按需调用 `getDiff`，避免 top entry statistic 也 trigger full amount diff 读取

### Semi-Real Data

- `Previous round changes` 已优先 reuse 当前 task 在 ZCode task store 里的 per-turn file snapshot and summary
- 这部分是当前 UI 中最接近真实 agent output 的 data source

## Current Interaction Boundary

Current version still is not complete Source Control workbench，但 top 已经放出一组 lightweight write operation：

- 已接入 frontend `commit`
- 已接入 frontend `push`
- 已接入 frontend `create branch`

Current still 未放出的 write operation：

- 没有 frontend `stage / unstage / discard`
- 没有 submit区与批量 operation 区

已接入的只读 capability：

- 真实 `git status`
- 真实 branch comparison
- 真实 single file diff
- 真实 `user.name / user.email` 读取（当前 UI 暂未展示）

`packages/ui/src/hooks/useGitActions.ts` 仍保留为占位 extension point，后续接 service 时可继续复用这层 action abstract。

## Key Implementation Files

- `packages/ui/src/App.tsx`
- `packages/ui/src/v4/ConversationComposer.tsx`
- `packages/ui/src/GitBranchSwitcher.tsx`
- `packages/ui/src/GitActionMenu.tsx`
- `packages/ui/src/WorkspaceHeader.tsx`
- `packages/ui/src/GitPane.tsx`
- `packages/ui/src/git-action-menu/display.ts`
- `packages/ui/src/hooks/useGitRepository.ts`
- `packages/ui/src/lib/workspaceSidePane.ts`
- `packages/services/src/git/gitService.ts`
- `packages/services/src/git/repo/gitCliRepo.ts`

## Current Verification Status

- `pnpm typecheck`：当前仓库未完全通过，存在既有的 shared import / MCP typing 错误，非本轮 Git UI 改动引入
- `pnpm lint`：仓库级 `oxlint` 仍有既有 warning；本轮改动文件已单独通过 `oxlint`
- `pnpm exec vitest run packages/services/test/gitService.test.ts packages/ui/test/gitActionMenuDisplay.test.ts packages/ui/test/gitBranchSwitcherDisplay.test.ts`：通过

## Subsequent Suggestions

1. Determine whether Git pane should restore `stage / unstage / discard` with batch operation area
2. For top submit / push menu supplement more empty states, failure states and permission hints
3. Continue supplement Git for empty / non-repository / Git不可用等 scenarios interaction磨合
