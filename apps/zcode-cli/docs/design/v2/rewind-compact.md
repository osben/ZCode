# Rewind and Compact Collaboration Design v2

## Scope

Defines the shared state model of rewind, checkpoint and compact in ZCode v2. It is neither a UI design
nor the implementation detail of the file restore adapter. It fixes four things:

- which conversation rewinds are legal after compact;
- how file checkpoints from before compact stay usable;
- how message attachments and large-file artifacts are kept or degraded across compact, rewind and fork;
- which recoverable, auditable contracts rewind / checkpoint must enter.

Compact owns the model-visible context; rewind owns restoring session and workspace state. They share
the session event log and the message/checkpoint anchors, but neither may directly tamper with the other's
history.

The phased implementation plan of conversation rewind is in [`rewind/plan.md`](./rewind/plan.md). It
lands this contract in the runtime, session store, TUI and ZCode app-server, and records the semantic
boundaries to keep.

## Auto Compact trigger basis

The auto compact trigger must prefer the real input token usage returned by the provider over local
character estimates. After each model request the runtime records its `usage.inputTokens`, the number of
provider-visible messages at request time, the model reference and trace information. At the next auto
compact check:

1. If a usable real `usage.inputTokens` exists, it is the baseline token count.
2. If assistant, tool or user messages were appended after the previous request, estimate locally only
   for the new messages and add that to the real baseline.
3. Only without real provider usage, fall back to a full local estimate of the current active chain.

Reason: OpenAI-compatible providers can differ by an order of magnitude from local estimates because of
tokenizer, tool schema, reasoning or server-side wrapping; real server usage is the highest-priority fact
source for compact decisions.

The local estimate is a conservative watermark when provider usage is unavailable. It must count both
ordinary body text and the text of `reasoning` blocks; it must not reuse a helper that projects only
visible body text and count reasoning as 0. Provider `reasoningTokens` is already included in
`outputTokens`, so it must not be added again when the usage anchor is reused. The estimate still
approximates tokens by character count, does not promise to match any provider tokenizer, and does not
change canonical history or provider-specific reasoning replay rules.

If a provider signals context overflow through a finish reason, such as `model_context_window_exceeded`
in GLM SSE, the runtime must normalize it to `ModelContextExceeded`, trigger reactive compact or throw a
structured error; empty content must not be treated as a normal `end_turn`.

## Core principles

### 1. The event log is the source of truth

Compact, checkpoint and rewind all append events or parts and never delete old history. The UI may hide
scrollback before compact and the provider active chain may start after the compact boundary, but audit
and advanced recovery can still find old state from the event log or transcript.

### 2. The active chain is the model-visible projection

After full compact the active chain by default contains only:

```text
compact boundary
compact summary
preserved messages
attachments
hook results
messages after compact
```

So conversation rewind by default selects only messages inside the active chain. Selecting a message
before the compact boundary must not be presented as an ordinary rewind.

### 3. Workspace checkpoints are independent of conversation visibility

File-modification checkpoints are not deleted by compact. Even if the anchor message of a checkpoint is
covered by compact, a file-only rewind can still run. After it, a new `rewind_triggered` event must be
appended, and the next model context must state which checkpoint the workspace was restored to.

### 4. Conversation rewind across the compact boundary uses an append-only branch cut

When the user goes back to a conversation point before compact, the current session neither physically
deletes old messages/parts nor creates a child automatically. The session persists
`keptMessageIDs + branchCutAfterMessageID + branchGeneration`; the active branch is the kept prefix plus
new messages after the cut. Only then is the last compact boundary within the active branch selected to
build provider history. Compact summary/boundary, microcompact, context usage and read-file derived
state that were cut off must be rebuilt, and no model-visible reminder describing the old prompt may be
appended.

### 5. Attachment artifacts are independent of workspace checkpoints

Images, PDFs, binaries and large-text previews in user messages are session input artifacts, not
workspace mutation checkpoints. File-only rewind restoring workspace files must not reinterpret already
committed attachments; conversation rewind cleaning message/parts must not delete attachment artifacts
immediately. Attachment artifacts are garbage-collected lazily through reference counting or an
unreferenced scan.

## Rewind scope

`RewindScope`:

