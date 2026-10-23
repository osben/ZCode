# Future Hook Events (Backlog)

> 状态：Backlog / 规划中。本文记录候选 Hook 事件与调研结论，未实施。

## 目的

对照 Claude Code、Codex 与 DeepSeek Harness（dsh）的 hooks 实现，记录 ZCode 尚不支持、
但已确认存在真实用法的候选事件。任何事件在被提升进 `docs/hooks-runtime-contract.md`
之前，不得出现在配置 schema、设置页 UI、插件 allowlist 或文档的支持列表中。

当前已支持 10 个事件（见契约文档）。本文件只跟踪剩余候选。

## 候选总览

| 候选事件         | Claude Code | Codex | dsh CC 桥 | 初步结论               |
| ---------------- | ----------- | ----- | --------- | ---------------------- |
| `SubagentStart`  | ✅          | ✅    | ✅        | 值得做，中等工作量     |
| `SubagentStop`   | ✅          | ✅    | ✅        | 与 SubagentStart 同批  |
| `Notification`   | ✅          | ❌    | ❌        | 价值存疑，暂缓         |
| `Interrupt`      | ❌          | ✅    | ❌        | 仅 Codex 有，暂缓      |
| `WorktreeCreate` | ✅          | ❌    | ❌        | 架构问题，独立立项     |
| `WorktreeRemove` | ✅          | ❌    | ❌        | 与 WorktreeCreate 同批 |

Claude Code 另有大量 ZCode 无对应概念的事件（`TaskCreated` / `TaskCompleted` /
`TeammateIdle` / `ConfigChange` / `FileChanged` / `Elicitation` 等）。在 ZCode 出现对应
产品概念之前不进入候选。

## 候选详情

### SubagentStart / SubagentStop

- 语义（Claude）：Start 仅注入 `additionalContext`；Stop 可 block（exit 2 /
  `decision:"block"`）让 subagent 再跑一轮，matcher 按 agent type。
- 现有点：所有 subagent 生命周期事件汇聚在 `emitSubagentEvent`
  （`apps/zcode-cli/packages/core/src/subagent/runner.ts`）。`SubagentSpawned` 于
  foreground 启动、session-ready 回调处发射；`SubagentStopped` 于完成/失败/取消/
  后台收尾多处发射。
- 风险：发射点多（foreground/background × 成功/失败/取消），需要逐一接入并保证
  block 语义不破坏收尾路径；matcher subject 当前只有 `general-purpose` 一类。
- 工作量：中。注册面（contracts/shared/services/UI/adapters）是机械改动，成本与
  PreCompact 批次相同；主要成本在 runner.ts 各收尾点的语义测试。

### Notification

- 语义（Claude）：permission 等待、空闲提醒等通知时机，无决策权，仅副作用。
- 现状：ZCode 的 OS 通知由 desktop 主进程负责（`packages/desktop/src/main/desktopNotifications.ts`、
  `TaskNotificationPayload`），agent 运行时内没有单一通知汇聚点；permission 场景与
  现有 `PermissionRequest` hook 高度重叠。
- 初步结论：暂缓。若要做，优先挂在 `PermissionRequested` session event 上，且需先定义
  与 desktop 通知去重的关系，避免双通道打扰。

### Interrupt

- 语义（Codex）：用户打断活跃 turn 时触发，不可阻止打断，1s 默认 / 3s 上限超时。
- 现有点：`stopActiveForegroundExecution`
  （`apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`）是唯一
  choke point，接入点清晰。
- 初步结论：暂缓。仅 Codex 定义了该事件，Claude Code 无对应；生态兼容收益低。若将来
  做，语义照抄 Codex（非阻断、极短超时）。

### WorktreeCreate / WorktreeRemove（需要架构决策）

- 语义（Claude Code）：provider 型 hook。触发时机为 `--worktree` / `isolation:"worktree"`
  / 后台会话创建 worktree；command hook 自己创建 worktree 并把路径打印到 stdout（stdout
  被读作路径，不能返回 JSON），任何非零退出使创建失败。`WorktreeRemove` 只对由
  hook 创建的 worktree 触发，非零退出使移除失败，JSON 输出被丢弃。两者均无 matcher。
- ZCode 现状：worktree 创建/移除在 desktop host 侧
  （`packages/services/src/git/repo/gitCliRepo.ts` `createWorktree` / `removeWorktree`，
  编排在 `packages/ui/src/command-center/worktreeCreation.ts`），发生在 agent 进程
  spawn 之前 —— 目标 agent 尚不存在，父 workspace agent 也不保证存活。而全部 hook
  执行设施（runner、config 合并、trust admission、设置页）都在 `apps/zcode-cli` agent
  进程内。
- 选项：
  1. 在 `packages/services` 提炼 headless hook runner，host 在 `git worktree add` 前后
     执行 hook —— 能完整实现 provider 语义，但是独立项目（第二套执行面、config 归属、
     trust 模型都要定义）。
  2. 经由存活的父 workspace agent 进程转发 —— 时序脆弱，不可靠，不推荐。
  3. 降级为事后通知型 `WorktreeCreated` / `WorktreeRemoved`（不可替换 git 行为）——
     便宜但失去核心价值（自定义 provisioning、`.env` 复制、远端构建器）。
- 初步结论：单独立项。做之前必须先在 spec 中敲定选项与 owner，不允许先写代码。

## 提升流程

1. 在本文为候选补齐：产品规则、stdin 字段、输出效果、matcher subject、失败语义、
   验收场景。
2. 把事件移入 `docs/hooks-runtime-contract.md`（事件列表、stdin 表、效果矩阵、验收
   矩阵同步更新）。
3. 按现有批次模式落地：contracts → shared → services/UI/adapters 注册面 → core
   payload/output → dispatch 点 → 测试（contract test + 针对性 runtime 测试）→
   文档（README / NOTICE / e2e matrix / settings-hook-list）。
