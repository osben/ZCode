# 模型调用轨迹查看器（Model Trajectory Viewer）

> E2E 行为目录与覆盖状态见
> [`docs/testing/model-trajectory-e2e-coverage-matrix.md`](./testing/model-trajectory-e2e-coverage-matrix.md)。

在任务右键菜单 / Header 更多菜单里新增「查看调用轨迹」，在右侧边栏以专业、可读的方式
可视化某个 task/session 的模型调用全过程：区分 system / user / assistant / tool 角色，
展示每次调用的模型、token 用量、耗时、finishReason、工具调用入参与工具结果、错误堆栈等。

## 数据来源

- `~/.zcode/cli/debug`（开发态）与 `~/.zcode/cli/rollout`（生产态，最多保留最近 3 个会话文件）
  下的 `model-io-*.jsonl`。
- 由 `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` 落盘，文件名形如
  `model-io-<sanitizedSessionId>.jsonl`。一个 session 只对应一个 JSONL 文件；首条记录保存完整
  `request.messages`，后续模型调用只保存相对上一条新增的消息 delta，避免完整上下文按梯度重复。
  每条记录带 `sessionId` / `turnId` / `traceId` / `querySource`、`request`（messages / toolNames）、
  `response`（text / reasoningText / toolCalls / usage / finishReason）、`error`。AI SDK 返回的
  `response.reasoning` 必须在落盘前按 reasoning block 顺序提取文本，并以空行连接为
  `response.reasoningText`；块内换行保持不变。无有效 reasoning 文本时省略该字段，避免制造空的“思考过程”行。
  `querySource` 与 `model.role` 用来区分主会话请求、标题生成、compact、subagent 等来源；
  旧日志缺少 `querySource` 时，服务层会对已知标题生成 prompt 做兼容识别。
- TOOL 消息的 `content` 在实际 model-io 中通常是字符串，而 `toolCallId` / `toolName` 位于消息顶层；
  服务层归一化为 `tool-result` 时必须把这些顶层关联字段一并保留，不能只映射 output，否则 UI 无法关联和展示 tool call ID。
- 写入链路必须是有界的：模型请求完成后写 model-io 属于 agent 主流程上的诊断旁路，禁止为了 append
  新记录同步读取并 expand 整个历史 JSONL。长会话曾把单个生产 rollout 文件写到 1GB 量级，旧实现每次写入前
  `readFileSync(filePath, "utf8")` 并逐行 `JSON.parse` / expand，可能在 UTF-8 转换或 V8 字符串分配阶段触发
  native crash，导致 agent 子进程直接退出且普通 JS 日志来不及落盘。
- 新实现只用进程内上一条请求摘要判断 delta；进程重启、缓存缺失、历史不匹配或文件超过生产硬上限时，写入当前请求的
  bounded baseline（必要时只保留最近 tail messages），并继续从该 baseline 之后追加 delta。生产 rollout 是“最近有界轨迹”，
  不承诺无限完整回放；开发态 debug 保留更多原始字段，但同样不能在写入时回读整份历史文件。
- ZCode Agent 把 `taskId` 当作 `sessionId`（见 `zcodeTaskServiceAdapter` 里多处 `sessionId: params.taskId`），
  所以轨迹只读取 `model-io-<sanitizedTaskId>.jsonl`，并按 `record.sessionId === taskId` 精确匹配。
  仅 ZCode Agent（glm）会落盘 model-io。
- 投影链路的单段文本必须有界：`packages/services/src/zcode-agent/modelTrajectory.ts` 对每个投影出的
  内容段（text / reasoning / tool-call input / tool-result output / unknown raw）、`response.text`、
  `response.reasoningText` 做按字节的预算裁剪。预算为 **16 KiB 输出总量（含分隔符）**：段的 UTF-8 字节数超过 16 KiB 才裁剪；
  裁剪结果为头部 12 KiB + 固定分隔符 `\n…\n`（5 字节）+ 尾部其余 4 091 字节，因此裁剪后的段不会大于原段。
  裁剪按 UTF-8 字符边界切分，不切断多字节字符或代理对。超出预算的段携带
  `truncated: { originalBytes, omittedBytes }` 标记，`originalBytes` 为裁剪前的 UTF-8 字节数。
  - 字符串 TOOL 输出超预算时不再 `JSON.parse`，保留为字符串并标记；`error-text` 输出只裁剪 `value`，保持错误类型。
  - 对象形式的 tool input / output 与 unknown raw 超预算时序列化为 JSON 字符串后裁剪，输出类型变为字符串。
  - 响应级裁剪通过 `response.truncated: { text?, reasoningText? }` 标记表达。
  - 裁剪只影响投影后的数据：展示、搜索索引与复制都基于裁剪后的投影，复制得到的是裁剪后的文本，中间被省略的部分不可被搜索命中，也无法通过展开恢复。
  - `error.stack` 不做预算裁剪；单条错误的 stack 体量远小于预算，且错误块本身已不做折叠。
  - 预算只约束单段大小，不约束 `records` 数量与每条记录的 `request.messages` 数量。输入上下文的跨记录重复由下方
    “输入增量”契约处理，因此主会话投影的总字节不再是“记录数 × 上下文长度”。