- `conversation`: restores only the model-visible message chain, no file change.
- `workspace`: restores only the file/workspace snapshot, no change to the conversation active chain.
- `both`: restores conversation and workspace together.

`RewindStrategy`:

- `active_chain`: the target can be rebuilt from the append-only transcript and applied directly in the
  current session; crossing a compact boundary is allowed.
- `file_only`: the target checkpoint is restorable, but the conversation target is covered by compact.
- `fork_required`: reserved for explicit fork/workspace fork results; conversation edit/retry no longer
  hits this strategy because of compact.
- `unavailable`: the target does not exist or no usable checkpoint exists.

## Where compact and rewind intersect

### Full compact

Full compact writes `CompactBoundary.lastSummarizedMessageId`, the last message before the boundary
covered by the summary. After that:

- the active chain starts at the compact boundary;
- conversation checkpoints from before compact do not appear in the ordinary message selector by default;
- file checkpoints from before compact may appear in the advanced checkpoint list, but must be labeled
  `covered_by_compact`.

### Partial compact

Partial compact must record `preservedSegment`:

- `headMessageId`
- `anchorMessageId`
- `tailMessageId`

If the target is inside the preserved segment, conversation rewind may be handled as active chain. If the
target is covered by the summary, the full compact rules apply.

Partial compact must not split a tool_use/tool_result pair, nor the thinking/tool blocks of the same
assistant message id. The segment preserved in the `up_to` direction must drop the old compact boundary
and old compact summary, so backward scans never hit an old boundary.

### Persistence and cold recovery of the recent preserved segment

The recent groups already selected by auto/reactive compact do not enter the summary and must keep the
same persisted content in live and cold recovery. The selection unit is the existing assistant-started
round: the persistence side takes the most recent groups by the same group count and then records the
original `headMessageId / tailMessageId`; the message count obtained by source filtering in the runtime
must not be used to cut another candidate list in the database. `keptMessageCount` is computed from the
actually selected persisted records, is statistical only, and must not in turn decide the range.

Within the groups, user, coordinator, sub-Agent replies, background task notifications and persisted
Runtime Attachments all keep original text, identity and presentation markers. `synthetic`, `model-only`
and `source` express input identity or UI visibility and are not grounds to drop provider context. Tool
results are restored together with the tool parts of their assistant. Compaction control records,
timeline records with `providerVisibility=hidden` and failed records without model content stay
excluded; request-local prompts add no persisted copy and are still generated per their own lifecycle.

```text
runtime recent N assistant groups ──> live kept as is
                  |
active session takes the same recent N groups ──> save range IDs ──> cold recovery of the whole range
                                                    |
                                     unified MCS / non-MCS projection
```

The existing range schema is reused and old databases are not migrated. Old ranges also restore the
synthetic/attachment content they contain; messages that were wrongly excluded from the range at that
time cannot be inferred from the historical range, so the boundary is not extended retroactively. The
preserved segment takes part only in provider history and does not change the latest message anchor of
the post-compact timeline. Desktop continuous and mobile replayable keep consuming the same CLI
authoritative history without changing their own transport and recovery boundaries.

Regression tests must go through real compact boundary persistence and cold hydration and verify, with
the MCS switch, original text, complete reminders, roles, tool batches and counts; a test that only
copies runtime entries cannot prove cold recovery correct.

### Compact 之后的上下文布局

compaction 结果的顺序（boundary → 请求前公告 → summary → 保留段 → compaction 附件）：

```text
[context prefix (system)]
[请求前公告] context_prefix → session_context → date   仅当保留段非空；保留段已有的来源不重复（date 也一样：保留段里有日期公告时，即使已过期也不放，之后的请求在末尾宣告一次变化）
[summary]
[保留段]
[compaction 附件] 文件恢复 → plan_file_reference → runtime_mode（计划模式下的完整提醒，保留段已有完整提醒时不发）
                  → tool_search_announcement → agent_listing_delta → skills_listing → environment → model
                  → output_style_instructions
```

