# Tool Display Rendering

> Current state: V4 rows reuse the unified ToolCall renderer through an adapter layer; this document
> describes the current rendering boundary.

## Goal

Unify the display entry of chat tools so conversation rows do not pile up branches by `kind`, while leaving
an extension point for dedicated rendering of `execute`, `search`, `fetch` and other tools.

## Current Structure

- `packages/ui/src/lib/toolDisplay.ts`: normalizes `ChatToolCall` into `ToolDisplayModel`; outputs
  `inlinePreview`, `viewerSource`, `showInput`, `showOutput`, `showKind`.
- `packages/ui/src/lib/codeViewer.ts`: extracts `text / patch / file / image` preview data; it does not
  decide the final UI and only provides preview capability.
- `packages/ui/src/v4/ConversationRowView.tsx` and `packages/ui/src/v4/toolCallRowAdapter.ts`: adapt a V4
  `ToolCallRow` to the unified renderer input, without duplicating per-tool UI in the row component.
- `packages/ui/src/ToolCallBlocks.tsx`: renderer registration and selection;
  `packages/ui/src/ToolCallBlocks/renderers/` holds kind/family-specific display.
- `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx`: generic parameters, results, files and Markdown
  preview.

## Visibility in the Conversation Stream

- `EnterPlanMode` is the internal boundary of a conversation mode switch and offers no actionable detail to
  the user; the main stream renders no tool row for it in `inputStreaming` / `running` / terminal states.
- Visibility filtering applies only to UI render units: the protocol projection keeps the original
  `ToolCallRow`, and run state, cold restore, mode switching and diagnostic traces must not be lost because
  display is hidden.
- The filter runs on the render units shared by desktop `desktop-continuous` and mobile
  `web-remote-replayable`, and does not rewrite either delivery's snapshot, gap recovery or message order.
- Conversation work items derive consecutive non-read-only Shell calls into an `Execute` UI group; that
  parent node is not a protocol tool call and, once expanded, keeps reusing the single
  `ExecuteToolCallBlock`. PermissionDialog does not go through this aggregation and still approves and
  shows the real tool call individually.

## Collapsed-Detail Measurement Boundary

A sidebar toggle changes the conversation width and the virtual list may remount historical turns. A
collapsed tool detail keeps Radix's DOM, ARIA and animation lifecycle, but a fully hidden node must not
write measurement styles or read geometry; visible, collapsing and `forceMount` content keep the original
measuring flow. Performance must not be bought by removing the first-expand animation, reducing history
content or changing expand memory.

```text
sidebar width change -> timeline height measure and virtual window update -> historical tools mount
  fully hidden -> keep collapsed state, skip useless measurement
  expanded / collapse animating / forceMount -> original size measurement and Presence lifecycle
```

The affected layer is presentation; the fix is at the size-measurement boundary of
`@radix-ui/react-collapsible` (ESM and CommonJS in sync). Tools, message history, project groups and
Accordion share this dependency, so check initial closed, default open, mouse/keyboard toggle, nesting,
quick reverse toggle and `forceMount`. `ToolLayout` still holds tool expand memory, Radix holds animation
presence, and `ConversationTimeline` remains the scroll owner. Mobile Web shares the display component;
protocol, permission, tool execution and continuous/replayable transport are unchanged, so those unaffected
combinations are not expanded.

SPT05 acceptance uses real DOM geometry calls and animation events as evidence: on first/second mount of
batch-collapsed tools the measurement of hidden nodes is zero; expand and collapse animation, detail
content, keyboard and expand memory are kept; the height variable still works for default-open and
`forceMount`. Desktop/mobile, light/dark and zh/en are verified together. Timing records serve before/after
comparison, not machine-dependent absolute durations. Timeline resize following, off-bottom and session
position reuse the SRM10 regression.

## Extension

- A new kind-specific optimization first adds a strategy in `toolDisplay.ts`; a strategy only enhances the
  display decision and does not rewrite the main render skeleton.
- File-type tools prefer reusing the preview extraction of `codeViewer.ts`; image resources go through the
  `image` preview first, other binaries keep the fallback hint.

