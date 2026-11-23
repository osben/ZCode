# Subagent Session Directory

## Goal

A parent Session's subagent state is one read-only projection that drives the Activity capsule and its
popover, the subagent directory and stale-tab cleanup. The directory shows only
Agent/Task calls in the currently effective conversation branch that can be reliably tied to a
persisted `subagent_child` session. It creates no placeholder session and adds no database table.

Workflow activity does not enter this projection; existing Workflow data structures and interactions are unchanged.

## Authority and query

```text
child runtime ── persist subagent_child session ── SubagentSpawned/status/stopped
                                                   │
                                                   ▼
CLI ProductProjection V4 snapshot.subagents
├─ revision
├─ childSessionIds[] (current branch manifest)
├─ running[] (complete, not paged)
└─ endedTotal
       │
       ├─ desktop-continuous ────────────────┐
       └─ web-remote-replayable snapshot/gap ├─ UI is a pure consumer
                                             └─ UI uses session/subagents only to query ended paged details
```

1. V4 `snapshot.subagents` is the single running-state authority of the current branch. The composer
   count, status summary, running items and child-tab invalidation cleanup all consume it directly; no
   separate `session/subagents` query rebuilds running state.
2. The UI consumes `session/subagents` only for keyset paging of ended details. It takes no part in
   counting running members or the tab manifest; the old running/manifest fields in the response are
   only protocol compatibility and CLI cold-recovery verification and are no longer renderer authority.
3. Before `SubagentSpawned` becomes externally visible, the child session must already be persisted and
   readable as `taskType=subagent_child`. run, background start and resume use the same order; the
   projection must not announce a child that does not exist yet, and there is no self-healing through
   renderer delays, polling or session switching.
4. One CLI projection commit atomically updates `childSessionIds`, `running`, `endedTotal` and the
   matching Agent row; the UI does no second stitching between events and queries. `revision` increases
   only with that projection commit, and a late or duplicate delta must not roll back state.
5. The active branch uses the append-only transcript's `keptMessageIDs + branchCutAfterMessageID`
   semantics; compact compresses only the provider context and does not delete directory members.
6. A child on an old branch removed by edit/retry leaves the projection at once; fork inherits copies of
   reliable ended `childSessionId` references in the transcript but does not inherit the original
   Session's running state.
7. Association prefers the `childSessionId` in tool output/metadata. When a foreground completion result
   has only a stable `agentId`, build the official `sess_subagent_{agentId}` identity per the Agent
   runtime rule and verify again that the session really exists with `taskType=subagent_child`. A running
   foreground uses the parent event log's `parentToolCallId -> childSessionId` relation and must still
   hit an active-branch tool call; never guess by title, time or list position.
8. A child that has run is normally already persisted after a model request, tool or cancel failure; if
   the failure happens before the first persistence, or history cannot reliably prove the child
   association, no stub is shown.
9. `running` includes foreground, background, blocked and waiting; success, failed, cancelled and lost
   all belong to `ended`, and each item keeps its concrete state. A child still running when the previous
   runtime process exited (started before this process, no live fact in this process, nothing persisted
   since this process started) no longer counts as running. A terminal state the old process wrote to
   `metadata.json` in the output directory (stopped on normal shutdown, failed, completed) shows as
   cancelled / failed / success; one without a terminal state is marked `lost`. Criteria and the
   interruption reminder to the model: Subagent tool design doc, "Agents left by a previous runtime"
   (`apps/zcode-cli/docs/design/v2/tool/07-subagent.md`).
10. Cold recovery first rebuilds rows from the persisted transcript and then validates members against
    the verified `taskType=subagent_child` fact in the session store; ambiguous, unpersisted or
    branch-cut references in old history cannot enter `snapshot.subagents`. The running recovery state is
    completed by the runtime overlay and not guessed from history titles or times.
11. The ended query response carries an independent query `revision`, uses a stable keyset cursor, 20
    per page, newest first. `snapshot.subagents.childSessionIds` is the current branch's tab invalidation
    list, not a second copy of display data.

## UI contract

```text
Activity capsule
├─ running items: top-level count of Bash / standalone Subagent / Workflow; Agents inside a Workflow are deduplicated
└─ whole batch ended: keep the result until the next successful send

Activity popover
├─ current running items and the ended items of this batch; details can be opened, controllable running items offer Stop
└─ Subagents · N -> opens or reuses the Subagent directory tab (N is the full ended total)

Subagent directory (desktop / ordinary Web)
├─ Running (not paged)
└─ Ended · N
   ├─ newest first
   └─ show 20 more
```

- The Activity running count is the total of Bash, standalone Subagent and top-level Workflow items, shown as
  "Activity N" (zh-CN "活动 N"). `snapshot.subagents.running` contains foreground, background, blocked and
  waiting together, so it must not be narrowed to "background". Agents inside a Workflow are deduplicated by
  protocol identity.
- After the whole batch ends, the completed / stopped / failed summary is kept; the next successful send clears
  it, and a failed send keeps it. When only cleared history remains, no capsule is shown, and no resident
  capsule is added for the directory.
- The history directory entry sits at the bottom of the Activity popover list; there is no longer an "Agents"
  collapsible section.
