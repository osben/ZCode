# Model Trajectory Viewer

> E2E behavior catalog and coverage state:
> [`docs/testing/model-trajectory-e2e-coverage-matrix.md`](./testing/model-trajectory-e2e-coverage-matrix.md).
>
> Trajectory v2 (event ledger, time overview, request params and tool catalog, tool durations and
> TTFT) is a separate sidebar tab specified in
> [`specs/model-trajectory-v2.md`](../specs/model-trajectory-v2.md); the v1 view described here is
> unchanged. The new model-io `timing` field is specified in
> [`specs/model-io-stream-timing.md`](../specs/model-io-stream-timing.md).

The task context menu / header more-menu gains "查看调用轨迹" (view call trajectory), visualizing a
task/session's full model-call history in the right sidebar: system / user / assistant / tool
roles, per-call model, token usage, duration, finishReason, tool call inputs and results, error
stacks.

## Data sources

- `model-io-*.jsonl` under `~/.zcode/cli/debug` (dev) and `~/.zcode/cli/rollout` (production, at
  most 3 recent session files).
- Written by `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` as
  `model-io-<sanitizedSessionId>.jsonl`. One session maps to one JSONL file; the first record
  stores the full `request.messages`, later calls store only the message delta since the previous
  record, avoiding gradient repetition of the full context. Each record carries
  `sessionId` / `turnId` / `traceId` / `querySource`, `request` (messages / toolNames), `response`
  (text / reasoningText / toolCalls / usage / finishReason), `error`. AI SDK `response.reasoning`
  must be flattened to `response.reasoningText` before persisting: extract text per reasoning block
  in order, joined with a blank line; in-block newlines are kept. Omit the field when there is no
  valid reasoning text, to avoid empty "thinking" rows. `querySource` and `model.role` distinguish
  main-session requests, title generation, compact, subagent and other sources; for old logs
  without `querySource`, the service layer compatibility-detects known title-generation prompts.
- TOOL message `content` in actual model-io is usually a string, while `toolCallId` / `toolName`
  sit at message top level; when normalizing to `tool-result`, the service layer must keep those
  top-level association fields — mapping output alone would leave the UI unable to correlate tool
  call IDs.
- Historical tool calls of ASSISTANT messages live in top-level `toolCalls` (`{ id, name, input }`),
  not in `content`; the service layer projects them in record order as `tool-call` parts after the
  `content` segments, with the same bounding rules as `response.toolCalls` (see
  `specs/model-trajectory-projection.md`).
- The write path must be bounded: writing model-io after a model request is a diagnostic side path
  on the agent main flow; appending a record must never synchronously read and expand the whole
  history JSONL. Long sessions once drove a single production rollout file to ~1 GB, and the old
  implementation's `readFileSync(filePath, "utf8")` plus per-line `JSON.parse` / expand could
  trigger a native crash during UTF-8 conversion or V8 string allocation, killing the agent child
  process before ordinary JS logs were flushed.
- The current implementation judges deltas only from the in-process previous request summary; on
  process restart, missing cache, history mismatch, or a file over the production hard cap, it
  writes a bounded baseline of the current request (keeping only the recent tail messages when
  needed) and continues appending deltas after that baseline. Production rollout is a "recent
  bounded trajectory", not a promise of unlimited full replay; dev debug keeps more raw fields but
  likewise never re-reads the whole history file on write.
- ZCode Agent uses `taskId` as `sessionId` (see the multiple `sessionId: params.taskId` in
  `zcodeTaskServiceAdapter`), so the trajectory reads only `model-io-<sanitizedTaskId>.jsonl` and
  matches exactly on `record.sessionId === taskId`. Only the ZCode Agent (glm) writes model-io.