- 投影链路的输入增量（`inputDeltaOf`）：model-io 磁盘格式不变（读取端照常读取写入端输出的完整上下文或 writer 增量），Host 在投影后、RPC 返回前，
  对 `limit` 窗口内每条记录的**已投影完整输入**做判定，决定是否改为增量下发。
  - 资格：只有 `callSource.kind === "main"` 的记录可以是增量。sidecar（标题生成、prompt enhance）、compact、subagent 记录
    始终下发完整输入。
  - 基准（base）：窗口内位于它之前的**最近一条 main 记录**（不是相邻记录）。标题生成、compact 等 sidecar 穿插在主会话之间时，
    后一条主调用仍可对前一条主调用做增量。基准的 `requestId` 为空字符串时不作为基准。
  - 判定：基准的完整已投影输入必须是当前记录完整已投影输入的**精确前缀**。逐条比较 `role` 与 `parts` 的内容标识（序列化结果逐字相等），
    任一位置不同即为完整记录。比较对象是段预算裁剪之后的投影：两条记录只在被裁剪掉的中段不同，判定为相同，此时还原结果与逐条完整投影完全一致。
    不得用计数、长度或对象引用代替内容比较。
  - 命中时：`request.messages` 只保存 `full.slice(sharedPrefixCount)`，并携带可选字段
    `inputDeltaOf = { previousRequestId, sharedPrefixCount }`，其中 `sharedPrefixCount` 等于基准完整输入的长度。
    未命中、字段缺失、或旧 Host 返回的记录都视为完整记录（字段不存在即完整）。
  - 窗口首条 main 记录在窗口内没有基准，因此永远完整；窗口外的前序记录不被引用。`limit` 的语义与段预算不变。
  - 实现位于 `zcode-agent/modelTrajectory.ts` 的 `projectInputDeltas`，类型为 `ZCodeModelTrajectoryInputDelta`（`zcodeTaskService.ts`）。

  owner 与事件顺序：

  ```text
  model-io 文件（磁盘仍为完整或 writer 增量）
     │  readModelTrajectory：尾部 32 MiB 读取 → 按时间排序后展开 writer 增量（全部原始记录，保持顺序）
     ▼
  keep tail（limit 语义不变）
     │  mapRecord：段预算裁剪后的完整已投影输入（owner: Host projection）
     ▼
  projectInputDeltas：基准 = 窗口内最近的 main 记录；精确前缀 → 增量，否则完整（owner: Host，同一同步段内完成）
     │  RPC：records[]，request.messages 可能只含增量，inputDeltaOf 可选
     ▼
  resolveTrajectoryTimelineItems（owner: 视图，纯函数，useMemo 派生，不跨渲染保存状态）
     │  nearest preceding record.requestId === previousRequestId → full = [...base.slice(0, n), ...delta]
     │  缺失 / n !== base.length → base-missing（展示 delta 行并提示）
     ▼
  展示规则（计数规则不变）→ 行窗口 / 搜索索引 / 预览 / 复制
  ```

- 读取链路同样必须有界且异步：Host 从文件尾部按块读取，最多扫描 32 MiB，并只保留最近 `limit`
  条记录；不得使用 `readFileSync + split` 同步加载整个 JSONL。若扫描起点落在一条记录中间，丢弃该残行；
  文件不可读时降级为空结果。开发日志记录扫描字节数与耗时，便于定位异常大文件，同时避免高频诊断信息进入生产日志。

## 分层与关键文件

服务层（host 侧读盘，桌面读本机、手机远控读远端 host，UI 只消费结构化结果）：

- `packages/services/src/session/zcodeTaskService.ts`：新增 `ZCodeModelTrajectory*` 类型与
  `IZCodeTaskService.getModelTrajectory({ taskId, limit })`。