- The Activity running items use V4 `snapshot.subagents.running` as the source of child identity,
  display and Stop capability. Only when the runtime confirms the current execution supports per-item
  stop does a running item carry `stopControl` (`taskId` and this execution's `executionId`). The UI
  does not infer Agent Stop from `backgroundWorks` and never guesses by agentId, title or time. Click
  sends the parent session's `stopSubagent`; that session's runtime validates task ownership, execution
  identity and not-yet-ended state. A late command cannot stop a new execution resumed for the same
  agentId through `SendMessage`. Without the capability field no Stop shows. The button stops the
  detail click from bubbling, is disabled while the request is in flight, shows visible failure
  feedback, and on success waits for the authoritative projection to remove the item (the UI does not
  delete it early). `cancelBackgroundWork` stays for the existing Bash/Workflow control and is not
  widened.
- Stop ends only the target child, not the parent turn or other children. Foreground cancel returns a
  stop result through the original Agent tool call, sends no background terminal notification, and does
  not rewrite the stopped task as failed. Background keeps the killed notification and
  `SubagentStopped(stopped)`. If artifact write or notification enqueue fails, the target is still
  cancelled and the end event published, then the failure is reported explicitly; killed is not rolled
  back. The end event carries `executionId`, and the projection rejects late terminals from an older
  execution. When completion races stop, only the first terminal commits; the other side must not
  overwrite it or notify twice.
- `stopControl` is a current-runtime capability and is not persisted as a historical permission. Cold
  recovery rebuilds membership and display only: old events, invalid children, ended tasks and running
  rows without live-runtime proof get no Stop. Desktop continuous and mobile replayable consume the same
  projection; the runtime still validates at command time.
- A directory item uses a 20px `WorkflowAgentFace` (the completion badge scales with the same SVG) and keeps
  the agent's configured color (falling back to a color by type name when absent). Running uses the running
  expression, waiting / blocked the waiting expression, success the completion badge, failed the failure
  expression, and cancelled / lost are static. A completed status shows only the avatar's completion badge
  without repeating status text; other statuses keep localized text.
- The avatar is vertically centered with the first row by the actual row height, with no fixed top offset.
  Title, status and relative time are on the first row, and the summary or error on the second; the title uses
  `text-ui-base`, and status, summary and time use `text-ui-sm`. The duplicate in-page title is removed; with
  no running items the running group and its empty state are hidden and the ended list sits at the top. The
  directory is read-only and adds no stop/cancel control; data, ordering, paging and original-session
  navigation are unchanged.
- On live completion the V4 projection moves the item out of running and updates `endedTotal`; the
  directory then merges the item at the top by an ended-only query while keeping the loaded pages and
  scroll position.
- The directory tab uses a 16px neutral static `SubagentCollectionIcon`, vertically centered with the title,
  and shows no single agent's status or completion badge.
- The directory tab's stable identity is `subagent-directory:{workspaceKey}:{rootSessionId}:{parentSessionId}`;
  a child tab is `subagent-session:{workspaceKey}:{rootSessionId}:{childSessionId}`.
- Clicking a directory item reuses the unified child detail open request. Repeated clicks within the
  same root reuse; the original Session and a fork root differ, so each can hold a tab pointing to the
  same historical child.
- When edit/retry invalidates a child, the corresponding detail tab closes automatically and does not
  enter "recently closed"; if that tab is active, return to an open directory first, otherwise to the
  previous visible tab. compact does not close tabs.
- The directory tab and child tabs live only in renderer memory and are not restored across refresh.

## Multi-client boundary

- Desktop and ordinary Web provide the directory and paging.
- Mobile `/remote` provides no directory; Agent/Task and Running rows can still open the child detail in
  the existing right drawer.
- Desktop keeps `desktop-continuous` and mobile keeps `web-remote-replayable`; both consume the same V4
  `snapshot.subagents`, and mobile reconnect still recovers via the existing snapshot/gap. The ended-only
  query reaches the same CLI/runtime through the current trusted host attachment and adds no state in the
  relay, desktop main or Host.
- A remote workspace carries `workspaceIdentity` and `remoteSessionId` throughout; the identity key is
  always `workspaceIdentity?.trim() || workspacePath`.

## Accessibility, theme and i18n

- 目录 section 和 item 使用语义标题、button、可见 focus；状态不能只靠颜色表达。
- 使用 `DESIGN.md` 的 surface/text/border/semantic token，兼容 Zai Light/Dark。
- 文案通过 zh-CN/en-US locale；标题和摘要允许长文本换行或截断，不依赖中文长度。

## 持久化 workspace 与执行目录（2026-10-26）

- Bash `cd` 只修改执行 cwd。Agent 子运行时继承父运行时稳定的 workspacePath / workspaceIdentity，正文和父子关系仍由 CLI 持久化。
- 历史辅助会话若缺 workspace identity，允许沿持久化 parentID 找到目录 owner，旧 cwd 可以与 owner 不同。只有最终 owner 的路径和身份均匹配请求 workspace 才允许打开；显式外部身份、删除、断链、环一律拒绝。不得把 child 写成 Host 普通任务。
- 元数据查询、显式 resume、桌面 continuous 和手机 replayable 冷订阅使用同一父链判定。Host 反向回调只消费 CLI 已验证的 directorySessionId，不反向查询阻塞中的 CLI 队列。
- 回归须实际执行 Bash cd 后创建 Agent、检查 SQLite 身份，再重启打开历史正文；历史错误 cwd 单独覆盖，不以新数据测试替代。
