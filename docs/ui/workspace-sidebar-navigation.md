# Workspace 侧栏导航

## 目标

- 侧栏展示所有已打开的 workspace，以 `workspace -> task` 二级菜单呈现。
- 新建任务、菜单 `File > New task`、`Cmd/Ctrl+N` 统一落到”最近一次 active workspace”。
- 打开工作区、菜单 `File > Open Workspace`、`Cmd/Ctrl+O` 统一落到根级打开工作区动作。

## 状态设计

- `packages/ui/src/store/tabStore.ts`
  - 保存窗口内已打开的 workspace 顺序（`workspaceTabs`），用于会话恢复和跨窗口去重。
  - `activeWorkspacePath` 表示当前或最近一次激活的 workspace。
  - 打开工作区不再切到独立中间页；菜单、快捷键和侧栏入口都直接执行根级打开动作。

## 交互约束

- 侧栏首页顶部提供“自动化”和“插件”快捷入口；“插件”固定放在“自动化”下方，使用与设置页一致的拼图图标，点击后打开设置页并定位到 `plugins` 分区。手机 `/remote` 不承载 Automations，仅保留“插件”入口。
- 左侧栏展示所有已打开的 workspace，任务列表默认全部展开。
- 每个已展开 workspace 的普通任务首屏只显示 5 条；点击“显示更多”时只增加下一批 5 条，直到全部任务可见后隐藏入口，不提供“显示更少”。
- 分页进度是 renderer-local 的临时状态，并按 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 隔离；一个 workspace 加载更多不能改变另一个 workspace 的可见条数。
- 单个 workspace 收起、项目区收起、全部收起、离开 workspace 视图或移除 workspace 时清除对应分页进度；再次展开从默认 5 条开始。仅切换 created/updated 排序不重置当前可见条数。
- “Task list / 任务列表”总标题使用 `text-ui-base + font-medium + text-foreground-subtle`。
- “已置顶”“项目”“任务”属于同一级侧栏分组标题，统一使用 `text-ui-base + font-medium + text-foreground-subtlest`；标题字号不因是否可折叠或可拖拽而变化。
- 点击 workspace 行会作为 trigger 切换该 workspace 的 task list 展开 / 收起，并同步把它设为当前 active workspace。
- “新建任务”按钮和快捷键都会先尝试回到 `activeWorkspacePath`，再进入草稿态。
- 侧栏“新建任务”按钮右侧会显示当前平台的快捷键提示：macOS 为 `Cmd+N`，Windows / Linux 为 `Ctrl+N`。
- 桌面端 `Cmd/Ctrl+O` 通过原生菜单 accelerator 发送 `OpenWorkspace` 平台事件，Web 端用根级 `keydown` fallback 拦截浏览器默认打开文件行为。
- 如果当前没有任何 workspace，Root 会创建默认 workspace 兜底，避免进入空白页或打开工作区中间页。
- `SettingsPage` 在存在最近 active workspace 时提供“返回工作区”入口。

## 远程项目的设备信息与操作

项目仍平铺排列，身份、排序和路径隔离沿用 `workspaceIdentity`。项目行只显示一个五态图标、项目名和限宽设备标签；离线标签替换为短状态，操作在悬停/聚焦时出现。设备标签点击或悬停 400ms 打开整行右侧详情，连接保留原目录，断开为设备级动作，编辑使用现有表单，管理操作一次性定位设置页设备卡。