- `packages/services/src/zcode-agent/modelTrajectory.ts`：异步、有界地读取 session 单文件尾部，还原 delta messages、
  归一化 messages / parts / toolCalls / usage，按 `startedAt` 排序，超出 `limit`（默认 200）保留最近 N 条；
  `projectInputDeltas` 在窗口内对主会话记录做输入增量判定（见“数据来源”）。
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`：实现 `getModelTrajectory`。
- `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts`：除尾部读取外，还承载段级字节预算裁剪（`boundText`、`boundPayload`、`withTruncation`；16 KiB 输出上限，含分隔符）、UTF-8 边界切分、`truncated` 标记与 `{content}` 包装的有界化。该文件与 `modelTrajectory.ts` 同目录，供读取链路调用。同目录为未受管模块，因此本次没有新增文件。

UI 层：

- 调用内容不显示 `INPUT` / `OUTPUT` 大分区标题，输入消息行与 `ASSISTANT` 输出标题直接按数据顺序排列，减少无信息量的纵向层级。

- 入口：`TaskActionMenuContent.tsx` 新增「查看调用轨迹」项，经 `TaskListItemContextMenu` →
  `TaskListItem`（任务列表）与 `WorkspaceHeaderSections`（Header）两处接入。
- 桥接：`store/modelTrajectoryStore.ts` 单例 store + `hooks/useModelTrajectoryOpenBridge.ts`。
  菜单深处通过 store 发起「打开轨迹」请求；目标 workspace 的 `useAppPanels` 订阅，按 `workspaceKey`
  匹配后打开侧边栏 tab，避免把回调贯穿整棵任务列表树，也避免多 workspace 实例串开。
- 侧边栏 tab：`lib/workspaceSidePane.ts` 新增 `model-trajectory` tab 类型与 `openModelTrajectorySidePane`；
  `app-shell/AnimatedSidePanePanel.tsx` 渲染 `ModelTrajectoryPane`；
  `app-shell/SidePaneTabTrigger.tsx` / `SidePaneTabOverview.tsx` 补图标与标题。
- 视图：`ModelTrajectoryPane.tsx` + `ModelTrajectoryPaneParts.tsx`，数据走 `hooks/useModelTrajectory.ts`。
- 输入还原：`ModelTrajectoryTimeline.tsx` 的 `reconstructTrajectoryRecords`（纯函数）由 `resolveTrajectoryTimelineItems` 调用，
  在展示规则、行窗口、搜索索引之前完成；`TrajectoryInputContext` 类型位于 `ModelTrajectorySearch.ts`。
  轨迹内容区使用原生纵向滚动容器，不使用 Radix `ScrollArea`；避免其内部自动插入
  `min-width: 100%; display: table` 的内容包装层，导致长轨迹内容参与异常宽度计算。
- Side Pane 的 `ResizablePanel` 壳必须使用 `!overflow-hidden` 覆盖 `react-resizable-panels` 注入的内联 `overflow:auto`，不得让面板壳与 tab 内容同时形成纵向滚动；各 tab 自行持有内容滚动区，调用轨迹仅由 `ModelTrajectoryPane` 的原生 `overflow-y-auto` 容器滚动。

## 展示模型

每条 model-io 记录是「一次模型调用」。视图按时间顺序把轨迹组织成
**输入（user / tool 结果）→ 输出（assistant 文本 / reasoning / 工具调用）** 的链路：

- 首条调用展示完整起始上下文（system + 初始 user + 历史 assistant）。起始上下文中的 assistant 消息与 system / user / tool 一样
  以共享消息行渲染，不再以不可折叠的整段正文直接展开。
- 后续主会话调用只展示相对上一条新增的非 assistant 消息（assistant 由上一条的 Output 呈现），避免重复刷历史。
- 标题生成、compact、prompt enhance 等 sidecar 请求展示自己的完整 prompt，不套用主会话 delta。
- 输入还原先于上述展示规则执行：带 `inputDeltaOf` 的记录，在时间顺序上取 `requestId === previousRequestId` 的**最近前序记录**，
  取其已还原的完整输入 `base`，还原为 `[...base.slice(0, sharedPrefixCount), ...request.messages]`。还原数组只复用基准的消息对象引用，
  不复制消息内容。不带该字段的记录即完整输入，行为与此前相同。
- 基准缺失（找不到前序记录、前序记录自身也是缺失状态、或 `base.length !== sharedPrefixCount`）时，该记录按其携带的增量行展示，
  **不做 assistant 过滤**（基准的输出可能是这些 assistant 行的唯一副本），并在卡片输入区显示提示“前文缺失”
  （`data-trajectory-input-context="base-missing"`）。不抛错，也不隐藏该记录；后续记录的计数基准沿用 `sharedPrefixCount + 增量条数`。
- 还原后的完整输入是后续展示规则（“后续主会话调用只展示…”）、行窗口、搜索索引与预览的唯一输入来源，这些模块不感知增量。
- 头部汇总调用次数、总 token、用到的模型；每张调用卡片的单行 Header 展示来源、finishReason、in/out token、耗时与时间。
- 每张调用卡片头部显示来源 badge（如“主会话”“标题生成”“上下文压缩”“子代理”）。
- 来源标题和 finish reason pill 除本地化展示文案外，还必须分别暴露稳定的
  `data-trajectory-source-kind` / `data-trajectory-query-source` 与
  `data-trajectory-finish-reason` 语义属性。E2E 使用这些属性验证轨迹投影，不得把英文展示文案
  当作功能合同；国际化文案由显式固定 locale 的代表性断言验证。

## 紧凑布局与交互

- 轨迹采用单列调用日志，不使用多层卡片：每次调用由一行摘要和按需展开的详情组成，调用之间仅用
  独立的 `h-px bg-border` 分隔，不在容器上使用 border；列表不设置四边外层 padding，分隔线直接贴合面板边缘。
- 面板 Header 与每次调用的摘要 Header 均使用 `px-3 py-2`，让序号、标题、标签与元数据保持紧凑且一致的留白。
- 调用摘要使用单行结构：左侧为“序号 + 来源标题 + 语义化 finish reason pill”，右侧按
  `IN {inputTokens} · OUT {outputTokens} · 耗时 · 时间` 排列并右对齐。每条调用不再重复展示模型 pill 和 attempt；
  模型集合保留在面板总览 Header。来源标题与 finish reason pill 必须紧邻，剩余弹性空白位于 pill 和右侧指标之间；
  窄侧栏下来源标题优先截断，右侧指标保持完整。
- 调用来源使用 `text-ui-sm font-medium text-foreground`；语义化结束原因使用
  `bg-tag border-border text-ui-xs` pill，序号与右侧元数据使用 `text-ui-xs`。
- 序号使用 `size-5` 行盒水平、垂直居中，与标题和 pill 对齐，不跟随两行摘要整体居中。
- 每次调用的摘要行在轨迹内容滚动时吸附于顶部，使用半透明 `surface` 背景、轻量背景模糊与 `border-border/50` 底边线，确保下方载荷滚过时标题仍清晰可辨。
- 每次调用的 IN / OUT 大层级始终展开，不提供整次调用的收起交互；仅具体消息与载荷保留二级折叠。
- 大输入卡片的行策略见下文“超大输入卡片的行窗口”：输入消息数超过 `TRAJECTORY_COLLAPSED_BY_DEFAULT_ROWS`（40）时，
  该卡片的消息行初始为收起态，并且只挂载前 `TRAJECTORY_ROW_PAGE_SIZE`（40）行。
- 面板 Header action 区在“打开源目录”左侧提供单个“全部展开 / 全部收起”切换按钮，仅在存在轨迹记录时显示。图标复用 Task List 的 `Maximize2 / Minimize2`，使用 `size-3.5 text-foreground`。消息行的默认状态由所属卡片决定：输入消息不超过 40 条的卡片，所有消息行初始化默认展开；超过 40 条的卡片，消息行初始化为收起（见“超大输入卡片的行窗口”）。批量按钮初始动作仍为全部收起，触发后按钮动作切换为全部展开；每次批量动作通过递增 command version 同步覆盖当前已挂载的消息行，未挂载的行在挂载时按同一 command 派生状态。单行仍可独立切换，不反向改写批量按钮的下一动作。默认状态直接由共享 command 与行内 lazy state 初始化，不通过逐行 `useEffect` 触发二次更新。
- “全部展开 / 全部收起”左侧提供自定义展开菜单。菜单按 System、User、Reasoning、Assistant、Tool Call、Tool Result 顺序列出六类内容，右侧使用 `sm` Switch 表达该类型的目标展开状态；点击整行或 Switch 均只更新该类型，菜单保持打开以便连续配置。全部展开/收起会同步更新六个开关。类型命令和全局命令共用单调递增 version，后发命令覆盖对应类型的旧单行 override；未被本次类型命令命中的类型保持原状态。菜单和所有文案必须国际化。

```text
Header toggle
    ├─ expand all   -> command(open=true, version+1)  ┐
    └─ collapse all -> command(open=false, version+1) ┴─ row render 直接读取最新 command