## Dedicated Tool Renderers

- `ToolSearch` uses a search summary card by exact tool name, reusing WebSearch's icon, running state and
  failure hint. The card is never expandable and renders no parameters, search results, schema or raw data.
  The summary uses the input `query`: `select:Read,TodoWrite` shows as "搜索工具：Read, TodoWrite" (Search
  tools: Read, TodoWrite), a keyword query keeps the original text; with input not yet arrived or empty only
  "搜索工具" shows. zh/en share one render path and a long query keeps the search card's single-line
  ellipsis. This split is UI-only: ToolSearch is not added to the generic search family or Explore
  aggregation, and tool results, model requests and persistence are unchanged. Desktop live, cold restore
  and mobile Web share the renderer.
- The expanded layout of `Node REPL` / Browser Use tools stays transparent and on the same horizontal
  baseline as the tool summary body; no whole-block horizontal padding on top of `ToolLayout`'s detail
  spacing. The text result block and the code/error stack after "查看执行细节" (View execution details)
  each use `bg-card border border-border rounded-xl`; images, the "查看执行细节" button and the collapse
  layout stay outside the card. A single-line, non-JSON result of at most 160 characters shows as ordinary
  secondary body text; JSON, multi-line or longer logs keep the CodeBlock with copy/wrap actions. Image
  results always use a single column in the stream's expanded area, to avoid too-narrow two-column
  thumbnails on narrow desktop columns and mobile Web; the large-image viewer is unchanged.
- The expanded area of the `CUA` tool shows only user-facing action, result, failure reason, suggestion,
  screenshot, permission, environment, list and app state, and offers no "view raw data" entry of the full
  tool call JSON. Raw input, output, display and lifecycle metadata are still kept by the existing protocol
  and persistence chain but do not enter the CUA expanded UI shared by desktop and mobile Web; raw-data
  capability of other tool renderers is unaffected.
- `ReadSessionContext` renders through `ReadSessionContextToolCallBlock`, not the fallback `Parameters` /
  `Result` JSON blocks. The summary row shows the `query` of this context read with `sessionId` as a
  secondary identifier; the expanded area shows only `query` and the returned context content (for a
  structured output prefer `output.content`, then fall back to text output or `rawOutput`).
- `SendMessage` belongs to the `message` family and renders through `SendMessageToolCallBlock`. The
  collapsed state composes one full sentence: "已发送/正在发送" (sent/sending) + input `summary` + "给/to" +
  target agent `to`; the expanded state shows only target agent, summary and message body, never delivery
  status, message/agent/task id, output path, result or the whole tool call JSON. When target, summary and
  message have all not arrived, expansion must be disabled, so no empty detail panel appears on streaming
  input or a snapshot whose fields are not loaded.
- The primary display data of `SendMessage` is the `local_agent_message` display payload generated by Core
  outside the model-content formatting and hook additional-context concatenation. The payload keeps only
  `status`, failure `error` and result `message`, and must not carry or show delivery, message/agent/task
  id or output path; `error` and `message` are each bound by a 4 KiB UTF-8 budget, truncating on a full
  code point and appending a `...[truncated]` marker, so display cannot bypass the tool result budget and
  amplify live events and persisted snapshots. Lowercase `send_message` is a different session mailbox
  semantics and must not reuse the `SendMessage` identity, display or renderer.
- If the `SendMessage` display returns `status: "failed"`, it shows "消息发送失败" (message send failed)
  and a failure status as a business failure even when the outer tool call is completed; a real tool
  failure likewise must not keep showing "已发送". Structured output, JSON strings, plain-text model content
  and `rawOutput` / `result.content` are only old-snapshot/provider compatibility fallbacks; success or
  failure must not be inferred from error text.
- The collapsed `SendMessage` state must cover every terminal state explicitly: `completed` "已发送",
  `failed` or a display business failure "消息发送失败", `denied` "发送已拒绝", `stopped` "发送已停止"; a
  non-success terminal state must not fall into the success text.