- Projection single-segment text must be bounded: `packages/services/src/zcode-agent/modelTrajectory.ts`
  applies a per-byte budget trim to every projected content segment (text / reasoning / tool-call
  input / tool-result output / unknown raw), `response.text` and `response.reasoningText`. Budget is
  **16 KiB total output including separators**: a segment is trimmed only when its UTF-8 bytes
  exceed 16 KiB; the trim yields the first 12 KiB + the fixed separator `\n…\n` (5 bytes) + the
  remaining last 4,091 bytes, so a trimmed segment is never larger than the original. Trims split
  on UTF-8 character boundaries, never cutting multi-byte characters or surrogate pairs.
  Over-budget segments carry `truncated: { originalBytes, omittedBytes }`, `originalBytes` being
  the pre-trim UTF-8 size.
  - An over-budget string TOOL output is no longer `JSON.parse`d: kept as a string and marked;
    `error-text` output trims only `value`, keeping the error type.
  - Object tool input / output and unknown raw over budget are serialized to a JSON string and
    trimmed; the output type becomes a string.
  - Response-level trimming is expressed via `response.truncated: { text?, reasoningText? }`.
  - Trimming affects only projected data: display, search index and copy all use the trimmed
    projection; copied text is the trimmed text, and the omitted middle is unsearchable and
    unrecoverable by expanding.
  - `error.stack` is never budget-trimmed; a single error's stack is far below budget and error
    blocks are not collapsible anyway.
  - The budget bounds single-segment size only, not the `records` count or per-record
    `request.messages` count. Cross-record input repetition is handled by the input-delta contract
    below, so the total projected bytes are no longer "records × context length".
- Projection input deltas (`inputDeltaOf`): the model-io disk format is unchanged (readers still
  read whatever the writer emitted — full context or writer delta). After projection and before
  the RPC return, the Host decides, per record in the `limit` window, whether to send its
  **projected full input** as a delta instead.
  - Eligibility: only `callSource.kind === "main"` records can be deltas. Sidecar (title
    generation, prompt enhance), compact and subagent records always carry full input.
  - Base: the **most recent main record before it inside the window** (not the adjacent record).
    When title generation or compact sidecars interleave between main calls, the later main call
    can still delta against the earlier main call. A base with an empty-string `requestId` cannot
    serve as base.
  - Decision: the base's full projected input must be an **exact prefix** of the current record's
    full projected input — compare each `role` and `parts` content identity (serialized results
    equal verbatim); any position differing makes it a full record. Comparison happens on the
    post-trim projection: two records differing only in a trimmed middle segment count as equal,
    and reconstruction then matches per-record full projection exactly. Never substitute counts,
    lengths or object references for content comparison.
  - On a hit: `request.messages` holds only `full.slice(sharedPrefixCount)` plus the optional field
    `inputDeltaOf = { previousRequestId, sharedPrefixCount }`, where `sharedPrefixCount` equals the
    base's full input length. A miss, missing field, or old-Host record is a full record (absent
    field means full).
  - The window's first main record has no base in the window and is always full; records outside
    the window are never referenced. `limit` semantics and segment budgets are unchanged.
  - Implemented as `projectInputDeltas` in `zcode-agent/modelTrajectory.ts`; type
    `ZCodeModelTrajectoryInputDelta` in `zcodeTaskService.ts`.

  Owners and event order:

  ```text
  model-io file (disk still full context or writer delta)
     │  readModelTrajectory: tail 32 MiB read → sort by time then expand writer deltas (all raw records, order kept)
     ▼
  keep tail (limit semantics unchanged)
     │  mapRecord: full projected input after segment budget trim (owner: Host projection)
     ▼
  projectInputDeltas: base = nearest main record in window; exact prefix → delta, else full (owner: Host, same synchronous segment)
     │  RPC: records[], request.messages may hold only the delta, inputDeltaOf optional
     ▼
  resolveTrajectoryTimelineItems (owner: view, pure function, useMemo-derived, no state kept across renders)
     │  nearest preceding record.requestId === previousRequestId → full = [...base.slice(0, n), ...delta]
     │  missing / n !== base.length → base-missing (render delta rows with a notice)
     ▼
  display rules (counting rules unchanged) → row window / search index / preview / copy
  ```

- The read path is likewise bounded and async: the Host reads blocks from the file tail, scans at
  most 32 MiB, keeps only the last `limit` records; never `readFileSync + split` the whole JSONL. A
  scan start landing mid-record discards that partial line; an unreadable file degrades to an empty
  result. Dev logs record scanned bytes and duration to help locate abnormally large files, while
  keeping high-frequency diagnostics out of production logs.

## Layering and key files

Service layer (host-side disk reads; desktop reads local, mobile remote reads the remote host; UI
consumes structured results only):

- `packages/services/src/session/zcodeTaskService.ts`: `ZCodeModelTrajectory*` types and
  `IZCodeTaskService.getModelTrajectory({ taskId, limit })`.