- compaction 附件（含文件恢复与 plan_file_reference）都参与冒泡，附件之间保持生成顺序。支持 MCS 时它们都是 system，在 user run 末尾按上表顺序合成一条 system；不支持 MCS 时都是 user 侧 reminder，顺序相同。
- 文件恢复（`resume_referenced_session_context`）在 summary 返回之后重读磁盘上的当前文件，不用读取状态里缓存的视图：
  - 候选：compact 前读取状态里 `Read`、`Write`、`Edit` 留下的记录。不选 Bash 回填、Recall 注入、`MEMORY.md` 初始记录和工作流草稿的记录；不选 plan 文件、已加载进上下文前缀的指令文件，以及 `.codex/memories/`、`docs/superpowers/plans/`、`.git/` 下的文件；不选保留段里 Read 过的文件（路径按当前工作目录解析后比较；返回 `file_unchanged` 的 Read 不算，它只指向已被摘要的旧结果）。
  - 选择：按时间从新到旧先取 5 个，再读取；读取失败或被跳过的文件照样占名额。本进程写入的记录（包括 rewind 重建的记录）按文件的 `mtimeMs` 排序，冷恢复出的记录（`restoredFromSession`）按读取时间排序；缺 `mtimeMs` 时用读取时间。
  - 读取：整个文件，不带 `offset` / `limit`。不走工具调用流程：没有 hook、工具事件和权限弹窗；只跳过命中读权限 deny 规则的文件，ask 规则照常读取；判定与 Read 工具调用共用同一个模式与规则判定，规则只加载一次。规则按原始字符串匹配，所以记录的规范化路径和工具输入的原始写法（读取状态的 `requestedPath`：live 由工具记下，冷恢复取自 tool part 的输入）各判定一次，任一命中 deny 就跳过：同一写法的 Read 被拒的文件不会被补回。补回后写回的记录保留原始写法。plan 文件和补回文件并行读取。只补回文本文件：图片、视频、PDF 和 Read 预检不通过的文件（二进制、设备文件）跳过。读取传入取消信号，读完再检查一次；取消时整个 compact 取消，不产出附件。
  - 内容：`Called the Read tool with the following input: {"file_path":…}`，换行后是 `Result of calling the Read tool:` 和 Read 工具结果原文。估算超过 5k token，或超过 Read 的文件大小上限时，只放引用提示（"Note: … was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it."）。按顺序累加，总量超过 50k token 的文件丢掉，不放提示（单文件不超过 5k、最多 5 个文件时实际不会触发）。
  - 读取状态：compact 后的 live 表只含补回的文件，记录规则与重启后的行为见 [Read File State Resume](tool/17-read-file-state-resume.md) 的“Compaction 之后”。
  - 补回内容随 compaction 附件一起持久化，冷恢复读到相同字节，不再重读磁盘；已有的 compaction 不改写。

