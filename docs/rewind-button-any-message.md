# 消息级撤销入口下线

## 当前状态

消息卡片 footer 中的消息级“撤销”入口已下线，不再在用户消息或助手消息下方展示。V4 不存在 conversation cascade rewind 命令。

本次下线针对的是聊天消息级 cascade rewind 入口，不影响文件变更摘要中的文件级撤销。V4 文件变更摘要面板（`ConversationFileSummaryPanel`）只提供“撤销”：撤销后显示“已撤销”标记并禁用撤销按钮，不提供“重新应用”（与 upstream V4 面板一致；旧 `MessageChangeSummaryPanel` 的“撤销 / 重新应用”切换不再适用）。

## 背景

该入口最早由以下提交引入：

| commit      | 作者 | 时间                        | 标题                                                               |
| ----------- | ---- | --------------------------- | ------------------------------------------------------------------ |
| `a9e3ace78` | —    | `2026-06-24 18:20:03 +0800` | `feat(ui): support message-level rewind with preview confirmation` |

后续同一功能还有多笔修复提交，例如 `ab1a92254`、`daed7eb81`、`51889364a`、`fc764779b`。当前产品语义决定先移除 UI 入口，避免用户把“消息历史回退 + 文件回退”和文件摘要里的单 turn 文件切换混在一起。

## 约束

- V4 `ConversationRowView` 不提供 conversation rewind action。
- 独立 `session/rewind` / `session/rewindCascade` 已从协议和调用链删除。
- 修改历史 query 使用 `editUserQuery`；重试使用 `retryTurn`。
- 文件状态回退使用 `applyFileRewind`，不会隐式截断聊天历史。

## 验证重点

- 消息 actions 只保留当前 row projection 允许的 copy、edit、retry、fork 等动作。
- 文件变更摘要面板只提供文件级撤销：撤销后文件恢复、面板显示“已撤销”且撤销按钮禁用；没有“重新应用”入口（ISSUE-041 决定：仅撤销）。
- 手机远控不新增任何 replayable rewind 入口。