row trigger -> local override(open, current command version) -> only that row changes
next header command(version+1) -> supersedes every older local override
```

批量命令不得由每行 `useEffect` 再同步到本地 `open` state，否则 N 条消息会在 Context 更新后追加 N 次状态写入和第二轮提交。每行应在 render 阶段比较批量 command version 与本地 override version，直接派生本次 `open`；单行操作记录当前 command version，下一次更高版本的批量命令自然覆盖它。

- 展开内容按 `IN` / `OUT` 分区。输入消息不超过 40 条的卡片中，全部输入消息行默认展开；超过 40 条的卡片中，输入消息行默认收起，且只挂载第一页（见“超大输入卡片的行窗口”）。输出区（思考过程、assistant 消息、tool call）的行不随输入数量变化，始终默认展开。点击单行后可在同一层收起为单行预览，再次展开直接展示全文、思考过程、工具输入或工具结果，展开内容内部不再嵌套第二层折叠。收起的消息行不挂载展开正文，因此不产生 `<pre>` 或正文 DOM。
- 调用内容区外层使用 `p-2 gap-y-2`，统一提供四边 8px 内边距和相邻大组之间的 8px 间距；INPUT / OUTPUT 各自作为独立大组卡片，使用 `overflow-hidden rounded-lg border border-card-border`，自身不设置 margin 或背景色。消息行在卡片内连续排列，由各分区与消息行自身控制布局。
- `INPUT / OUTPUT` 分区各显示独立标题行，使用 `h-8 px-3 bg-surface text-ui-sm font-mono uppercase text-foreground`，与消息斑马纹的 `bg-surface/30` 拉开层级。标题不显示左侧色线或装饰图标，不设置 `mt-*`、`mb-*`；两组使用相同中性样式，只负责表达请求与产出分组，不参与消息行斑马纹。
- 相邻消息行之间不设置 gap；INPUT / OUTPUT 标题与第一条消息之间、相邻消息之间插入独立的 `col-span-full h-px bg-border/50` 分隔元素，不使用消息行自身的 border。
- 整个轨迹列表共用最外层 `max-content minmax(0, 1fr) auto` 三列 grid；每个 Call Card、调用内容区、输入区、输出区和消息行都通过 `subgrid` 继承同一组“角色 / 内容 / 操作”列轨道，像 table 一样由全列表最长的本地化角色标签决定第一列宽度。Grid 使用 `gap-x-2`，将内容与 Chevron 的间距收紧为 8px；角色标签额外使用 `pr-1`，使角色与内容的视觉间距仍保持 12px。不得让不同 Call Card 或 Input / Assistant 输出分别计算角色列宽，也不得用固定宽角色列在短中文标签后制造大块空白。内容列必须保持 `minmax(0, 1fr)`，确保长摘要仍可正常收缩和截断。
- 共享操作列仅由 Chevron 确定宽度；操作列使用 `-ml-1 mr-1`，在不改变角色列与内容列间距的前提下，把内容或工具 ID pill 到 Chevron 的可见间距由 8px 收紧为 4px。展开态复制按钮使用 `absolute right-full mr-1` 放在 Chevron 左侧，不撑宽共享操作列。展开态元数据使用 `mr-7` 精确预留“24px 按钮 + 4px 间距”，避免复制图标覆盖日期时间；收起行不保留该空位。所有行的 Chevron 始终贴齐同一条右边线，不得在箭头右侧留下空槽。
- 标题行操作列只保留 Chevron；任意行展开或收起时，其他行的 summary、标签与 Chevron 都不得横向跳动。
- 模型输入中的 `tool` 角色显示为英文 `Tool result`、中文“工具结果”，与 assistant 输出中的 `Tool call` / “工具调用”明确区分。
- 中文角色文案使用完整语义名称：system 为“系统提示词”、user 为“用户消息”、assistant 普通文本为“助手消息”；不使用容易与分组或产品身份混淆的“系统 / 用户 / 助手”短标签。
- Tool name pill 不设置最大宽度且不截断，必须完整显示；Tool call ID 在界面展示时移除开头的 `call_` 前缀，底层消息数据保持原始 ID。空间不足时优先压缩 summary，Tool call ID pill 仍允许截断以保护窄侧栏和手机 Web 布局。
- Tool Result 与 Tool Call 的收起行在 summary 前显式显示内容自适应宽度的数据方向标签：Tool Result 使用 `OUTPUT`（中文“输出”），Tool Call 使用 `INPUT`（中文“输入”）。方向标签使用 `text-ui-sm` 与主要文字颜色并按实际文字宽度收缩，随后以标准紧凑间距显示第三等文字颜色的向右箭头图标，再进入次要层级的 summary；不得用固定宽度在短中文标签与箭头之间制造空槽。展开后 summary 与向右箭头同步隐藏，方向标签保留且不在展开正文中重复。
- 内容区的分区标题、角色标签、消息预览、正文、思考与工具内容统一使用 `text-ui-sm`；调用摘要 Header 的序号、pill 与元数据继续使用 `text-ui-xs`。
- 被预算裁剪的内容段（带 `truncated` 标记）在其正文末尾显示一行次要文字“源数据已截断，原始 N 字节”（`modelTrajectory.truncatedAtSource`，
  N 为 `originalBytes`），并带 `data-trajectory-truncated` 属性。该提示不替代“显示全部”，裁剪是 Host 投影阶段完成的，
  展开也无法恢复中间省略的部分。
- Tool Result 的 output 若为 `{ type: "error-text", value: string }`，收起摘要和展开正文必须直接使用 `value`，不得把错误包装对象序列化成 JSON。收起摘要继续折叠连续空白，展开正文保留错误文本的原始换行。
- Tool Result 的 output 或 Tool Call 的 input 为 `error-text` 时，收起行在 INPUT / OUTPUT 前显示 `CircleAlertIcon`，图标与方向标签使用 destructive 错误色，普通工具 payload 不显示该状态。展开后的错误 payload 使用 `rounded-lg bg-destructive/10` 无边框错误容器与 destructive 文字色包裹；工具名、调用 ID、复制和溢出展开行为保持不变。标准化 model-io 中字符串 TOOL 消息的顶层 `isError` / `is_error` 必须还原为 `{ type: "error-text", value: content }`，不得在服务层映射时丢失错误状态。
- system、user 与 tool 复用同一套撑满可用宽度的透明消息布局。摘要只读取投影文本的前 **1 024 个字符**（每段独立计算），以避免每次渲染规范化整段文本；system 收起摘要取其中第一条非空行；user、assistant 普通消息与思考过程的收起摘要将换行等连续空白折叠为单个空格；tool 收起摘要取 `tool-result.output` 的同一前缀并以同样方式压成单行，不使用工具名代替摘要。搜索命中若位于摘要前缀之后，折叠摘要中不高亮；命中行被 reveal 展开后，正文中的命中照常高亮。各摘要均在单行内截断，最右侧显示 Chevron；tool 摘要右侧另依次使用两个独立 outline pill 展示 `toolName` 和 `toolCallId`，单个字段缺失时只隐藏对应 pill。展开时头部隐藏摘要、方向右箭头、`toolName` 和 `toolCallId` pill，保留方向标签并展示“本次调用耗时 · 完整日期时间”；工具名与 ID pill 移到展开内容顶部的第一行，payload 从下一行开始。完整 ISO datetime 通过悬停提示保留。这里展示的是 model-io 调用级 `durationMs` / `startedAt`，不是单条消息自身的耗时或时间。Chevron 按钮容器使用 `size-5`，图标使用 `size-3`。展开行在 Chevron 左侧显示 `icon-sm ghost` 复制按钮，收起时隐藏；复制操作复制投影后的数据（已经过段级预算裁剪的文本，不含被省略的中间部分）；复制在点击时计算，不在渲染时计算。展开正文中 system / user 展示投影后的完整消息，tool 展示投影后的完整 payload，被裁剪的段附带 `data-trajectory-truncated` 提示，不重复“工具结果/工具调用”标题。正文作为容器内部普通内容展示，不使用卡片背景、圆角或外边距；默认使用 `max-h-64 overflow-hidden`，不允许内部滚动。内容超过 256px 时底部增加 72px CSS mask 渐隐，并在 `bottom-3 left-1/2` 水平居中悬浮 `sm outline`“展开”胶囊；该 pill 使用 `bg-surface/90` 作为无 backdrop-filter 时的回退，支持时切换为 `bg-surface/70 backdrop-blur-md` 高斯玻璃背景。溢出正文使用 `pb-14` 预留空间，让正文末行与悬浮按钮保持标准间距；无溢出操作时仅使用 `pb-2`。展开后移除最大高度与 mask，居中按钮切换为“收起”；展开只影响当前消息，消息行收起时恢复限高状态。
- assistant 输出不再使用 `ASSISTANT` 分组标题或嵌套 surface 卡片。思考过程、assistant 消息与每个 assistant tool call 都直接渲染为独立的共享 Grid 消息行，与 system / user / tool result 使用相同的单行摘要、整行展开、溢出截断和悬浮胶囊操作。assistant tool call 收起时将 `toolCall.input` 序列化为压缩单行摘要，并以两个独立 outline pill 展示工具名和 tool call ID，避免摘要与工具名标签重复；展开时仅以透明、可换行的正文样式显示完整格式化输入参数，不重复“输入”标题、工具调用标题、背景卡片或圆角。
- `INPUT > TOOL` 与 `OUTPUT > ASSISTANT > Tool` 的收起行已经承载工具名（Assistant Tool 同时承载 ID），因此展开区不得重复渲染“工具结果/工具调用 + 工具名 + ID”标题，只保留 Output 或 Input 有效载荷卡片。
- 消息摘要右侧 Chevron 使用 `ml-1.5`，与工具 tag 或消息预览保持 6px 的控件间距。
- 展开卡片外层使用 `p-3`，四边统一保留 12px 间距。
- 左侧竖线移除后，标题、消息行和展开正文恢复 12px 左侧 padding：标题与正文使用 `px-3`，消息触发区使用 `pl-3` 并由独立操作列控制右侧空间；展开正文按溢出状态使用 `pt-0 pb-14` 或 `pt-0 pb-2`。展开正文的文本与工具 payload 仅在展示时执行 `trim()`，去除首尾空白但保留中间换行；复制仍使用未经裁剪的原始数据。
- system / user / assistant 等消息角色行统一使用 `min-h-8`（最小 32px），左侧角色标签与右侧内容分别在首行内垂直居中；展开或多行内容可自然增高。
- 颜色严格使用 `DESIGN.md` 语义 token：主背景 `background`、展开态 `selected`、
  内容层 `surface` / `card`、分隔线 `border` / `card-border`，只在真实错误状态使用 `destructive`。
- 模型调用级 `record.error` 显示在对应 Call Card 的 INPUT / OUTPUT 之后，使用 `rounded-lg`、无边框的 `bg-destructive/10` 半透明错误背景；左侧使用 `CircleAlertIcon`（`size-4 text-destructive`）并与标题首行对齐，错误名称与消息使用 `text-destructive`，stack 使用同色弱化层级。错误块不得使用描边或普通 surface 背景。
- 角色主要依靠紧凑文字标签区分，不为 system / user / assistant / tool 铺设不同的大面积背景色。
- 消息行不显示左侧竖线；SYSTEM 使用次要文字色 `text-foreground-subtle`，USER 使用 `--color-trajectory-user` 蓝色，ASSISTANT 使用 `--color-trajectory-assistant` 青绿色，思考过程使用 `--color-trajectory-reasoning` 紫色，TOOL CALL 使用 `--color-trajectory-tool-call` 琥珀色，TOOL RESULT 使用 `--color-trajectory-tool-result` 青蓝色。彩色角色标签统一使用专用 token 的 `/80`；五个专用 token 必须分别定义默认 Light、Dark、Zai Light、Zai Dark 值，不得借用 success、warning 或 destructive 状态色。思考过程继续复用 USER 的整行摘要、点击展开、正文限高、复制与“展开/收起”结构，不使用独立卡片。
- 同一个 Call Card 内的全部输入与输出消息行使用连续序号绘制斑马纹，Input 与 Assistant 输出之间不得重新计数。首行保持透明，交替行使用 `bg-surface/30`；展开内容继承所属消息行背景，调用 Header 与分割线不参与交替，消息行不添加 hover 背景或颜色过渡。
- 窄侧栏与手机 Web 保持单列结构；技术载荷必须换行且不得撑宽面板，悬浮胶囊操作允许在窄宽度下保持紧凑。

## 长列表虚拟化

### 内容搜索

- Header 操作区在“自定义展开”左侧提供搜索按钮；点击后在调用统计信息下方显示内联搜索栏，包含输入框、`当前/总数`、上一条、下一条与关闭按钮。打开时聚焦输入框；Enter 前进、Shift+Enter 后退、Escape 关闭，不覆盖应用全局 `Cmd/Ctrl+F`。
- 搜索只在 UI 内对当前已加载的轨迹投影建立索引，不新增服务端 API、RPC、协议字段或持久化。范围包括 system、user、reasoning、assistant 正文、Tool Call input、Tool Result output、tool name 与去掉 `call_` 前缀后的可见 ID；时间、token、模型与角色标签不参与。匹配为大小写不敏感的字面量搜索，查询与正文中的连续空白统一视为单个空格，并保留原文 offset 用于高亮。
- 普通已挂载命中使用 `--color-find-highlight`，当前命中使用 `--color-find-highlight-active`。当前命中若位于折叠消息或正文限高区域，搜索 reveal 状态必须临时强制展开消息与完整正文；该状态不得写入用户 expansion override，切换结果、清空或关闭搜索后恢复搜索前状态，用户原本手动展开的内容保持不变。
- 虚拟列表定位分两阶段：先按 `callIndex` 调用 virtualizer 定位并挂载 Call，再在搜索 reveal 展开并重新测高后的下一帧定位具体文本 Range。定位请求使用稳定 match key 去重，避免 ResizeObserver 或虚拟行重挂重复滚动。上一条/下一条首尾循环；被截断的轨迹只搜索当前已加载记录，并继续显示现有截断提示。

- 轨迹按 Call Card（一次模型调用）做动态高度虚拟化。卡片内部的 INPUT / OUTPUT 分区不单独虚拟化，但输入消息行受下文“超大输入卡片的行窗口”约束：超出窗口的行不挂载。滚动容器仍是面板现有的原生 `overflow-y-auto` 容器。
- 虚拟项使用实际 DOM 高度测量，展开、收起或“显示全部”造成高度变化后必须重新计量；上下各保留少量 overscan，避免快速滚动时闪白。
- 外层虚拟画布继续提供共享的三列 Grid。不可见的零高度角色标签测量行参与第一列 `max-content` 宽度计算，确保虚拟项挂载数量变化时，SYSTEM / USER / ASSISTANT / TOOL 的内容列不会横向跳动。
- 单条消息的展开状态必须由稳定消息 key 保存于 Call Card 之外；虚拟项离开视口被卸载再挂载后，仍恢复离开前状态。批量展开命令仍通过共享 command version 覆盖旧的单行状态，不允许每行用 effect 二次同步。

```text
native scroll viewport
        │ scrollTop / viewport height
        ▼