- `packages/services/src/zcode-agent/modelTrajectory.ts`: async bounded tail read of the single
  session file, delta-message restoration, normalization of messages / parts / toolCalls / usage,
  sort by `startedAt`, keep the last N over `limit` (default 200); `projectInputDeltas` does the
  input-delta decision within the window (see "Data sources").
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`: implements `getModelTrajectory`.
- `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts`: besides the tail read, carries
  the segment-level byte budget trim (`boundText`, `boundPayload`, `withTruncation`; 16 KiB output
  cap including separators), UTF-8 boundary splitting, `truncated` markers, and bounded
  `{content}` wrapping. Same directory as `modelTrajectory.ts` for the read path; the directory is
  an unmanaged module, so no new file was added.

UI layer:

- Call content shows no `INPUT` / `OUTPUT` big section titles; input message rows and `ASSISTANT`
  output headers sit directly in data order, cutting uninformative vertical hierarchy.
- Entry: `TaskActionMenuContent.tsx` gains the trajectory item, wired through
  `TaskListItemContextMenu` → `TaskListItem` (task list) and `WorkspaceHeaderSections` (header).
- Bridge: `store/modelTrajectoryStore.ts` singleton store +
  `hooks/useModelTrajectoryOpenBridge.ts`. Deep menus request "open trajectory" via the store; the
  target workspace's `useAppPanels` subscribes and opens the sidebar tab by `workspaceKey` match —
  no callbacks threaded through the task-list tree, no cross-workspace instance mixups.
- Sidebar tab: `lib/workspaceSidePane.ts` adds the `model-trajectory` tab type and
  `openModelTrajectorySidePane`; `app-shell/AnimatedSidePanePanel.tsx` renders `ModelTrajectoryPane`;
  `app-shell/SidePaneTabTrigger.tsx` / `SidePaneTabOverview.tsx` add icon and title.
- View: `ModelTrajectoryPane.tsx` + `ModelTrajectoryPaneParts.tsx`, data via
  `hooks/useModelTrajectory.ts`.
- Input reconstruction: `ModelTrajectoryTimeline.tsx`'s `reconstructTrajectoryRecords` (pure
  function) is called by `resolveTrajectoryTimelineItems` before display rules, row windows and the
  search index; the `TrajectoryInputContext` type lives in `ModelTrajectorySearch.ts`. The
  trajectory content area uses a native vertical scroll container, not Radix `ScrollArea`, avoiding
  its auto-inserted `min-width: 100%; display: table` wrapper that drags long content into abnormal
  width calculations.
- The side pane's `ResizablePanel` shell must override the `react-resizable-panels` inline
  `overflow:auto` with `!overflow-hidden`; the shell and tab content must never both scroll
  vertically. Each tab owns its content scroll area; the trajectory scrolls only via
  `ModelTrajectoryPane`'s native `overflow-y-auto` container.

## Display model

Each model-io record is "one model call". The view organizes the trajectory in time order as
**input (user / tool results) → output (assistant text / reasoning / tool calls)**:

- The first call shows the full starting context (system + initial user + history assistants).
  Assistants in the starting context render as shared message rows like system / user / tool, not
  as an unfolded monolithic body.
- Later main-session calls show only the non-assistant messages added since the previous call
  (assistants are presented by the previous call's output), avoiding history re-painting.
- Sidecar requests (title generation, compact, prompt enhance) show their own full prompts, without
  the main-session delta rules.
- Input reconstruction runs before these display rules: a record with `inputDeltaOf` takes, in time
  order, the **nearest preceding record** with `requestId === previousRequestId`, uses its already
  reconstructed full input `base`, and reconstructs `[...base.slice(0, sharedPrefixCount),
  ...request.messages]`. Reconstruction reuses base message object references only, never copies
  content. Records without the field are full inputs, behaving as before.
- On a missing base (no preceding record, the preceding record itself missing, or
  `base.length !== sharedPrefixCount`), the record renders its carried delta rows with **no
  assistant filtering** (the base's output may be the only copy of those assistant rows) and shows
  "前文缺失" in the card input area
  (`data-trajectory-input-context="base-missing"`). No throw, no hiding; later records' counting
  base stays `sharedPrefixCount + delta count`.
- The reconstructed full input is the sole source for later display rules ("later main-session
  calls show only…"), row windows, search index and preview; those modules are delta-unaware.
- The header totals call count, tokens and models used; each call card's single-line header shows
  source, finishReason, in/out tokens, duration and time.
- Each call card header shows a source badge (e.g. 主会话 / 标题生成 / 上下文压缩 / 子代理).
- The source title and finish-reason pill must expose the stable semantic attributes
  `data-trajectory-source-kind` / `data-trajectory-query-source` and
  `data-trajectory-finish-reason` besides localized copy. E2E verifies projection via these
  attributes; English display copy is not a functional contract. Internationalized copy is verified
  by representative assertions with an explicit fixed locale.

## Compact layout and interaction

- The trajectory is a single-column call log, no nested cards: each call is a summary row plus
  expandable details, separated only by standalone `h-px bg-border` dividers — no container border;
  the list has no outer four-side padding, dividers sit flush with the panel edge.
- Panel header and each call's summary header use `px-3 py-2` for compact, consistent spacing of
  index, title, tags and metadata.
- The call summary is single-line: left is "index + source title + semantic finish-reason pill";
  right is `IN {inputTokens} · OUT {outputTokens} · duration · time`, right-aligned. Calls do not
  repeat a model pill or attempt; the model set stays in the panel overview header. The source
  title and pill must be adjacent, with the flexible gap between the pill and the right metrics; in
  a narrow sidebar the source title truncates first and the right metrics stay complete.
- Call source uses `text-ui-sm font-medium text-foreground`; the semantic finish reason uses a
  `bg-tag border-border text-ui-xs` pill; index and right metadata use `text-ui-xs`.
- The index uses a `size-5` line box, centered horizontally and vertically, aligned with title and
  pill — not centered with the whole two-line summary.
- Each call's summary row sticks to the top while the content scrolls, with a translucent
  `surface` background, light backdrop blur and a `border-border/50` bottom line, keeping the title
  readable as payloads scroll under.
- A call's IN / OUT top level is always expanded — no collapse interaction for the whole call; only
  individual messages and payloads keep second-level folding.
- Large input cards follow "Row window for oversized input cards" below: with more than
  `TRAJECTORY_COLLAPSED_BY_DEFAULT_ROWS` (40) input messages, the card's message rows start
  collapsed and mount only the first `TRAJECTORY_ROW_PAGE_SIZE` (40) rows.
- The panel header action area, left of "open source directory", has one "expand all / collapse
  all" toggle, shown only with trajectory records present. Icons reuse Task List's
  `Maximize2 / Minimize2` at `size-3.5 text-foreground`. A row's default state follows its card:
  cards with ≤ 40 input messages start all-expanded; over 40 start collapsed (see the row-window
  section). The batch button's initial action is still collapse-all, flipping to expand-all after
  triggering; each batch action synchronously overrides currently mounted rows via an incremented
  command version, and unmounted rows derive from the same command at mount. Single rows still
  toggle independently and never rewrite the batch button's next action. Defaults derive directly
  from the shared command plus per-row lazy state — no per-row `useEffect` second update.
- Left of "expand all / collapse all" is a custom-expansion menu. It lists the six content types
  System, User, Reasoning, Assistant, Tool Call, Tool Result, each with an `sm` Switch for the
  target expanded state; clicking the row or the Switch updates only that type, and the menu stays
  open for consecutive configuration. Expand/collapse-all syncs all six switches. Type commands and
  the global command share a monotonically increasing version; a later command supersedes older
  per-row overrides of the affected types; types not hit by this type command keep their state. The
  menu and all copy must be internationalized.

```text
Header toggle
    ├─ expand all   -> command(open=true, version+1)  ┐
    └─ collapse all -> command(open=false, version+1) ┴─ row render reads the latest command directly

