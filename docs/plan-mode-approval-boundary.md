# Plan Mode Approval Boundary

Plan mode's `ExitPlanMode` is the plan review boundary: after the model submits a plan, it must
wait for explicit user approval before exiting `plan` and continuing implementation.

## Semantics

- `EnterPlanMode` enters the read-only planning state without confirmation.
- `ExitPlanMode` always requires user confirmation in `plan` mode, including when plan was entered
  from `yolo`.
- Only after user approval does the runtime restore the pre-plan mode and allow later edits.
- On rejection without feedback, the current turn must end, the session stays in `plan` mode, and
  the user can keep typing revision notes.
- With feedback filled into the `ExitPlanMode` approval, the runtime stays in `plan` mode and
  persists the feedback as a real, ordinary `user` message; the `ExitPlanMode` tool result returns
  only a bridging note telling the model the user's feedback follows in the next user message. UI,
  resume and provider-visible history then treat the feedback as a new user query — not swallowed
  into a tool result, not shown as a turn-steer guidance message.

## MCP tool exception

## 工具权限：Plan 闸门加原模式

Plan 只在进入前的模式（下称原模式）之上收紧，不新增放行。判定顺序：

```text
Plan 切换工具（EnterPlanMode / ExitPlanMode）   （各自的既有规则）
  → 需要用户交互的工具（AskUserQuestion 等）    → 询问
  → guarded 危险命令单次确认（未开 Plan 时）
  → alwaysAsk 工具                              → 询问；会话内授权、本会话发起的 workflow 修订放行
  → disallowedTools / 项目 deny / 项目 ask       （顺序不变，优先于 Plan）
  → ReplyToChannel 预批                         （只匹配原会话回复）
  → Plan 闸门
      只读、非 destructive、免审批              → 放行（原模式同样放行）
      声明 allowedInPlanMode 的会话控制工具     → 放行（不变）
      只读但需审批（WebFetch、readOnlyHint MCP）→ 不拦，交给原模式
      非只读、非 destructive 的 MCP
          原模式 yolo / guarded                 → 不拦，交给原模式
          其他原模式                            → 询问，单次确认
      其他非只读工具、destructive MCP           → 拒绝 mode.plan.nonReadOnly
  → guarded 的危险命令单次确认                  （闸门没拒绝且命中危险命令规则时，与单独 guarded 一致）
  → 原模式判定（yolo/guarded 放行；build/edit 走 allow 规则、预批 URL、模式默认策略）
```

- 开启 Plan 时，guarded 的危险命令单次确认排在 Plan 闸门之后：审批不能解除 Plan 的拒绝，闸门放过的
  工具命中危险命令规则时仍要单次确认。当前危险命令规则只匹配 Bash 写命令，它们会先被闸门拒绝。
- 排在 Plan 闸门之前的分支不受 Plan 约束：alwaysAsk 工具的会话内授权，以及项目 ask 规则的询问
  （同意或 PreToolUse Hook 放行后即执行）。因此 guarded + Plan 下，命中项目 ask 规则的危险命令
  走普通询问而不是单次确认。这两处是既有顺序，未在本次调整。
- 旧会话的 `mode=plan` 没有记录原模式，原模式按 build 判定。
- MCP 身份由工具权限声明 `permission.permission === "mcp"` 识别，不靠 `mcp__` 名称前缀推断。
- `readOnlyHint` 由 MCP server 自报，只用于让工具通过 Plan 闸门，不能直接放行；
  build/edit 下仍按 MCP 默认策略询问，除非命中 allow 规则。
- 非只读 MCP 在 Plan 下的询问排在 allow 规则之前：项目 allow 规则与 `allowedTools`
  不能跳过它。询问只提供单次允许与拒绝，不提供"始终允许"和"完全访问"：
  在 Plan 下记住的规则不会生效，提供这些选项会让用户以为已经授权。
  PreToolUse 与 PermissionRequest Hook 仍可按既有规则应答这次询问。