Call Card virtualizer ── overscan ──> visible Call Cards only
        │                              │
        │ dynamic measurement          └─ INPUT / OUTPUT / message rows
        └─ total canvas height

row toggle ──> keyed expansion state ──> survives Call Card unmount/remount
bulk toggle ─> command(version + 1) ────> supersedes older keyed state
```

## 超大输入卡片的行窗口

首条调用的输入可能包含上千条消息（完整起始上下文）。若全部挂载，一张卡片可达两万级 DOM 节点，
主线程会在一个任务内阻塞数秒；批量“全部展开”同样会重新触发这一成本。因此输入消息行按卡片做窗口化：

- 阈值 `TRAJECTORY_COLLAPSED_BY_DEFAULT_ROWS = 40`：输入消息数 `<= 40` 的卡片，输入消息行默认展开，行为与上文一致；
  `> 40` 的卡片，输入消息行默认收起。阈值只决定默认值，不改变批量命令和单行覆盖的语义。
- 页大小 `TRAJECTORY_ROW_PAGE_SIZE = 40`：卡片挂载输入消息 `[0, limit)`，`limit` 初始为 40；不足一页的卡片不显示任何窗口控件。
- 间隙与“显示接下来”控件：页与后续行之间的间隙显示一行按钮“显示接下来 N 条（共 M 条）”（`data-trajectory-rows-more`），
  其中 `N = min(40, 间隙行数)`。点击把 `limit` 设为 `页末 + N`，因此每次点击恰好挂载文案中的 N 行。
  控件不展开任何行。
- `limit` 的状态 owner 是 `TrajectoryExpansionRegistry.rowLimits`（按 Call Card 的稳定 key 保存），与单行展开状态同属
  Call Card 之外的状态，虚拟项卸载再挂载后保持不变。registry 缺失（独立渲染的测试场景）时退化为卡片本地状态。
- 搜索 reveal：当 `searchRevealKey` 指向本卡片第 `i` 条输入消息（`<callKey>:input:<i>`）且 `i >= limit` 时，渲染派生一个
  搜索窗口 `[max(limit, i - 10), min(M, i + 11))`（半径 `TRAJECTORY_REVEAL_RADIUS = 10`）。窗口只在渲染中派生，不写入
  registry，也不改变 `limit`；搜索结束后窗口消失。页与窗口之间的间隙显示“显示接下来”控件（同上）；窗口之后的间隙显示
  文字“N rows hidden”（`data-trajectory-rows-hidden`），不提供控件（见“已知边界”）。`i < limit` 时命中已在页内，不产生窗口。
  因此一次命中最多挂载 `limit + 21` 行，例如 1000 条输入中第 900 条命中只挂载 61 行。
- 批量命令不挂载窗口外的行：窗口外的行在挂载时由当前 command version 派生展开状态，因此“全部展开”只会挂载当前页与搜索窗口。

```text
Call Card (input count M)
   ├─ M <= 40: all input rows mounted, default expanded (batch command as before)
   └─ M > 40 : rows[0 .. limit) mounted, default collapsed
                │
                ├─ registry.rowLimits[cardKey]  (owner, survives virtualizer unmount)
                ├─ gap "show next N" -> limit = pageEnd + N (N = min(40, gap rows))
                └─ search reveal row i >= limit -> window [i-10, i+11), render-only
                     gap before window: "show next N" control
                     gap after window : "N rows hidden" text