row trigger -> local override(open, current command version) -> only that row changes
next header command(version+1) -> supersedes every older local override
```

Batch commands must not be re-synced into local `open` state by per-row `useEffect` — N messages
would add N state writes and a second commit round after each Context update. Each row compares
the batch command version with its local override version during render and derives `open`
directly; a single-row action records the current command version, and the next higher-version
batch command naturally supersedes it.

- Expanded content splits into `IN` / `OUT` sections. Cards with ≤ 40 input messages default all
  input rows expanded; over 40, input rows default collapsed and mount only the first page (see the
  row-window section). Output rows (reasoning, assistant messages, tool calls) never vary with
  input count and always default expanded. Clicking a row collapses it to a single-line preview;
  expanding again shows full text, reasoning, tool input or tool result, with no second nested fold
  inside. Collapsed rows mount no expanded body, so no `<pre>` or body DOM is produced.
- The call-content wrapper uses `p-2 gap-y-2`, giving uniform 8px padding and 8px gaps between
  groups; `INPUT` / `OUTPUT` are standalone group cards with
  `overflow-hidden rounded-lg border border-card-border`, no own margin or background. Message rows
  flow inside cards, laid out by the sections and rows themselves.
- `INPUT` / `OUTPUT` each show a title row using
  `h-8 px-3 bg-surface text-ui-sm font-mono uppercase text-foreground`, distinct from the
  `bg-surface/30` zebra. Titles carry no left color line or decorative icon, no `mt-*` / `mb-*`;
  both use the same neutral style, expressing request/response grouping only, not joining the
  zebra.
- No gap between adjacent message rows; between a section title and the first row, and between
  rows, standalone `col-span-full h-px bg-border/50` divider elements are inserted — never the
  message row's own border.
- The whole list shares one outer `max-content minmax(0, 1fr) auto` three-column grid; every call
  card, content area, input area, output area and message row inherits the same "role / content /
  actions" tracks via `subgrid`, so the first column is sized by the longest localized role label
  across the whole list, like a table. The grid uses `gap-x-2`, tightening content-to-chevron
  spacing to 8px; role labels add `pr-1`, keeping the visual role-to-content gap at 12px. Different
  call cards or input/assistant outputs must not compute role column widths separately, nor use a
  fixed-width role column that leaves large gaps after short zh-CN labels. The content column must
  stay `minmax(0, 1fr)` so long summaries still shrink and truncate.
- The shared action column is sized by the Chevron alone; it uses `-ml-1 mr-1` to tighten the
  visible content-or-tool-ID-pill-to-chevron gap from 8px to 4px without changing role/content
  spacing. The expanded copy button uses `absolute right-full mr-1` left of the Chevron, never
  widening the shared action column. Expanded metadata uses `mr-7` to reserve exactly
  "24px button + 4px gap" so the copy icon never covers the datetime; collapsed rows keep no such
  reserve. Every row's Chevron aligns to the same right edge — no empty slot right of the arrow.
- Summary-row action columns keep only the Chevron; expanding or collapsing any row must not make
  other rows' summaries, labels or chevrons shift horizontally.
- The `tool` input role displays as English `Tool result` / zh-CN "工具结果", clearly distinct from
  `Tool call` / "工具调用" in assistant output.
- Zh-CN role copy uses full semantic names: system "系统提示词", user "用户消息", assistant plain
  text "助手消息" — not the short "系统 / 用户 / 助手" labels that confuse with groups or product
  identity.
- The tool name pill has no max width and never truncates — it must display fully; the displayed
  tool call ID drops the leading `call_` prefix while the underlying data keeps the raw ID. Under
  space pressure the summary compresses first; the tool call ID pill may still truncate to protect
  narrow sidebars and mobile web.
- Collapsed Tool Result and Tool Call rows show a content-width direction label before the summary:
  `OUTPUT` ("输出") for Tool Result, `INPUT` ("输入") for Tool Call. The label uses `text-ui-sm`
  and the primary text color, sized to its text; then a standard-compact-spaced right-arrow icon in
  the tertiary text color; then the secondary-level summary. Never use fixed widths that create
  gaps between short zh-CN labels and the arrow. On expand, the summary and arrow hide together;
  the direction label stays and is not repeated in the body.
- Section titles, role labels, message previews, bodies, reasoning and tool content in the content
  area uniformly use `text-ui-sm`; the call summary header's index, pills and metadata keep
  `text-ui-xs`.
- Budget-trimmed segments (with `truncated`) show a trailing secondary line "源数据已截断，原始 N
  字节" (`modelTrajectory.truncatedAtSource`, N = `originalBytes`) with the
  `data-trajectory-truncated` attribute. This notice does not replace "show all": trimming happened
  at Host projection; expanding cannot recover the omitted middle.
- A Tool Result output of `{ type: "error-text", value: string }` must use `value` directly in both
  collapsed summary and expanded body — never serialize the error wrapper to JSON. The collapsed
  summary still folds consecutive whitespace; the expanded body keeps the error text's original
  newlines.
- When a Tool Result output or Tool Call input is `error-text`, the collapsed row shows
  `CircleAlertIcon` before INPUT / OUTPUT; the icon and direction label use destructive error
  color; ordinary tool payloads show no such state. The expanded error payload uses a borderless
  `rounded-lg bg-destructive/10` error container with destructive text; tool name, call ID, copy
  and overflow behaviors are unchanged. The normalized model-io top-level `isError` / `is_error`
  of string TOOL messages must restore to `{ type: "error-text", value: content }` — the service
  layer mapping must never drop the error state.
- system, user and tool share one full-width transparent message layout. The summary reads only the
  first **1,024 characters** of the projected text (per segment, independently computed), avoiding
  normalizing whole segments per render; a collapsed system summary takes its first non-empty
  line; user, plain assistant and reasoning collapsed summaries fold consecutive whitespace to a
  single space; a collapsed tool summary takes the same prefix of `tool-result.output` folded to
  one line — never substituting the tool name. A search hit beyond the summary prefix is not
  highlighted in the collapsed summary; once the hit row is revealed and expanded, in-body hits
  highlight normally. Every summary truncates within one line with a Chevron at the far right; the
  tool summary adds two standalone outline pills for `toolName` and `toolCallId`, hiding a pill
  when its field is missing. On expand, the header hides the summary, direction arrow, `toolName`
  and `toolCallId` pills, keeps the direction label, and shows "本次调用耗时 · 完整日期时间"; the
  tool name and ID pills move to the first line of the expanded content, with the payload starting
  on the next line. The full ISO datetime is preserved via a tooltip. This shows the model-io
  call-level `durationMs` / `startedAt`, not a single message's own duration or time. The Chevron
  button container is `size-5`, its icon `size-3`. Expanded rows show an `icon-sm ghost` copy
  button left of the Chevron, hidden when collapsed; copy copies the projected data (already
  segment-trimmed text, without the omitted middle); copying computes on click, never during
  render. In the expanded body, system / user show the full projected message and tools show the
  full projected payload; trimmed segments carry the `data-trajectory-truncated` notice and no
  repeated "工具结果/工具调用" title. Bodies render as plain content inside the container — no card
  background, rounding or margin; default `max-h-64 overflow-hidden` with no internal scrolling.
  Content over 256px gains a 72px bottom CSS mask fade and a floating `sm outline` "展开" pill
  horizontally centered at `bottom-3 left-1/2`; the pill uses `bg-surface/90` as the no-
  backdrop-filter fallback, upgrading to a `bg-surface/70 backdrop-blur-md` glass background when
  supported. Overflow bodies use `pb-14` to keep the last line clear of the floating button;
  without overflow they use `pb-2`. Expanding removes the max height and mask and flips the
  centered button to "收起"; expanding affects only that message, and collapsing restores the
  height limit.
- Assistant output no longer uses an `ASSISTANT` group title or nested surface cards. Reasoning,
  assistant messages and each assistant tool call render as standalone shared grid message rows
  with the same single-line summary, whole-row expansion, overflow truncation and floating-pill
  actions as system / user / tool result. A collapsed assistant tool call serializes
  `toolCall.input` into a compact one-line summary with two standalone outline pills for tool name
  and call ID, avoiding duplicate tool-name labels; expanded, it shows the full formatted input in
  a transparent, wrapping body style — no repeated "输入" title, tool-call title, background card
  or rounding.
- The collapsed rows of `INPUT > TOOL` and `OUTPUT > ASSISTANT > Tool` already carry the tool name
  (assistant tools also the ID), so the expanded area must not re-render a
  "工具结果/工具调用 + name + ID" title — only the output or input payload card remains.
- The Chevron right of a message summary uses `ml-1.5`, a 6px control gap from the tool tag or
  preview.
- The expanded card wrapper uses `p-3` — a uniform 12px on all sides.
- With the left vertical line removed, titles, message rows and expanded bodies regain 12px left
  padding: titles and bodies use `px-3`, message trigger areas use `pl-3` with the standalone
  action column controlling the right side; expanded bodies use `pt-0 pb-14` or `pt-0 pb-2` by
  overflow state. Expanded body text and tool payloads run `trim()` at display time only,
  stripping leading/trailing whitespace while keeping inner newlines; copy still uses the
  untrimmed raw data.
- Message role rows (system / user / assistant) uniformly use `min-h-8` (32px minimum); the role
  label and content center vertically on the first line; expanded or multi-line content grows
  naturally.
- Colors strictly follow `DESIGN.md` semantic tokens: main background `background`, expanded state
  `selected`, content layers `surface` / `card`, dividers `border` / `card-border`; `destructive`
  only for real error states.
- A call-level `record.error` renders after its call card's INPUT / OUTPUT in a `rounded-lg`
  borderless translucent `bg-destructive/10` error block; `CircleAlertIcon`
  (`size-4 text-destructive`) on the left aligned with the title's first line; error name and
  message in `text-destructive`; the stack in the same hue, de-emphasized. The error block never
  uses an outline or plain surface background.
- Roles are distinguished mainly by compact text labels — no large-area background colors per
  system / user / assistant / tool role.
- Message rows show no left vertical line; SYSTEM uses the secondary text `text-foreground-subtle`,
  USER `--color-trajectory-user` blue, ASSISTANT `--color-trajectory-assistant` teal, reasoning
  `--color-trajectory-reasoning` purple, TOOL CALL `--color-trajectory-tool-call` amber, TOOL
  RESULT `--color-trajectory-tool-result` cyan-blue. Colored role labels uniformly use their
  dedicated token's `/80`; the five dedicated tokens must each define Light, Dark, Zai Light and
  Zai Dark values — never borrow success, warning or destructive state colors. Reasoning reuses
  USER's row summary, click-expand, body height limit, copy and "展开/收起" structure — no separate
  card.
- All input and output rows inside one call card share a continuous index for zebra striping; the
  count does not reset between Input and Assistant output. The first row stays transparent;
  alternating rows use `bg-surface/30`; expanded content inherits its row's background; the call
  header and dividers do not alternate; rows add no hover background or color transition.
- Narrow sidebars and mobile web keep the single-column structure; technical payloads must wrap
  and never widen the panel; floating pill actions may stay compact at narrow widths.

## Long-list virtualization

### Content search

- The header action area, left of custom expansion, has a search button; clicking shows an inline
  search bar under the call stats: input, `current/total`, previous, next and close. Opening
  focuses the input; Enter forward, Shift+Enter back, Escape close — never overriding the app
  global `Cmd/Ctrl+F`.
- Search indexes only the currently loaded trajectory projection in the UI — no new server API,
  RPC, protocol field or persistence. Scope: system, user, reasoning, assistant bodies, tool call
  input, tool result output, tool names and the visible ID without the `call_` prefix; time,
  tokens, models and role labels are excluded. Matching is case-insensitive literal search;
  consecutive whitespace in the query and body collapses to a single space, keeping original
  offsets for highlighting.
- Mounted hits use `--color-find-highlight`; the current hit uses `--color-find-highlight-active`.
  If the current hit is in a collapsed message or height-limited body, the search reveal state must
  temporarily force-expand that message and its full body; this state never writes user expansion
  overrides; moving to another result, clearing or closing search restores the pre-search state,
  and manually expanded content stays expanded.
- Virtual-list location is two-phase: first locate and mount the Call via the virtualizer by
  `callIndex`, then locate the exact text Range next frame after search reveal expands and
  re-measures. Location requests dedupe on a stable match key, avoiding duplicate scrolls from
  ResizeObserver or virtual row remounts. Previous/next wrap at the ends; a truncated trajectory
  searches only loaded records and keeps the existing truncation notice.

- The trajectory virtualizes by call card (one model call) with dynamic heights. A card's INPUT /
  OUTPUT sections are not separately virtualized, but input message rows obey the row-window rules
  below: rows outside the window are not mounted. The scroll container remains the panel's native
  `overflow-y-auto`.
- Virtual items measure real DOM heights; expansion, collapse or "show all" height changes must
  re-measure. Keep a small overscan above and below to avoid white flashes on fast scroll.
- The outer virtual canvas keeps the shared three-column grid. Invisible zero-height role-label
  measurement rows participate in the first column's `max-content` sizing so that changes in
  mounted virtual items never make the SYSTEM / USER / ASSISTANT / TOOL content column jump
  horizontally.
- A message's expansion state must live outside its call card, keyed by stable message key;
  unmounting and remounting a virtual item restores its prior state. Batch expand commands still
  supersede older per-row state via the shared command version; no per-row effect re-sync.

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

## Row window for oversized input cards

A first call's input can hold thousands of messages (the full starting context). Mounting them all
can reach tens of thousands of DOM nodes in one card and block the main thread for seconds in a
single task; batch "expand all" would re-trigger that cost. So input message rows are windowed per
card:

- Threshold `TRAJECTORY_COLLAPSED_BY_DEFAULT_ROWS = 40`: cards with ≤ 40 input messages default
  expanded, as above; cards over 40 default collapsed. The threshold only sets the default — batch
  commands and per-row overrides keep their semantics.
- Page size `TRAJECTORY_ROW_PAGE_SIZE = 40`: a card mounts input rows `[0, limit)`, `limit`
  starting at 40; cards under one page show no window controls.
- Gap and "show next" control: the gap between the page and later rows shows one button
  "显示接下来 N 条（共 M 条）" (`data-trajectory-rows-more`), where `N = min(40, gap rows)`.
  Clicking sets `limit = page end + N`, so each click mounts exactly the N rows in the copy. The
  control expands no rows.
- The `limit` state owner is `TrajectoryExpansionRegistry.rowLimits` (keyed by the call card's
  stable key), alongside per-row expansion state outside the card, surviving virtual unmount and
  remount. With no registry (standalone test renders) it degrades to card-local state.
- Search reveal: when `searchRevealKey` points at input message `i` of this card
  (`<callKey>:input:<i>`) and `i >= limit`, rendering derives a search window
  `[max(limit, i - 10), min(M, i + 11))` (radius `TRAJECTORY_REVEAL_RADIUS = 10`). The window is
  render-derived only — never written to the registry and never changing `limit`; it disappears
  when search ends. The gap before the window shows the "show next" control (as above); the gap
  after the window shows the text "N rows hidden" (`data-trajectory-rows-hidden`) with no control
  (see "Known boundaries"). When `i < limit`, the hit is already in-page and no window is created.
  One hit therefore mounts at most `limit + 21` rows — e.g. hit #900 of 1,000 inputs mounts 61
  rows.
- Batch commands mount no rows outside the window: rows outside derive their expanded state from
  the current command version at mount, so "expand all" mounts only the current page and search
  window.

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

## Known boundaries (pending user decision)

- Input deltas only help views that understand `inputDeltaOf`. Old views render delta records by
  `request.messages` alone, showing only new messages without earlier context — no crash, but
  incomplete. Host and view ship in the same app version; a mobile remote page on an old Host gets
  full records and is unaffected.
- The disk model-io format is unchanged: readers follow the writer's format (full context or writer
  delta). The measured file `sess_1293b371` (22.6 MB) has all 5 records as full context; this
  round's gains come from the projection layer (RPC size); disk size and the write path are out of
  scope. Files with only writer deltas still need measuring.
  Measurement (2026-10-22, real file `sess_1293b371`, 5 main calls, default limit): projected JSON
  dropped from 5,502,243 to 1,122,454 bytes (-79.6%). The first record is a full 1,097,942 bytes;
  the other four deltas are 9,695 / 4,351 / 4,720 / 5,535 bytes; read takes ~64 ms.
- Deltas take a base only from the nearest main record inside the window. With a very small
  `limit` (1 or 2) or a window cut between two main calls, the first main call is necessarily full
  and the gains shrink.
- Subagent records are currently sent full (not delta-eligible): their preceding main base usually
  does not prefix-match. Subagent deltas would need a separately defined subagent base.
- CPU cost of the delta decision: each main call's projected messages serialize once, the same
  order as full projection; no extra disk reads.
- The gap after the search window has no "show next" control. Providing one needs a second state
  (window anchor) or extending the prefix to the window end (the "one hit mounts ~1000 rows"
  problem). Keeping `limit` the single owner, only the row count is shown for now; continuing to
  browse past the window needs a user decision on which state to introduce.
- The segment budget does not bound `error.stack`; a single error's stack is far below budget.

## Multi-platform

- Disk reading is owned by the service layer: desktop reads local `~/.zcode/cli`; mobile remote
  reads the same directory on the remote host via RPC.
- The entry works on desktop and mobile web (not hidden on mobile); an empty state is shown when
  there are no records.
