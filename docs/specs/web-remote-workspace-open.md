# Web 远程控制：在桌面打开新 worktree 工作区

## 目标与范围

手机 / 浏览器 Web 远程客户端可以完整走通命令中心 “在 worktree 中新建任务” 流程：

1. 通过既有 RPC 通道（`gitService.createWorktree`，中继通用 RPC 访问器）创建 worktree；
2. 通过**新增的 window-control 请求** `workspace-open-request` 让**桌面**把新 worktree 作为工作区打开（复用桌面 deep-link 打开链路，禁止并行实现）；
3. 打开成功后刷新工作区列表并通过**既有** `workspace-bridge` 切换（`webRemoteControlWorkspaceSwitcher`）挂接到新工作区。

范围外：Web 客户端不得自建 Host（本地工作区归桌面窗口 Host 所有，硬性架构规则）；中继只转发与调度 attachment，不保存业务状态；`allowOpenWorkspace={false}` 保持不变——任意路径的 "打开工作区" 入口继续禁用，worktree 流程（用户显式创建的目录）是唯一豁免路径。

## 所有者与事件顺序

```text
┌──────────────┐   ┌──────────────┐   ┌────────────────────┐   ┌──────────────────────┐   ┌────────────────────────┐
│ Web 客户端    │   │ 外部中继      │   │ Desktop Main       │   │ Desktop Renderer     │   │ Window Host (utility)  │
│ main.tsx     │   │ (relay)      │   │ webRemoteControl   │   │ (Root / tab store)   │   │ 桌面窗口本地 Host       │
│              │   │              │   │ Manager +          │   │                      │   │                        │
│              │   │              │   │ handleOpenWorkspace│   │                      │   │                        │
└──────┬───────┘   └──────┬───────┘   └─────────┬──────────┘   └──────────┬───────────┘   └───────────┬────────────┘
       │                   │                     │                         │                           │
  [1] gitService.createWorktree ──(既有 RPC over bridge/relay)──────────────────────────────────────->│ 执行本地 git
       │<── created ───────────────────────────────────────────────────────────────────────────────────┘
       │                   │                     │                         │                           │
  [2] POST /api/remote-control/windows/{token}/workspace-open               │                           │
       │ {workspacePath, workspaceIdentity?} ─>│ 转换为 window-control 消息 │                           │
       │                   │── workspace-open-request (zcode_type) ───────>│                           │
       │                   │                     │ 校验 runtime/window     │                           │
       │                   │                     │ handleOpenWorkspacePath │                           │
       │                   │                     │── OpenWorkspacePath IPC >│ handleSelectProject:      │
       │                   │                     │                         │ activateOrSetWorkspace /   │
       │                   │                     │                         │ addTab + startDraft        │
       │                   │                     │                         │── syncWebRemoteControl ──> │
       │                   │<─ workspace-open-response {success} ──────────│   Workspaces (工作区快照)   │
       │<── 200 {success} ─│                     │                         │                           │
       │                   │                     │                         │                           │
  [3] GET /api/remote-control/windows/bootstrap/{token}（轮询，有限重试）    │                           │
       │                   │── bootstrap-request ─> getAvailableWorkspaces │                           │
       │<── workspaces 含新 key ────────────────────────────────────────────│                           │
       │                   │                     │                         │                           │
  [4] POST .../workspace-bridge {workspaceKey}（既有切换链路，不改）         │                           │
       │                   │── workspace-bridge-open ──────────────────────>│ attachWorkspaceHost ─────>│ 复用/新建 attachment
       │<── bridge ────────│<─ workspace-bridge-ready ──────────────────────│                           │
       │ connectViaWebSocket(bridge.wsUrl)  -> renderBridgeRoot(新 Root，initialWorkspaceAbsPath=worktree，
       │ 无 initialTaskId -> 启动 draft)     [流程结束：新工作区 + 新任务草稿]
```

所有者划分：

- **创建 worktree**：Web 客户端编排，执行归桌面 Host 的 gitService（既有事实，不变）。
- **打开工作区（桌面侧）**：Desktop Main `handleOpenWorkspacePath`（deep-link 既有入口）路由到目标窗口 renderer 的 `handleSelectProject`（与桌面命令中心一致的 activate/addTab + startDraft 契约）。Main 不保存任务/会话业务状态。
- **打开工作区（Web 侧）**：新 window-control 请求只声明意图；成功响应表示“已派发到目标窗口”，不表示 renderer 已完成（见幂等边界）。
- **挂接**：既有 `workspace-bridge` 通道，单活跃 bridge，跨 Host 路由与 stale run 保护全部保留。

## 协议变更（packages/shared）