```

## 已知边界（待用户决策）

- 输入增量只对理解 `inputDeltaOf` 的视图有效。旧视图对增量记录仍按 `request.messages` 渲染，因此只显示新增消息，缺少前文：
  不崩溃，但不完整。Host 与视图随同一应用版本发布；远控手机页面连接旧 Host 时拿到的是完整记录，不受影响。
- 磁盘 model-io 格式未改变：读取端沿用写入端的格式（完整上下文或 writer 增量）。测量文件 `sess_1293b371`（22.6 MB）的 5 条记录
  均为完整上下文，本次收益来自投影层（RPC 体积）；磁盘体积与写入链路不在本次范围内。只含 writer 增量的文件需另行测量。
  测量（2026-10-22，真实文件 `sess_1293b371`，5 条主调用，默认 limit）：投影 JSON 由 5 502 243 字节降至 1 122 454 字节（-79.6%）。
  首条记录完整 1 097 942 字节，其余四条增量分别为 9 695 / 4 351 / 4 720 / 5 535 字节；读取耗时约 64 ms。
- 增量只向窗口内最近的 main 记录取基准。`limit` 很小（如 1 或 2）或窗口切在两条主调用之间时，窗口首条主调用必然完整，收益下降。
- subagent 记录当前按完整记录下发（不具备增量资格）：其前序 main 基准通常不前缀匹配。如需对 subagent 增量，需要单独定义 subagent 基准。
- 增量判定的 CPU 成本：每条主调用的已投影消息逐条序列化一次，与完整投影同阶，不增加磁盘读取。
- 搜索窗口之后的间隙没有“显示接下来”控件。提供控件需要第二个状态（窗口锚点），或者把前缀扩到窗口末尾（即一次命中挂载近千行的
  问题）。为保持 `limit` 作为单一 owner，本次只显示行数；若需要在窗口之后继续浏览，需要用户决定引入哪种状态。
- 段级预算不约束 `error.stack`；单条错误的 stack 体量远小于预算。

## 多端

- 读盘收口在服务层，桌面端读本机 `~/.zcode/cli`，手机远控经 RPC 读远端 host 的同名目录。
- 入口在桌面与手机 Web 均可用（移动端不隐藏）；无记录时给出空态提示。
