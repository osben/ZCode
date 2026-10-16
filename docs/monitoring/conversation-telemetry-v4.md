# V4 Conversation Telemetry Compatibility Spec

This document freezes V4 conversation main chain telemetry compatibility criteria. Implementation uses `z-code-2` production behavior as the compatibility baseline,
restoring only previously existing data without migrating field types, metric formulas, or collection scope.

## Objectives & Non-Objectives

Restore the following production events:

- `/event/report`：`send_btn`、`message_completion`、`agent_step`、`context_compaction`、
  `assistant_message_feedback`。
- ARMS：`perf_ui_first_token`、`perf_ui_message_complete`、`perf_ui_turn_breakdown`、
  `perf_ui_stream_stall`、`perf_ui_tool_call_detail`、`plan_request`、`plan_ttft`、
  `chat_error_banner`。
- `session_quota_alert` quota banner and existing Upgrade panel handoff depending on real conversation entry.

Non-objectives:

- Web/mobile actual network reporting.
- initial snapshot、cold hydration、gap recovery 或历史 transcript 的补报。
- 修正旧版固定零值、空字符串、负值钳制和 stop-without-terminal 等历史口径。
- 把 telemetry 状态写入 conversation rows、snapshot、relay 或 main 进程。

## Architecture & State Boundaries

```text
CLI V4 live SessionEvent
        |
        | normalize metadata-only fact
        v
Host workspace telemetry service
        | validate + forward; no persistence/replay
        v
Renderer workspace telemetry supervisor
        | seed + foreground refs + bounded dedupe
        +----------------------+----------------------+
        |                      |                      |
        v                      v                      v
 /event/report            ARMS ui_perf       quota/feedback

persisted hydration / initial / recovery
        |
        +----> conversation projection only
               MUST NOT emit telemetry facts
```

Must not revive the old `zcodeTaskRuntimeMonitor`, nor place the supervisor in `SessionPane`,
`SessionDataLayer`, or on a connection under 30-second keep-warm control. The supervisor belongs to the
window's workspace/service attachment, with isolation key:

```text
endpoint + remoteSessionId + (workspaceIdentity?.trim() || workspacePath) + serviceGeneration
```

There is only one supervisor per workspace/service generation. Task switching, pane unloading, and keep-warm
expiration do not destroy it; workspace detach, window closure, or service generation change destroys it.

Foreground is a reference set to visible sessions, not a single pane owner. The same session visible in multiple splits still consumes
the fact only once; multiple different sessions can be foreground simultaneously.

## Live Fact Protocol

`ConversationTelemetryFact` is a strict discriminated union, with common fields:

```ts
interface ConversationTelemetryFactBase {
  version: 1;
  eventId: string;
  eventSeq: number;
  occurredAt: number;
  sessionId: string;
  sourceCommandId?: string;
  turnId?: string;
}
```

Fact types cover:

- `turn.started`
- `model.request.status`
- `stream.chunk`，only allows `thought | text`、length、is first chunk and optional
  `parentToolCallId`, without content body; parented subagent text does not enter main generation step, but old handler
  still records its first token and stall outside step builder. parented thought continues to preserve old reasoning/TTFT/stall