- 显式 `destructiveHint: true` 的 MCP 与其他非只读工具在 Plan 下拒绝，原模式为 yolo 也一样。
- `Agent` 与 `SendMessage` 都声明为只读，按上表通过 Plan 闸门（项目 deny / ask 规则仍在闸门之前生效）：
  子代理的工具由子会话自己的权限模式判定。
  新开与恢复已结束的子代理用同一规则、按父会话当前状态计算子会话模式（见 CLI `07-subagent.md`
  「子会话权限模式」），profile 未声明 `permissionMode` 时父会话在 Plan，子会话也在 Plan；
  给运行中的子代理发消息只投递消息，不改变它启动时的模式。
- 不改变 MCP 工具注册、模型可见 schema、输出预算、timeout、取消、日志或 UI 权限展示协议。

### SendMessage 修复原因（2026-11-09）

`SendMessage` 原来声明为非只读，在 Plan 下被 `mode.plan.nonReadOnly` 拒绝，而 `Agent` 声明为只读、可以放行。
子代理结束后报告为空时，父会话在 Plan 下无法唤醒它补发报告，只能新开子代理重做（ZCT-2119028473032097792）。
对已结束的子代理，恢复与新开用同一规则计算子会话模式，这条路径不比 `Agent` 更宽。对运行中的子代理，Plan
变宽了：父会话可以在 Plan 下给它发新指令，它仍按启动时的模式执行（例如启动时为 yolo，就免审批执行）。
这是已接受的行为变化。

### 修复原因（2026-10-31）

原实现在 Plan 下用一套独立判定替换原模式：只读工具与非 destructive MCP 直接放行，不看
`needsApproval`。因此 Plan 反而比 build 宽：任意 URL 的 WebFetch、未声明 annotations 的
MCP 写工具、宿主 `node_repl` 的 `js`（可执行本机 Node 代码）在 build 下需要审批，在 Plan
下直接执行。`EnterPlanMode` 无需确认，模型被提示注入后可以先进入 Plan 再调用这些工具。
现在 Plan 闸门只负责拦截，放行只来自原模式；非只读工具与 destructive MCP 仍直接拒绝。

- `approve` maps to permission `allow`.
- Closing the dialog maps to permission `deny` with no feedback, keeping the old
  stop-current-turn behavior.
- Custom input maps to permission `deny + reason` with `reasonSource: "plan_approval_feedback"`,
  expressing "plan needs revision". The runtime may interpret feedback only via this explicit
  source; deny+reason from hooks, project rules or other broker paths is never treated as
  feedback.
- On `reasonSource: "plan_approval_feedback"`, the runtime first injects the `ExitPlanMode` tool
  result to close the provider's tool-use protocol, then writes the custom input into real user
  message history via the active-turn pending input path carrying
  `source: "plan_approval_feedback"`. This order keeps provider-visible history as
  `assistant tool_use` → `tool_result` → `user feedback` while reusing `persistUserPrompt` so the
  next resume sees the feedback. UI renders default-source active-turn steers as guided/steer
  messages; plan-approval feedback must render as a plain user bubble.
- Plain `AskUserQuestion` does not follow this rule: its answers stay tool-call results; only
  `ExitPlanMode` approval feedback upgrades to a new user message.
- The projection layer maps `ExitPlanMode`'s pending permission to a pending elicitation and
  filters the corresponding `permission.requested` live event, so the UI never shows both a plain
  permission dialog and an input-capable dialog.

## Rationale

A rejected `ExitPlanMode` must not be fed back to the model as a plain tool failure: the model
would re-think and re-submit another plan within the same turn, showing the user a new confirmation
before they typed any feedback. A no-feedback rejection therefore carries turn control and the
runtime stops the turn right after recording it, preventing a self-loop during plan review. A
with-feedback rejection must not stop the turn, but also must not hide the user's words in a tool
result: the text is user-typed input, semantically the next query; a tool-result-only write would
produce no user bubble and break review-trail recovery on resume — hence the real user-message
persistence path.