- `TaskStop` belongs to the `task-control` family and renders through `TaskStopToolCallBlock`. The
  collapsed state uses only the stopping/stopped action text and `task_id` (the deprecated `shell_id` is
  accepted at input stage), never `task_type`; in the expanded state the summary row keeps the task id and
  the detail area shows only task type, task description or command, and result message, without repeating
  the task id nor the whole tool call JSON.
- The primary display data of `TaskStop` is the Core-generated `task_stop` display payload with fields
  `taskId`, `taskType`, optional `command`, result `message` and optional `truncated` only. `command` and
  `message` are each bound by a 16 KiB UTF-8 budget; truncating either sets `truncated: true`, so display
  cannot bypass the tool result budget; the expanded UI must state clearly that details were truncated.
  Live events read from `raw.result.display`, persisted restore from `raw.display`, other providers may
  read from `raw.rawOutput.display`; all three entries go through one UI reader with strict kind/field
  validation.
- The successful output/model content of `TaskStop` keeps the original tool contract; the runtime must let
  `command` mean the real command for `local_bash` and a short `description` for `local_agent`, never
  putting the full subagent `prompt` in the result. For `local_agent` the UI shows the `command` of a
  trusted `task_stop` display as "任务描述" (task description) in body style; command tasks keep showing it
  as "命令" (command) in monospace. A historical `local_agent` result without display must not show the old
  `output.command` as a description (that field may hold the full prompt); the old field is used only to
  recognize and compress the standard success text exactly. The display projection only removes the
  duplication already shown by the separate `command` field: `Successfully stopped task: <taskId>
  (<command>)` shows in the UI "结果" (result) as `Successfully stopped task: <taskId>`. For historical
  results without display the UI does an exact match of the same template only; any custom result text is
  kept verbatim.
- `TaskStop` stays compatible with old structured objects, JSON strings and `rawOutput`. A historical
  result with hook additional context may only recognize the explicit `\n\n[Hook additional context]`
  envelope and parse the JSON before it, with no arbitrary prefix truncation or text guessing. The stop
  action itself uses no destructive color; only a real failure state keeps reusing `ToolLayout`'s failure
  status and error tooltip.
- The collapsed `TaskStop` state covers every terminal state explicitly: `completed` "已停止", `failed`
  "停止任务失败", `denied` "停止操作已拒绝", `stopped` "停止操作已取消"; failure, denial or interruption
  must not appear together with "已停止". For `failed` / `denied` / `stopped` carrying an error reason, the
  expanded state shows it as "结果"; if task type, description or command, result and truncation notice are
  all absent, expansion must be disabled, so no clickable-but-empty detail panel appears.
- `TaskOutput` belongs to the `task-control` family and renders through `TaskOutputToolCallBlock`. The
  collapsed state uses the monospace `task_id` as main content and projects the status by priority "tool
  execution terminal state > retrieval status > queried task status": a tool execution failure shows the
  unified "执行失败" (execution failed), running "任务运行中", wait timeout "等待超时", successfully read
  completed task "已获取", failed/lost "任务失败", cancelled/killed/stopped "任务已停止". An unknown task
  status shows verbatim; a successful read must not always be treated as task success.
- The primary display data of `TaskOutput` is the Core-generated `task_output` display payload, containing
  only `retrievalStatus`, an optional `taskStatus` of at most 64 characters, an optional `output` of at most
  2000 characters and optional `truncated`. `task_id` is read directly from the tool input and not repeated
  in display. Output keeps the first 2000 characters after `trimEnd()`; blank output generates no field,
  and partial output obtained while running may be shown. Only non-empty output provides an expand entry,
  using a fixed-max-height scrolling `<pre>`; when truncated, a notice says the rest is omitted. Task type,
  description, error, prompt, result, output path and raw provider XML/JSON must not enter display, summary
  body or expanded content; a real tool execution failure still reuses `ToolLayout`'s generic failure
  status tooltip showing the error reason via `context.errorText` on hover/copy, and generates no expanded
  area.
- `RespondToCoordinator` belongs to the `message` family and renders through
  `RespondToCoordinatorToolCallBlock`. The collapsed state uses only the input `summary` as main content and
  offers no expanded area: running "正在回复", success "回复已排队" (reply queued), business or execution
  failure the unified "执行失败", denial and stop their terminal texts. "Queued" only means the response
  command entered the parent runtime command queue and must not be written as delivered, read or handled.