- `packages/shared/src/web-remote-control.ts`：
  - `WebRemoteControlWorkspaceOpenRequest` / `WebRemoteControlWorkspaceOpenSuccessResponse` / `WebRemoteControlWorkspaceOpenErrorResponse`（`type: "workspace-open-request"` / `"workspace-open-response"`，携带 `requestId`、`windowControlSessionId`、`workspacePath`、可选 `workspaceIdentity`，字段与 `workspace-bridge-*` 兄弟消息一致），加入 `WebRemoteControlWindowControlRequest` / `Response` 联合。
  - 中继↔桌面传输层：`WebRemoteControlWorkspaceOpenRequestPayload`（`zcode_type: "workspace-open-request"`）与 `ResponsePayload`（success / success:false + error），加入 `WebRemoteControlAppPayload` 联合。
- `packages/shared/src/validation.ts`：上述 app payload 的 zod schema 加入 `webRemoteControlAppPayloadSchemas`（`workspacePath` 必填非空，`workspaceIdentity` 可选非空），未通过校验的载荷照旧在传输边界被拒绝。
- UI 侧 API：`WebRemoteControlWorkspaceSwitcherApi.openWorkspace?(target: { workspacePath; workspaceIdentity? })`（仅 Web 远控 switcher 实现）。

身份规则：键统一为 `workspaceIdentity?.trim() || workspacePath`。worktree 是新建本地目录，无 identity，键即路径；协议仍透传可选 `workspaceIdentity` 以与兄弟消息一致，桥接匹配沿用 `resolveWebRemoteControlWorkspaceKey`，不允许“仅按路径”匹配带 identity 的目标。

## 验收场景

1. **正常流程**：Web 远控命令中心选择项目 → 输入分支 → Start；worktree 创建成功后自动向桌面派发 open，随后列表刷新出现新工作区并完成 bridge 切换，新 Root 以 draft 状态进入新工作区。
2. **重复打开（已打开）**：目标路径已是桌面某窗口的已打开 tab：renderer `activateOrSetWorkspace`/`activateTabByPath` 激活既有 tab，不产生重复 tab；open 响应仍为 success；Web 侧切换到该工作区。
3. **并发打开竞争**：同一客户端 Start 有 busy 门（`worktreeStartBusy` + attempt ref），不会并发派发两个 open；不同客户端同时 open 同一路径：renderer addTab 按身份键去重，双方最终收敛到同一 tab，各自 bridge 挂接（桌面单活跃 bridge 按 runtime 隔离）。
4. **桌面窗口关闭中**：`BrowserWindow.fromId(windowId)` 为空或已销毁 → open 依赖抛错 → `workspace-open-response {success:false}`；Web 侧显示既有失败 toast，不残留本地 tab。
5. **路径非法**：非绝对路径 / 网络路径（UNC）/ 不存在的目录：`handleOpenWorkspacePath` 的 `isValidLocalWorkspaceDirectory` 拒绝并返回 `success:false`。已配对的 Web 客户端本就持有本地 Host 的 RPC（可创建 worktree），open 不引入新的能力面；校验与 deep-link 相同。
6. **中继未升级**：中继无该端点时 Web 侧 fetch 失败 → 走 Command Center 既有 `openFailed` toast（带重试），不做本地降级打开。
7. **既有消息不受影响**：`window-bootstrap-request` / `workspace-bridge-request` / `mobile-view-state-update` 处理路径与 zod 校验保持不变（测试回归）。

## 幂等边界

- open 请求按 `requestId` 一问一答；桌面不缓存、不排队重复 open（renderer 端 addTab/activate 本身幂等，重放安全）。
- `workspace-open-response` 的 success 语义是“Main 已接受并派发到目标窗口 renderer”（deep-link 同语义）。renderer 完成 addTab 后由既有 `syncWebRemoteControlWorkspaces` 推送快照；因此 Web 侧在 success 后**轮询**工作区列表（有限次数），key 出现后才发 bridge 请求——bridge 匹配失败（“目标工作区不在当前桌面窗口中”）即视为打开未完成，重试耗尽后报错。
- bridge 切换沿用既有单活跃 bridge 语义（先释放旧 attachment 再挂新）；失败时旧 bridge 保持，不产生半开状态。

## 验证

- `pnpm typecheck` / `pnpm lint` / `npx oxfmt --check <changed>` / `pnpm architecture:check --changed`。
- 单测（vitest）：新 zod schema（合法/非法/缺 identity）；desktop manager 分发（成功、依赖抛错传播、既有 window-control 消息不受影响）；Web 侧 open→刷新→bridge 切换编排（含列表延迟出现时的有限重试）。
- 中继为外部部署，仓库内无对应转发实现：端到端联调（真机 + 中继升级）不在本仓库验证范围，记录于 PR "Not verified"。
