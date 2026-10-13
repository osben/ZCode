# 会话消息固定（Message Pins）v1 规格

用户可以在会话时间线中“固定”（pin）重要消息（自己的输入或助手回复）。固定消息以紧凑的
chips 条展示在时间线上方；点击 chip 滚动定位到原消息。pin 是面向人的书签：它持久化在会话
transcript 中，但**不进入模型上下文**（model-visible 状态另有 `ui/update-model-context`
机制，本功能不得使用）。

本功能完整复刻既有 `feedback`（like/dislike）标志的产品路径：display-only、transcript-first
持久化、live/cold 投影同源。实现参考 `assistant-feedback-persistence.ts` 与
`AssistantFeedbackUpdated` 事件链。

## v1 范围

1. 可固定两类行：
   - `assistantText` 行（回合最终文本段，与 Copy/Fork 同一锚点），仅 `state === "complete"`；
   - `userInput` 行（用户自己的输入：`origin === "realUser"`，且存在 transcript 锚点 messageId；
     backgroundResult / mailbox / synthetic / workflowLaunch 等系统生成行不可固定）。
2. 数据模型（全部 additive、optional）：
   - wire 行 schema：`assistantTextRowSchema` / `userInputRowSchema` 增加 `pinnedAt?: number`
     （unix ms，CLI 时钟）。字段存在即视为已固定；timestamp 用于“新固定在前”排序。
   - 旧快照/旧会话不含 `pinnedAt` 时必须照常解析（additive 兼容测试覆盖）。
   - persisted 消息（`ZCodePersistedMessage`）增加 `pinnedAt?: number`，与 `feedback` 字段
     同级同风格；仅用于展示/度量，不注入 Agent 上下文。
   - transcript 权威存储：消息 `info.metadata.pinnedAt`（与 `assistantFeedback` 同层）。
3. 命令：`setRowPinned: { target: conversationRowTarget, pinned: boolean }`。
   - 加入 `COMMANDS_REQUIRING_BASE_REVISION`（CAS）与 `ROW_TARGETING_COMMANDS`；
   - gateway 的 `rowTargetActionForCommand` 增加 `setRowPinned`；
   - product-projection 守卫：`assistantText` 要求 `state === "complete"` 且可解析
     messageId；`userInput` 要求可解析 messageId（`messageIdByRowId` 锚点）；否则
     `guard.actionUnavailable`。
4. 内部事件：`SessionEventType.RowPinnedUpdated`，payload `{ entityId, pinnedAt: number | null }`。
   ProductProjection 将其归约为 `row.upserted`（带/去 `pinnedAt` 字段），与 feedback 归约
   逐字同构。
5. 持久化语义（transcript-first，与 feedback 一致）：
   - 先写 transcript metadata，再 append 事件；append 失败时回滚补偿恢复原消息；
   - 事件已持久化后 live projection 失败不返回失败 ACK（交给 resync/hydration 收敛）；
   - 幂等：重复固定保留首次 `pinnedAt`（不刷新时间戳）；未固定时解固定为 no-op。
6. 冷启动：`transcript-hydration` 从 assistant/user 消息 metadata 读取 `pinnedAt`，在行
   创建事件之后重放 `RowPinnedUpdated`，live 与 cold 结构一致。

## UI（v1）

- 固定按钮：assistant 行动作栏（Copy/like/dislike/Fork 一组）与 user 行动作栏（Copy/Edit
  一组）各加一个 pin 切换按钮（lucide Pin 图标）。toggle 语义：再次点击取消固定。
- 乐观 UI + 失败回滚，与 `ConversationRowView` 的 localFeedback 模式一致；compact
  remote-control 模式下工具栏常显，按钮自动继承，无需特判。
- 已固定行在行内显示小 pin 标记图标。
- chips 条（`ConversationPinnedBar`）：渲染在时间线上方；
  - 每个 chip = 文本预览（约 60 字符，单行 ellipsis）+ chip 内“取消固定”按钮；
  - 水平滚动，无数量上限；空状态不占任何空间；
  - 排序 `pinnedAt` 降序（新固定在前）；
  - 点击 chip 通过既有时间线跳转机制（`scrollToQuery` 同路径，按 rowId 定位）滚动到原消息。
- v1 限制：chips 只反映当前已加载的行窗口（`rows.window`）；窗口外的历史固定项在加载
  之前不显示（follow-up：全量 range 查询）。
- i18n：`chat.message.pin` / `chat.message.unpin` / `chat.pinnedBar.*`（en-US、zh-CN、uk-UA
  三语全部必填）；testId：`TID_V4_PIN`（行按钮）、`TID_V4_PINNED_BAR`、`TID_V4_PINNED_CHIP` /
  `TID_V4_PINNED_CHIP_UNPIN`（后三者带动态 rowId 后缀，后两个）。
- 遥测：`message_pin`（eventRegion `chat`，与 `assistant_message_feedback` 同构）。

## Out of scope（v1 不做）

- `ConversationTurnNavigator` 上的固定标记（follow-up）；
- “仅分享固定项” / 固定项摘要（digest）；
- 固定数量上限/配额；
- 旧版（非 v4 / services legacy）会话的固定：`setAssistantMessageFeedback` 在 services 层
  无任何调用方（死代码），pin 不复制该层，走 v4 命令单一路径。

## Follow-ups

1. TurnNavigator 固定标记；
2. chips 条全量历史（rows/range 查询聚合）；
3. 固定项跨会话导出/分享。

## 测试边界

- executor：命令解析 target、传 host；stale 拒写；非法 kind 拒绝；
- persistence：transcript-first 写入、幂等重复、事件失败回滚；
- hydration：旧格式（无 pinnedAt）可解析；带 pinnedAt 的 assistant/user 行冷启动还原；
- shared schema：additive 兼容（旧行对象照常 parse）；
- UI：pin 点击发命令、失败回滚、chips 排序/跳转/取消固定；
- E2E（conversation-session）：固定 → chip 出现 → 点击 chip 滚动定位 → 取消固定 chip 消失。