- The primary display data of `RespondToCoordinator` is the Core-generated `respond_to_coordinator` display
  payload containing only `status: "success" | "failed"`. `message`, `responseId`, `error` and the raw
  result must not be copied into display, summary body or expanded content; a real tool execution failure
  still reuses `ToolLayout`'s generic failure tooltip via `context.errorText`, and a business
  `status: "failed"` generates no invented error detail. Ordinary child tool rows materialize only in the
  child session topic; the parent session keeps showing only Agent/Task summaries and must not restore
  mirrored child tool rows for the dedicated card.
- The new displays travel through completed tool metadata and V4 `ToolCallRow.display`. For old records
  without the matching display, the two renderers show a minimal summary from the input and the generic tool
  lifecycle only, parse no provider-visible XML/JSON, and add no persistence migration.
- The formal desktop WDIO reuses the background Agent lifecycle to verify both projection chains. The
  success case really calls `TaskOutput` in the parent session and expands its output, then enters the child
  session from the Agent summary to check `RespondToCoordinator`'s summary/"回复已排队" and parent-session
  isolation. The combined error case makes TaskOutput query a nonexistent task and makes the child call
  RespondToCoordinator missing the required `message`, currently covering the error terminal state of both
  tool rows, the unified "执行失败" text, card bodies not containing the provider error wrapper or raw
  error, and the child-only boundary. The WDIO assertion that hovering the generic failure status of the two
  error cards shows the matching `context.errorText` is not added yet, so O19 stays `partial`. E2E does not
  re-enumerate retrieval/task statuses, business queue failure, the 2,000-character boundary or mobile
  replayable; those combinations are covered by targeted Core display, V4 projection/wire and shared
  renderer tests.
- These renderers all reuse `ToolLayout`, `ToolSnapshotFieldNotice`, semantic color tokens, `text-ui-base`
  body typography and lucide icons. The command in the collapsed summary of Execute/Shell tools uses the UI
  sans font, consistent with the same summary row; the expanded command body keeps monospace. JSX props
  passed to the memoized `ToolLayout` must keep a stable reference via `useMemo`; the detail layout must
  wrap vertically on narrow screens and work on desktop/Web, Zai Light/Zai Dark and zh/en text lengths.
- `Read` / `Edit` / `Write` summaries keep the file name first as the conversation stream narrows: a
  conversation container narrower than `360px` first hides the action label, source badge and parent
  directory path, the file chip uses the remaining width and truncates inside itself; file icon, diff stats
  and expand entry stay. Normal widths still show the full action label and path; desktop split and mobile
  Web share the container rule.
- All ToolCalls keep a static kind icon while running, not replaced by a spinning loading icon; running is
  expressed by the kind-text sweep, status text and summary content, avoiding continuous animation cost when
  many tool calls stream at once.
- ToolCall copy follows "running state uses an action name, terminal state a stable category name": Chinese
  `pending` / `in_progress` kind labels use "正在 + action"; English keeps the existing concise action words
  (`Reading`, `Sending`, `Working`) without mechanical expansion. After `completed` / `failed` / `denied` /
  `stopped` it returns to the category name without "已"; target, command, file and business result stay in
  the summary body, and failure, denial, stop remain expressed by the status label. Example: a single Read
  shows `正在读取 · package.json` and after completion `读取 · package.json`; a single Execute shows
  `正在执行 · pnpm test` and after completion `终端 · pnpm test`. "已读取"/"已执行" must not be used as a
  terminal category name, and the same in-progress action must not repeat in the category name and the
  summary body.
- Dedicated business states take priority over generic lifecycle text: `RespondToCoordinator` success is
  still "回复已排队"; `TaskOutput` still distinguishes task running, wait timeout, task failed and task
  stopped; `TaskStop` still distinguishes successfully stopping a task from the stop operation itself being
  denied/cancelled. The category name only says what the tool is and must not override these results.