- `tool.lifecycle`, only allows tool name, status, ID, parent/child/Agent association and flat allowlist perf, without
  input/output. Runtime `ToolExecutionTelemetry` nested `detail` must be mapped field-by-field by CLI fact normalizer
  by command/filesystem/patch differentiation branch, prohibited from direct passthrough or spread`; `command.hash`remains only in
CLI local diagnostic object, does not enter V4 fact. The`commandHash` retained in shared schema does not represent official producer
  will populate this field
- `permission.lifecycle`
- `usage.delta`, only produced by `querySource=main_turn` (or compatible historical default and non-`tool_internal`) of `ModelComplete`; `session_title`、compact、subagent and other
  sidecar usage must not accumulate to user prompt
- `turn.terminal`
- `compaction.terminal`

`model.request.status` only preserves old `plan_request` and message telemetry needed provider/model/status、
request duration, error classification and provider hostname. hostname must be obtained via URL parsing, prohibited from retaining path、query、
header、header count、token、prompt、upstream original message or finish reason。

`message_completion` and `agent_step` `event_extra_detail` must also carry current workspace scenario dimensions:

- `workspace_kind`: `local` / `remote`, indicating the actual workspace type for this turn；
- `remote_kind`: `ssh` / `wsl` / `docker` / `server`, empty string when local or cannot parse remote type。

These two fields are low-cardinality dimensions, values frozen by renderer workspace attachment at supervisor creation time, and written simultaneously to the same message's completion and step. Remote type can only be parsed via unified `parseRemoteWorkspaceIdentity`; must not write `remoteSessionId`、`workspaceIdentity`、`workspacePath`、host address or other high-cardinality identity directly to telemetry。

Host determines subscription permissions based on attachment-injected trusted `clientMode`, must not trust renderer self-reporting.
Only `desktop-continuous` renderer installs real reporter; `web-remote-replayable`、Bot and automation clients
even if they can see authoritative conversation status, must not use telemetry service to generate network reporting. SSH/WSL/Docker/Server
remote chains may have multi-layer connection scope (Desktop Host attachment → trusted host relay); relay itself still
must not install reporter, but must pass the existing trusted downstream connections `clientMode` and namespace connectionId to upstream.
Only telemetry facts with trusted downstream `desktop-continuous` context can pass through relay, direct relay
subscription or `web-remote-replayable` downstream must return empty events.
Telemetry attachment is a bypass capability; Platform or agent service must be no-op until ready, cannot block
workspace/remote renderer, establish supervisor and live subscription only when dependencies are ready.

Facts are produced only from current process live ingest:

- persisted hydration、subscribe initial、snapshot and recovery: no production.
- Events arriving during hydration and sitting in live buffer: produced once.
- After CLI/runtime restart, must not synthesize completion based on orphan or historical terminal state.

## ID, Clock & Deduplication

- `talk_id = sessionId`。
- send/completion/step `message_id = sourceCommandId`。
- feedback `message_id = assistant entityId`; when missing entityId, must not use rowId as replacement。
- compaction `message_id = summaryMessageId ?? operationId`。
- renderer computes old duration at `Date.now()` when receiving live fact; `occurredAt` for diagnostic only。
- eventId uses bounded LRU of approximately 2000 items。
- terminal exactly-once by `(sessionId, sourceCommandId, eventName)`.
- compaction exactly-once by `(sessionId, operationId, "context_compaction")`; same operation
  even if anomaly duplicates arrive with conflicting terminal status, only first live terminal is adopted。
- local prompt seed retained only in memory; renderer reload does not backfill。

## Event Trigger Matrix

| Event                | Foreground                                        | Background After Cutting Away            | Initial/Recovery                                   |
| -------------------- | ------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `send_btn`           | Once when local desktop command is accepted by UI | queued promotion no duplicate report     | No report                                          |
| `message_completion` | Report                                            | Report for turn with existing local seed | No report                                          |
| `agent_step`         | Report                                            | Report for turn with existing local seed | No report                                          |
| `plan_request`       | Report                                            | Report                                   | No report                                          |
| `context_compaction` | Report only when terminal visible                 | No report                                | No report                                          |
| Six UI ARMS events   | Report                                            | No report                                | No report                                          |
| `chat_error_banner`  | Report only when banner actually visible          | No report                                | Can report after recovery when first truly visible |

`send_btn` send time comes from UI raw action. Existing session direct/queued commands report after local acceptance;
draft first send waits for create ACK to get sessionId, but retains original input/send time. Retries with same commandId,
queued promotion or command inbox duplicate do not duplicate report.

Send seed model fields continue to reuse old UI compatibility values: runtime provider (currently default `glm`) writes only `agent`;
when `config.provider !== glm`, `model_name` uses `custom:<provider>:<model>` encoding, `model_provider`
still writes the split real config provider. When real model request arrives, completion/step then rewrite to
`<provider>/<model>` per old logic. Must not change old data warehouse string criteria just because V4 config split provider/model fields.
Draft first send must derive seed from the draft lifecycle frozen initialization config merged with explicit intent
even if prewarm snapshot has not arrived; must not fall back to empty model/`glm`, nor block real send waiting for telemetry.

`message_completion` and `agent_step` only produced by prompts with seed established by desktop UI. `turn.started` binds seed with
session/turn/sourceCommandId; all subsequent facts carrying sourceCommandId must match current lifecycle. stop
without terminal preserves old behavior, no synthesized completion.

Same `talk_id + message_id` `message_completion` and all `agent_step` must use same
`workspace_kind` / `remote_kind`. Both local Desktop and Desktop remote workspace belong to
`desktop-continuous`, therefore `clientMode` only used for trusted subscription gate, not as workspace scenario dimension.

When tool terminal fact arrives, must immediately close corresponding tool step at that moment, and first report
`/event/report agent_step`; same turn `message_completion` only closes at subsequent turn terminal. If normal tool
terminal is dropped due to fact schema failure, turn terminal will still fallback-close open steps but will
extend `duration_ms` to entire turn end, and may override real tool status, error and failure counts with turn state. This fallback
is preserved only for real missing/anomaly paths, must not be used as normal desktop continuous path success path or test basis.

`TurnComplete(cancelled)` preserves old two-phase close: agent step still closes with `task_complete` success, then
`message_completion.status="user_interrupt"` with old fixed error
`USER_INTERRUPT / User stopped generation`. Only real `TurnError` uses `task_error` to close step.

`plan_request` directly consumes real model network state, covering old five states; allows foreground/background and does not require local prompt seed.
Must not infer from `apiRetry`、accepted、queued or other projected states. eventKey uses 2000-item FIFO/LRU deduplication.

Six UI performance events and `plan_ttft` only update/close during session foreground. stream stall must strictly
be `> 3000ms`; tool start/update and terminal clear tracker; tool detail reports only when allowlist perf is non-empty.
Old stats accept first thought、text (including parented child chunk) or tool as first token. Old prompt
with no thought/text/tool before terminal, completion `time_to_first_token="-1"` still mirrors once
`perf_ui_first_token(value=0)`; `plan_ttft < 0` or empty provider does not send. First token arriving only in background
cannot be back-calculated as UI TTFT after switching to foreground.

Old production completion calls never passed `fileChanges`, therefore `file_change_cnt`,
`generated_code_lines` and corresponding ARMS breakdown attributes are fixed as `"0"`/`0`. V4 even with runtime
file summaries, must not use migration to correct these two metrics.

Compaction uses old runtime model values: non-`glm` provider `model_name` is
`<provider>/<model>`, `model_provider` retains provider id; differs from `send_btn`'s
`custom:<provider>:<model>` UI encoding. `reason` only reads old timeline actually consumed `reason`; must not use
V4 `compactReason` to backfill empty string.

`chat_error_banner` reports after error truly rendered visible, once per same key per component mount; reducer/UI
suppressed errors do not report. Normal provider business error preserves old visible recovery action and business code dimension; official version security validation
internal recovery action does not enter banner telemetry.

When error projected from CLI to UI, may carry `attribution` structured facts: `source`、`reason`、`providerId`,
`modelId`、`providerKind`、`transport`、`statusCode`、`providerErrorCode`、`retryable`,
`errorPhase`、`exceptionKind`. These fields
are all optional, used only for fault attribution and monitoring aggregation; must not change existing banner visibility, copy, buttons, retry, security validation or
feedback behavior. Old events and old persisted records missing attribution continue with original fallback.

`chat_error_banner` expands above facts into whitelist as
`error_source`、`failure_reason`、`provider_scope`、`provider_id`、`model_id`、`provider_kind`,
`transport`、`status_code`、`provider_error_code`、`failure_retryable`、`failure_phase`,
`failure_exception_kind` while preserving existing fields. Built-in providers may retain stable IDs;
Custom providers uniformly normalized to `provider_scope=custom`、`provider_id=custom` to avoid high cardinality or privacy leakage from user custom names. `model_id` only allows retaining built-in stable model IDs in telemetry explicit whitelist; custom provider
models and built-in provider models not hitting whitelist uniformly written as `custom`, empty string when provider or model missing.
Whitelist matching and output both use normalized lowercase IDs, new built-in models not entering whitelist must default to `custom`, must not pass through as-is. Prohibited from uploading base URL/full URL、header、token、request or response body、prompt/tool content、stack、full
detail、requestId. ZCode only reports factual attribution, does not report `owner` or `shouldAlert` monitoring strategy conclusions.

`exceptionKind` must be standardized by allowlist at adapter boundary, prohibited from passing custom Error name as-is into protocol or ARMS.
`failure_reason=unknown` does not equal missing diagnostic fields; Dashboard separately stats reason coverage and
`source + errorPhase + exceptionKind` diagnostic coverage.

Attribution enters snapshot with authoritative conversation error state, therefore live continuous and persisted cold
hydration should get same attribution for same error; it does not trigger telemetry backfill. Desktop still only reports via
`desktop-continuous` reporter when banner actually visible, mobile `web-remote-replayable` does not add new network reporting capability.

`source` must be determined by error occurrence boundary, cannot guess from failure reason alone. Priority: user cancellation and
local provider config before request sent, request option validation, unknown adapter exception归为 `runtime`; TLS、proxy、
connection and timeout explicit transport failures归为 `network`; rest归为 `provider` only when provider response, provider business error
or provider content validation failure upstream evidence exists. Same `invalid_request` reason
therefore may归为 `runtime` or `provider` depending on whether provider response exists; explicit network reason remains `network` even if
carried by provider response.

When adapter error with structured attribution passes runner terminal boundary again, `source`、`reason`,
`retryable`, `statusCode` and provider business error fields are responsibility of boundary that first obtains valid evidence; subsequent boundaries
can only fill missing values, must not override with coarser reclassification. `attempt`、`requestId`、`traceId`、`providerId`,
`modelId`、`providerKind` and `transport` etc. this-request facts still based on current runner boundary. To preserve original stack,
cause and caller's existing error object references, existing adapter error context补齐 must not replace error object; compact etc.
call sites can continue appending phase fields they explicitly own.

## 业务触发链路

### Assistant feedback

V4 提供 `setAssistantFeedback` CAS command：

```ts
{
  target: {
    kind: "assistantEntity";
    entityId: string;
  }
  feedback: "like" | "dislike" | null;
}
```

CLI 更新 assistant row 并持久化。UI 乐观更新、command 失败时回滚；点击时仍立即上报旧格式：

```ts
{
  eventType: "ck";
  eventRegion: "chat";
  elementName: "assistant_message_feedback";
  eventExtraDetail: {
    reaction: "like" | "dislike" | "none";
  }
}
```

相同 reaction 再点一次写 `null` 并上报 `none`。

### Session quota entry

V4 quota banner 必须恢复可见性、dismiss、提交阻断、entitlement refresh 和 Upgrade 面板。
只有已有购买面板确认打开后才由原购买模块上报 `coding_plan_upgrade_ck`，对话入口负责传递：

- `eventRegion = app.session`
- `upgrade_source = session_quota_alert`

购买模块内部的 product/cycle/pay/result 与支付结果不属于本次 conversation 重构恢复范围；本次只验证
Upgrade 面板真实打开且 funnel context 没有在对话入口丢失。

## 验证合同

- Golden tests 必须比较完整 payload，包括字符串化数字、空字符串和固定零值。
- fake clock 覆盖 first token、3000/3001 stall、permission waiting、terminal exactly-once。
- schema/privacy tests 证明正文、工具内容和 URL path/query 不会进入 fact。
- gateway/service tests 证明 live buffered event 一次，initial/hydration/recovery 零次。
- desktop E2E 用 `/event/report` fetch mock 和测试构建专用的有界 ARMS ring buffer 验证生产入口；
  ring buffer 不得在生产构建暴露或持久化。

conversation 正式用例编号与剪枝结论见 case catalog 的 `TEL` 分组和 E2E coverage matrix。
新旧版本运行时差分、原子化回归 case 与自动化分层见
[`conversation-telemetry-differential-regression-plan.md`](../testing/conversation-telemetry-differential-regression-plan.md)。

## Memory 开关维度（2026-09-17）

`send_btn`、`message_completion`、`agent_step` 的 `eventExtraDetail` 均包含
`memory_enabled`：`"1"` 开启、`"0"` 关闭、`""` 表示旧 CLI/旧事实未提供状态。
它只表示会话运行实例创建时采用的 App Memory 设置，不表示 CLI memory 最终生效、
记忆读取命中或写入成功；不新增 read/write 指标，不改变 Memory 开关行为。

唯一数据源为 CLI `ZCodeProtocolSessionRecord.memoryEnabled`，不在发送或完成时重新读取
App 当前设置。用户中途修改设置不会改变存量运行实例；新建/冷恢复实例使用其创建期值。

```text
会话记录 memoryEnabled
  ├─ accepted command ACK → prompt seed → send_btn / completion / agent_step
  └─ live turn.started → 后台任务 seed → completion / agent_step
                           └─ child step 继承来源 prompt 的值