- 输入附件在 compaction 之前运行，属于保留段或被摘要；同一请求在 compaction 之后不再收集输入附件，只运行按历史去重的请求前公告。保留段为空（manual compact）时，请求前公告由下一次请求追加在末尾。
- summary 文本：续写提示（"Continue the conversation…Pick up the last task as if the break never happened."）之后，保留段非空时再追加 `\n\n` 和尾注 "The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them."。判定与请求前公告相同（保留段非空）；manual compact 不带尾注。尾注随 summary 文本持久化，冷恢复读到相同字节；已有 summary 不改写。
- summary 是普通 user 消息，按用户输入参与相邻 user 的换行规则：summary 前紧挨的 user 文本（例如保留段非空时的请求前公告）以 `\n` 结尾。判断依据是 `compactBoundary`，不按 `legacy_synthetic` 来源（旧的后台通知也用这个来源）。
- 压缩提示词包括第 6 节末尾的用户消息归属说明（"Only messages that actually came from the user (user-role turns) count as user messages…"）和 `</example>` 之后的换行。
- runtime_mode 由 compaction 重述：计划模式下发一条完整的 plan 提醒。保留段在当前计划段（最近一次退出计划模式之后）已有完整提醒时不发：auto/reactive compaction 与输入附件收集在同一次循环中，保留段可能已带本次收集的完整提醒，再发一条会出现两条完整提醒，完整／简短周期也多算一次。保留段只有简短提醒时，完整说明已被摘要，照常发完整提醒。
- environment 与 model 由 compaction 重述：保留段已有完整 environment 块时不重述 environment，否则用 compact 前历史中最近一次公告的快照发完整块；保留段已有 model 公告时不重述 model，否则重述 compact 前最近一次 model 公告。compact 前历史里没有对应公告时不重述，由下一次请求的输入附件收集追加（完整环境块、当前模型）。
- output_style_instructions 在 model 之后重述：保留段已有该来源（包括重置）时不重述；否则重述 compact 前最近一次公告，最近一次是重置时不重述。它不受 environment/model 的 env_info 门控。
- 持久化：请求前公告、summary、compaction 附件按上表顺序在同一事务中写入（`SessionStorePort.commitMessageBundle`），存储顺序与 live 一致；只有 summary 成功产出时才写入。store 未实现该方法时逐条写入，失败时尽力删除已写入的记录。
- 声明：summary 的 compaction part（与 `compactBoundary.preservedSegment` 同一个 part）在 `metadata.compactLeadingMessageIds` 中记录请求前公告的消息 ID。只记录 summary 之前的公告；compaction 附件可能在下一次 compact 时与最后一组一起被保留，不得写入该列表。
- 冷恢复：最后一个 boundary 声明的请求前公告放在 summary 之前。切片 `preservedSegment` 区间时，跳过所有 summary 声明的请求前公告：保留段可以落在上一次 compact 的保留段里，此时区间在存储顺序上跨过上一次的公告和 summary；这些公告在压缩后的第一组，总被下一次 compact 总结，不会出现在 live 保留段中。
- fork：重映射 `compactLeadingMessageIds`；映射不到的 ID 丢弃，不阻断 fork（旧版本 fork 会原样复制该字段）。
- 旧版本兼容：不改 strict 的 `compactBoundary` schema。`CompactionPart.metadata` 不进入 App 协议，旧版本按 JSON 读取 part 时忽略它。旧版本冷恢复时，summary 之前的公告不在 `slice(boundaryIndex)` 范围内，会被漏掉；跨过的保留段可能带回上一次的公告。这两种情况只影响上下文内容，不会导致读取失败。
- git status 与分支：规则只看历史（见 `loop/meta-user-context.md`）。保留段非空且其中没有 `session_context` 时，compaction 通过 `ContextSourcePort.resolveGitContext` 按当前目录重新读取（分支直接读取，不使用轮询缓存），是仓库才在 summary 之前宣告；保留段为空时由下一次请求读取。读到的 Git 只进入公告，不改 runtime 的 context 快照，compact 写库失败时不留任何 Git 事实。没有 context port 的运行时沿用会话起始快照。
- skills_listing：在 compaction 附件中紧跟 agent_listing_delta。保留段里没有 skills_listing 且当前 skill 目录不为空时重述完整列表，判定与输入附件收集相同；compact 后的第一次请求就带 skill 名单。ZCode 不找回已调用的 skill。已恢复列表的原位更新见 `loop/meta-user-context.md`。

### File rewind after compact

When executing a file-only rewind of a pre-compact checkpoint the runtime must:

1. Verify the checkpoint snapshot is available.
2. Restore the workspace snapshot.
3. Append a `rewind_triggered` event with `strategy=file_only`.
4. Append a synthetic user/status message that can enter the model context, stating the restored
   checkpoint, the file count and the risk.
5. Leave the compact boundary of the active chain unchanged.

### Fork rewind

`/fork latest` and `/fork <checkpointId>` create a new child session instead of deleting or rewriting
history in the current session. The first version aims at "start a new line from here" while staying
recoverable:

1. The current session keeps the full history and compact boundary.
2. The child session's `parentID` points to the current session.
3. The child session copies the parent's messages/parts from the beginning to the message of the
   checkpoint and regenerates message/part ids to avoid cross-session primary-key conflicts.
4. Attachment `FilePart` metadata is copied with the message/part; immutable attachment artifacts may
   share a URI or increment a reference count.
5. If an attachment artifact of the parent session is missing, the child session must degrade the part
   to a `[Missing attachment: ...]` fallback and record a debug event.
6. The runtime restores the workspace files from the checkpoint artifact.
7. The child session appends a synthetic user/status message stating the fork origin, checkpoint,
   restored files, attachment degradation and compact risk.
8. The current session appends a `session_forked` event; the TUI may switch the active app to the child
   session.

If the anchor message of the checkpoint is covered by compact, fork is still allowed; this is the default
path for conversation rewind before compact. It does not pretend to return to an old message inside the
original session; it explicitly opens a new session.