- Explore, Terminal and Changes create a UI synthetic parent group only when at least 2 consecutive tools of
  the same kind occur inside one visible work segment; when the longest consecutive run has 1 tool, show the
  original tool with no parent group. While streaming, the first tool shows as the original tool at once
  and upgrades to a parent group anchored on the first tool's identity once the second consecutive
  same-kind tool arrives. A different kind of tool, visible reasoning and assistant text cut the run; hidden
  reasoning and a Shell still waiting for command classification are treated as transparent boundaries.
- An ordinary Explore aggregate (search, list dir, read file, etc.) can be expanded/collapsed manually even
  while running; the running state only means the message tail is still in the exploring phase, and no
  longer forces expansion or locks interaction. When a child tool is added to the same Explore segment
  during streaming, the identity of the aggregate component and expand state must anchor on the first child
  tool; the last child tool or the current count must not enter the identity key, so content growth does
  not reset an expanded detail to collapsed. While in progress the icon stays a magnifier, not replaced by a
  loading spinner. The collapsed `kindLabel` is always the tenseless `Explore` / `查阅`, never
  `Exploring` / `Explored`; summary body and kind label are always separated by a static dot, and the
  completed state also shows `Explore · 3 lists, 2 files`. The latest child's `primaryText` /
  `secondaryText` are borrowed only when its summary is already clear. Child summaries always keep the
  in-progress action form, e.g. `Explore · Reading filename path`, `Explore · Searching xxx`,
  `Explore · Running command`, not disappearing or turning into completion text when the child completes. A
  read child enters the collapsed state only after its path is resolved and reuses the Read tool's own file
  chip to keep the file icon, path tooltip and file-preview click behavior; a half-baked fallback such as
  `Read` must not take over the summary. When a child goes from running to completed, the collapsed state
  keeps the latest child content, avoiding flicker between child status words and parent aggregate stats.
  Collapsed content changes use a vertical scroll animation by default: 300ms per scroll, then a stable
  500ms rest before the next one, total under 1s per item; `ToolCallBlock.disableSummaryContentAnimation` /
  `AssistantMessage.disableToolSummaryContentAnimation` is the unified switch that turns off the summary
  scrolling of both Agent and Explore, then shows the latest summary directly and clears the pending queue;
  the lower-level `ToolLayout.disableSummaryContentAnimation` or `QueuedSummaryContent.disableAnimation`
  remain local switches. The total queue holds at most three items: the current item, the second pending
  item and a third replaceable item; the current item is not interrupted, the second is not overwritten by
  later summaries, and new summaries arriving during animation replace only the third, so stale summaries
  are not queued indefinitely. If a busy main thread makes the scroll timer clearly late, the old queue is
  not replayed but compressed to the latest summary. When Explore ends, the pending queue compresses into
  the final aggregate summary. The expanded state shows the parent aggregate stats and child tool details.
  The Explore parent is only a UI synthetic container and does not represent one real tool execution: a
  child failure appears only inside that child's detail and no child `error` may be summarized into a
  failure of the parent Explore; failure display of real protocol tools themselves is unaffected.
- The running state of Explore and Execute parents derives from stage boundaries: it is `in_progress` only
  if the group is the last visible assistant work chunk of a `running` work segment and no other visible row
  follows it. A later other tool, assistant text or visible reasoning ends the previous stage; non-first
  reasoning hidden by settings, and a Shell row deferred because its command has not arrived, are neither
  visible boundaries nor part of tail-position judgment. A terminal segment's tail is completed (shown as
  stopped if a cancelled child exists). Child tool lifecycle affects only the expanded details and does not
  decide the parent run state.
- Shell command classification for Explore aggregation must cover both Unix shells and Windows PowerShell.
  Commands wrapped by `pwsh` / `powershell.exe -Command` are unwrapped first. Known read-only PowerShell
  commands such as `Get-ChildItem` / `gci` / `dir`, `Get-Content` / `gc` / `type`, `Select-String` / `sls`,
  `Get-Location`, `Test-Path`, `Resolve-Path` go into Explore; known write or destructive commands such as
  `Remove-Item` / `del` / `erase`, `Set-Content`, `Add-Content`, `Clear-Content`, `Out-File`, `New-Item`,
  `Move-Item`, `Copy-Item`, `Rename-Item`, `Set-Item` do not. Write detection takes priority over read-only
  detection.