```

ACK 与 live telemetry fact 增加可选 boolean `memoryEnabled`；缺失保持 unknown，不默认关闭。
新建/选区侧聊 ACK 读取结果 session 的记录，普通发送读取目标 session 的记录。
先于 ACK 的普通事实继续使用现有 pending fact 缓冲；child 启动事实直接沿用父会话字段，不等待 ACK；去重、FIFO、workspace identity 不变。
后台任务不伪造 send_btn；子 Agent 继承来源 prompt 的开关，不把其自身记忆工具使用当开关。
传输只增加无正文元数据，CLI snapshot/历史恢复不补造 telemetry fact。桌面保持
`desktop-continuous` live reporter，手机 `web-remote-replayable` 不安装 reporter、
不扩大 telemetry 采集范围；命令 ACK 在两端均兼容新字段。

验收：开/关各验证三个事件同值；设置变更后存量实例不漂移；后台轮和 detached child
继承；事实早于 ACK、重复 ACK 保持原有去重；旧 CLI 缺字段留空；非 boolean 协议值被拒绝。
现有 Memory E2E 增加默认关闭与新会话开启的三事件断言。

### 本次验证边界

- 2026-09-17：根工程与 CLI typecheck、根 lint、architecture changed 检查通过。
- UI/协议相关 112 项单测通过；gateway/workflow fact 回归 108 项通过、1 项失败。
  失败项为既有 `Core admission ACK 不等待 TurnStarted projection；旧 revision retry/file rewind 只 stale`，
  使用未修改的 staging gateway 复跑仍得到相同失败。
- CLI lint 被未修改文件的既有 `max-lines` 错误阻塞。
- Memory WDIO 的 `before all` 未能选择 Full access/yolo 模式，未到新增埋点断言；
  不能把本次运行作为桌面开/关埋点的端到端通过证据。手机远控未进行新增实机验证，
  原有 reporter 的 desktop-continuous 边界保持不变。