### Attachment artifacts after rewind

The cleanup of conversation rewind only changes the active chain or deletes message/part references after
the target point and never deletes attachment artifacts immediately. This supports:

- forking back to the old branch after an accidental rewind;
- a compact summary that can still explain attachments that once existed;
- later GC of the artifact store by reference scan or retention period.

File-only rewind restores only the workspace checkpoint. Even if a restored workspace file path equals the
original `file://` path of an attachment, a committed attachment is still defined by the artifact
snapshotted at commit time and must not be overwritten by re-reading the current workspace file.

For a part-level rewind whose target is inside the same user message, `FilePart.source.text` decides
which attachment placeholders were deleted. After a placeholder is deleted, the matching `FilePart` no
longer enters the model projection, so orphan attachments are not sent to the provider.

## Contract

### CheckpointCreatedPayload

Fields:

- `checkpointId`
- `messageId`
- `scope`
- `snapshotRef`
- `diffRef?`
- `fileCount?`
- `compactBoundaryId?`
- `coveredByCompact?`

`coveredByCompact=true` means the message anchor of the checkpoint is no longer in the current active
chain, but the snapshot may still be restorable file-only.

### RewindTriggeredPayload

Fields:

- `rewindId`
- `scope`
- `strategy`
- `targetMessageId?`
- `targetCheckpointId?`
- `compactBoundaryId?`
- `restoredSnapshotRef?`
- `createdMessageId?`
- `reason?`

An event with `strategy=fork_required` may serve as the UI/SDK intent record; the real fork is done by
the session service appending `session_forked`.

### SessionForkedPayload

Fields:

- `originalSessionId`
- `forkedSessionId`
- `targetMessageId?`
- `targetCheckpointId?`
- `restoredSnapshotRef?`
- `restoredFileCount?`
- `strategy`
- `attachmentArtifactRefs?`
- `missingAttachmentRefs?`

### CompactBoundary attachment fields

The compact boundary records attachment summary fields for debug, fork and rewind decisions:

- `attachmentMessageIds?`
- `strippedAttachmentCount?`
- `strippedAttachmentBytes?`
- `strippedAttachmentRefs?`
- `missingAttachmentRefs?`

These fields describe only the attachments stripped or degraded at compact time; they do not mean the
attachments are still in the active model context.

## First implementation batch

- runtime schema: checkpoint payload, rewind payload.
- workspace checkpoint artifact schema: `workspace_file_before_change`, containing per file the path,
  whether it existed, the pre-change content and a structured diff.
- `evaluateRewindTarget()`: decides the strategy from the message list, target id, scope and checkpoint
  availability.
- Event payload types wired into `SessionEventPayload`.
- Projection records `lastCheckpoint` and `lastRewind`.
- After a successful file mutation write a checkpoint artifact and append `checkpoint_created`.
- `/rewind` shows recent checkpoints; `/rewind latest` or `/rewind <checkpointId>` executes a workspace
  file-only restore.
- `/fork latest` or `/fork <checkpointId>` creates a child session, copies the message chain and restores
  the workspace snapshot.
- Restore goes only through the `ToolArtifactStorePort.readToolResultArtifact()` and
  `FileSystemPort.writeTextFile/removeFile()` adapters and never touches the underlying fs directly.
- Attachment artifacts are first only retained and referenced; rewind cleanup does not delete them
  immediately.
- Unit tests cover: active target after compact, file-only before compact, conversation fork-required
  before compact, missing target, fork attachment fallback, rewind not deleting artifacts by mistake.

Not done: TUI message selector; partial compact runtime.

## Follow-up milestones

1. `contracts: rewind checkpoint payloads`: schema, event payload, projection, pure functions.
2. `core: create checkpoints around file mutations`: build snapshots before/after file writes through the
   file-system adapter, events carry the traceId.
3. `core: file-only rewind`: restore the snapshot and append a synthetic context message.
4. `tui: checkpoint selector`: for now shown through the `/rewind` command and live events; the active
   chain target selector follows later, with compact-covered checkpoints in the advanced list.
5. `core: fork-required conversation rewind`: conversation rewind before compact creates a fork instead
   of polluting the current active chain. The first version triggers it explicitly via `/fork`; later the
   message selector can automatically turn compact-covered conversation rewind into a fork proposal.