- The command text in Tool summaries and Execute details inherits UI sans and does not use `font-mono`;
  command output keeps `font-mono` to preserve alignment and recognizability of terminal-like data. This is
  a product exception to the global typography default for command display.
- The Execute parent group uses the cross-platform category title `Terminal` / `终端`, not referring to a
  specific Windows Terminal app; PowerShell, cmd.exe, Git Bash, WSL and Unix shells all use it, and the
  Running/Ran texts of a single Execute child are unchanged. The parent `kindLabel` and summary are always
  separated by a static `·`. While running, each scroll snapshot must contain the full action semantics
  `Running <command>` / `执行中 <command>`, never scrolling a bare command; the summary structure aligns
  with the Explore shell child summary: the action word uses `text-foreground-subtle`, the command uses
  `text-foreground-subtlest`, played as one scroll snapshot. When a running parent group is expanded, the
  parent summary shows only `Terminal · N commands`, not the action word or current command; the current
  state is expressed by the child tool summary below. The completed state shows `Terminal · N commands` with
  failure/stop stats.
- Consecutive file-write rows aggregate into a `Changes` / `更改` parent group; the parent run state, like
  Explore/Terminal, is decided by visible stage boundaries and does not depend on child lifecycle. A
  running collapsed state vertically scrolls the latest `Writing/Editing + file chip + relative directory`;
  a running or completed expanded state shows only `Changes · N files`; a completed collapsed state shows
  `Changes · N files · file chips`. Files are flattened across children, de-duplicated by full path keeping
  first order; the full list renders first, then as many leading chips as the actual summary width allows
  are kept and the rest show `+N`, recomputed by ResizeObserver on width changes to restore or collapse
  files. The multi-file summary of a single Edit keeps reusing the existing child-file renderer. Changes is
  only a UI synthetic container; child failure/stopped is not summarized as parent failure.
- The file name in the file chip reused by Edit and Changes summary/scroll content uses
  `text-foreground-subtle`, one level lower than ordinary main text; the relative directory after it keeps
  `text-foreground-subtlest`, preserving the file-name vs path hierarchy.
- Agent / SubAgent tools always use the bot icon and the outer SubAgent kind label; the agent type (e.g.
  `Explore`) must not show as the outer kind, and the bot icon is not replaced by a loader while running.
  The collapsed summary body and kind label are always separated by a static dot, and the completed state
  also shows `SubAgent · xxx`. When a child tool has a confirmable summary, the collapsed body borrows the
  latest child summary, e.g. `SubAgent · Reading filename path`, `SubAgent · Searching xxx`,
  `SubAgent · Running command`; only the child summary after the dot takes part in the scroll animation, and
  it always keeps the in-progress action form. The expanded state still shows the Agent's own prompt,
  activity content and child tool list. Without a clear child summary, the Agent's own title or description
  keeps showing.
- The visual run state of a SubAgent depends only on the parent Agent tool's `pending` / `in_progress`.
  Child tools are expanded details and do not keep the parent Agent running; when the parent Agent is
  completed, the outer converges to a static `SubAgent · xxx` even if a child tool is still running.
- When a `TodoWrite` child appears in the collapsed Agent / SubAgent state, show a todo-semantic summary,
  not the bare tool name: prefer the in-progress item, else the next unfinished item, else the last
  completed item; format `Updating todo 2/5 · current task`, and `Updated todo 5/5 · current task` when all
  are done. So when a child agent updates the plan the scrolling summary still carries concrete content
  rather than `Running TodoWrite`.
- While the current main turn is still running, the Agent / SubAgent card and the bottom chat `ChatLoading`
  show simultaneously. The Agent card and its child tools only handle tool details and do not control
  `ChatLoading`; the bottom loading hides when the main turn reaches a terminal state and also while
  waiting for AskUserQuestion or a permission confirmation, so "waiting for the user" is not expressed as
  "thinking".