“项目 + → 打开远程项目”从设备管理快照列出设备（包括在线但尚无项目的设备），已选连接优先级来自统一展示模型，连接或复用后选目录；末项新建远程连接。会话及草稿头部、输入框项目菜单使用相同设备显示名，任务行共用设备标签样式。完整合同与验收见 [RDUX-12 导航合同](../remote/project-first-remote-navigation-spec.md#21a-侧栏详情与设备菜单rdux-12)。

## 排序规则

- “项目 / 任务”二级分区通过专用手柄拖拽排序，顺序与各自展开态一起持久化到 renderer-local `zcode-sidebar-purpose-section-preferences`；默认顺序是“项目 → 任务”。
- 左侧 workspace 列表支持拖拽排序，顺序复用 `tabStore` 中的 `workspaceTabs` 子序列。
- workspace 开始拖拽后，仅被拖项目的 task 列表临时收起，并通过独立 drag overlay 展示项目头；drop 或 cancel 后恢复拖拽前的展开语义。临时收起是 renderer-local 拖拽派生态，不写入 `expandedWorkspacePaths` 或 `localStorage`。
- 项目排序的兄弟让位距离固定按完全收起后的几何计算：项目行 `32px` 加项目间距 `8px`，让位为 `40px`；不得使用展开 task 列表后的整行高度，否则向上拖拽会先把上方项目推到旧位置再回跳。
- 项目分区内的 task item 允许通过原生拖拽加入 Workbench / 分屏，但不参与项目内 task 排序；项目排序的拖拽入口仍仅限项目头。原生 drag preview 保留 task item 的原有内容，仅复用 Grouped task drag overlay 的背景、边框和阴影。
- workspace drag overlay 保留 Grouped 分组拖拽浮层的背景、边框、阴影、文字和指针样式；尺寸与项目列表按钮对齐为 `h-8 px-2.5 gap-2`，并统一通过 `[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0` 约束 preview 图标。
- workspace 拖拽位置按当前可见的项目子序列预览，但提交时必须把项目 id 映射回 `workspaceTabs` 的全局索引，不能让 conversation workspace 等过滤项改变落点。
- 新打开的 workspace 默认插到列表最上方，方便优先回到最新打开的项目。
- workspace 的展开/收起态会额外按 `workspacePath -> expanded` 持久化到 `localStorage`，下次恢复同一批 workspace 时继续沿用上次侧栏开关状态。
- 左侧 `task` 支持拖拽排序，排序范围只限当前 workspace 内部，不允许跨 workspace 拖动。
- task 顺序按 workspace 维度持久化到本地存储；新出现、还没手动排过序的 task 会先显示在手动排序历史之前，避免被旧顺序埋住。

## Workspace 任务分页验收

| Case      | Setup                       | Action                     | Assertion                                    | Status   |
| --------- | --------------------------- | -------------------------- | -------------------------------------------- | -------- |
| `WSTP-01` | workspace 有 0–5 条普通任务 | 展开 workspace             | 展示全部现有任务，不显示“显示更多”           | accepted |
| `WSTP-02` | workspace 有 6 条普通任务   | 展开后点击一次“显示更多”   | 可见数从 5 增至 6，入口消失                  | accepted |
| `WSTP-03` | workspace 有 12 条普通任务  | 连续点击“显示更多”         | 可见数按 `5 → 10 → 12` 递增，最后入口消失    | accepted |
| `WSTP-04` | workspace A/B 都超过 5 条   | 只在 A 点击“显示更多”      | A 增加 5 条，B 保持默认 5 条                 | accepted |
| `WSTP-05` | workspace 已显示超过 5 条   | 通过任意路径收起后重新展开 | 恢复默认 5 条                                | accepted |
| `WSDR-01` | workspace A 展开、B 展开    | 开始拖拽 A                 | 仅 A 临时收起；B 保持展开；overlay 不含 task | accepted |
| `WSDR-02` | workspace A 展开            | 拖拽 A 后 drop             | 顺序提交；A 恢复展开；展开偏好未被临时改写   | accepted |
| `WSDR-03` | workspace A 展开            | 拖拽 A 后 cancel           | 顺序不变；A 恢复展开                         | accepted |
| `WSDR-04` | workspace A 原本收起        | 拖拽 A 后结束              | A 始终保持收起                               | accepted |

时间线、置顶、归档、分组和 Web 远控独立任务索引不复用这套分页状态，属于本次变更的 pruned 范围；本变更不修改 conversation、desktop continuous 或 mobile replayable 数据流。

## 侧栏标题字号验收

- `Task list`、`Pinned`、`Projects`、`Tasks` 均使用 base 字号；保留总标题和分组标题原有的颜色、间距和交互。
- `command-center-focus.test.ts` 检查总标题、分组标题等于 `--ui-font-size`，两者字号差为 0，并验证深浅主题与窄屏。
- 验证顺序为 `pnpm typecheck` → E2E 构建 → E2E 运行。不要并行执行前两步：`tsconfig.host.json` 会向 `out/host` 输出未打包 JS，与桌面 bundle 共用目录，可能导致 Host 直接加载 workspace TS 并因 `.js` 模块不存在退出。类型检查结束后重新构建，不修改 Host 产品逻辑来绕过产物污染。

## 任务前进 / 后退历史（ISSUE-033）

- 历史是一条全局线性栈，由 `packages/ui/src/lib/taskNavigationHistory.ts` 纯函数维护；`zcodeSessionStoreNavigation.ts` 是唯一写入者。
- 入栈只发生在用户主动选择的入口：侧栏/搜索/命令面板选中 task（经 `setActiveTaskId`）、Automations 与插件市场主视图。后退、前进回放不得改变栈的内容，只能移动 cursor。
- 相邻且身份相同的条目不重复入栈（身份 = `workspaceIdentity` 与 `workspacePath` 的完整键）。非相邻重复允许保留，因为它代表一次新的访问。
- 选择新条目时，cursor 之后的前进历史被截断（浏览器语义）。
- 只有权威的删除事实才能清除历史条目：项目目录树（`ProjectTree.deletedTasks`，由 `readTree({ includeDeletedTasks: true })` 返回，即 `deleted=1 OR cli_deleted=1` 的 task）。`useProjectTree` 每次接受新快照时把它发布到 `taskNavDeletedKeys`（键为 `buildTaskEntityKey`，即 `workspaceIdentity?.trim() || workspacePath` + `taskId`）。
- “不在 task query cache、不在当前 workspace 可见列表”不是删除证据。侧栏项目视图中的 task 常常不在这两处，它们仍可导航，`handleSelectTask` 负责打开。树尚未加载或某 Host 离线时，没有 tombstone 即视为可导航（未知按可导航处理），不设超时。
- 后退或前进遇到已确认删除的 task 条目时，该 task 的全部条目被清除；清除与 cursor 定位在同一次纯函数计算中完成，并沿原方向继续寻找下一个有效条目，不跳过、不重排其余条目。
- 归档 task：归档转换由既有 owner（`useProjectTree` 的归档清理）调用 `removeTaskState`，该动作清除其历史条目，行为保持不变；导航回放本身不因归档而清除条目。
- 到头（没有有效目标）时历史只保留已清除的失效条目，cursor 留在当前条目，不发生导航。
- 删除 task（`removeTaskState`）时清除该 task 的条目；cursor 落在删除前位置之后的第一个保留条目（与旧行为一致）。
- 应用内删除或归档时，`removeTaskState` 仍是即时清除的 owner；回放只在遇到 tombstone 时惰性清除，两者都以同一身份键匹配。

| 用例         | 前置                                                                                       | 操作          | 期望                                            |
| ------------ | ------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------- |
| `NAV-033-01` | 栈 `[Auto, PS, A(失效), B, C]`，cursor 在 PS                                               | 前进          | 导航到 B；A 被清除；cursor 指向 B               |
| `NAV-033-02` | 栈 `[A(失效), B]`，cursor 在 B                                                             | 后退          | 清除 A；无目标；cursor 仍在 B，不导航           |
| `NAV-033-03` | 栈 `[A, A, X, A, Y, Z]`，cursor 在第 4 个 A                                                | 删除 task A   | cursor 指向 Y（删除前位置之后的第一个保留条目） |
| `NAV-033-04` | 栈 `[PS, A, B, C]`，A/B/C 均不在可见列表与 query cache，但在项目树中为存活（无 tombstone） | 连续后退 3 次 | 依次到 B、A、PS，历史条目不被清除               |
| `NAV-033-05` | 同 NAV-033-04，但项目树 `deletedTasks` 含 A                                                | 从 C 后退     | 清除 A 的全部条目；依次到 B、PS                 |