- While streaming, a running shell tool is handled in two scenarios:
  - Right after `tool_input_start` arrives with the command arguments not yet complete, do not render this
    unclassified shell, whether it is a later tool of the active Explore or the first standalone tool of
    the current turn; wait until the command is classifiable, so the user does not see `Run` first and then
    an upgrade to `Explore` next frame for a read-only command.
  - An unclassified shell directly following an active Explore must not show separately as `Ran Bash` even
    if completed. Such a tool has no displayable command and should be absorbed by the preceding Explore's
    visual progress, avoiding a meaningless Bash row under the Explore summary.
  - Once the command is classifiable, render by the classification immediately: read-only exploration
    commands go into `Explore`, non-exploration commands stay standalone `Run` / shell tools, so a really
    executing command has progress feedback.
- The `Goal` tool, the `/goal` command mention in user messages, the goal summary and the goal validation
  divider all use lucide's `GoalIcon`, consistent with the user-visible `/goal` semantics, instead of
  `TargetIcon`.

## Edit Line Count

- The summary row of `Edit` / file-write tools keeps reusing `changeStat.added` / `changeStat.removed` as
  the only stats source; the UI does not re-derive diff line counts in rendering.
- When the count changes, the digits in `+N` / `-N` may use one short character-slot flip animation; the
  `+` / `-` signs stay static and colors keep `text-diff-added` / `text-diff-removed`.
- The flip animation must use fixed character width and `tabular-nums`, avoiding summary-row jitter from
  continuous desktop streaming updates or mobile replayable catch-up frames.
- With `prefers-reduced-motion: reduce` the digits degrade to static slots, keeping only the full-reading
  label for assistive technology.
- A running `Write` / `Edit` preview gets a new real `changeStat` from the projection at most once per
  second; path, content, diff and `+N/-N` of one sample must update atomically.
- The UI must not chase the target line by line with `requestAnimationFrame`. When the target goes from
  `12` to `45`, hand `45` to one short flip directly, without replaying `13`, `14` and other intermediates.
- On tool end, cancel, restored history snapshot or mobile replayable terminal state, show the real target
  immediately and do not replay stale streaming line counts.

## History Consistency

- ZCode persisted tool calls persist `status` and `raw`, so diff / image / special tool payloads of the
  live stream reuse the same display logic after refresh.
- Core's `ToolResultDisplayPayload` is the UI's structured fact boundary: display is generated from the raw
  tool output, travels through live `ToolCallResult.result.display` and is persisted through completed tool
  part metadata. Formatting, truncation and hook additional context of model-visible content must not change
  display.
- The V4 product projection must keep generic displays such as CUA and file diff in
  `ToolCallRow.output.display`; `ToolCallRow.display` keeps only the existing `node_repl_images` dedicated
  channel. The UI adapter reads `output.display` first and stays compatible with the old Node REPL
  top-level display.
- The `input` of CUA display v1 stays readable only as a compatibility field for old history; new events no
  longer write it again. The tool call's own `ToolCallRow.input` is the only input fact source, and the UI
  discards the copy when parsing old display.
- When reading display, the UI must cover both desktop `desktop-continuous` live raw events and mobile
  `web-remote-replayable` persisted metadata; replayable recovery data must not be spliced into the desktop
  continuous main chain, nor bypass the existing snapshot/gap recovery boundary.

## WebFetch and Public Tool Display

WebFetch belongs to its own web-fetch family. The summary uses a web icon, Fetch/Fetching (Chinese:
网页抓取/正在抓取) and the target URL; it does not use the prompt and is not expandable. Explicit historical
fetch/web_fetch/webfetch aliases are compatible; classification is not guessed from the URL input. The
permission preview reuses the WebFetch renderer; an Explore child reuses the URL text extraction function,
then renders through the exploration group.

The App and sharing reuse the tool renderer registry and group presentation. The App injects file media,
app icons, model provider names and agent colors through capabilities; plugin interaction is injected via
the render context's pluginUi; public display injects only resource URLs and safe external links. The pure
display layer must not statically import services, platform or plugin runtime. Fetch still belongs to the
read-only exploration group.
