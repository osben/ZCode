# V4 Chat Turn Render Units

## Goal

The v4 conversation protocol keeps the flat fact model `ConversationRow[]`; the UI does not treat each row as
a visible message but first derives visual turn render units, then renders the chat. The aim is to restore
the old ChatView reading semantics:

- The user query is above, and assistant work is below that user query.
- `turnHeader` is a protocol boundary and diagnostic fact, not a directly visible row.
- The assistant's reasoning, tool, explore, subagent, compact timeline and body all belong to the same turn
  of assistant work.
- Each initial input or successfully injected guided input starts an independent visual work segment; a
  normally completed segment folds by default to "已工作 N 秒" (Worked N seconds), while the currently
  running segment or one closed abnormally as interrupted / failed / error is forced open.
- A manual `/compact` is a maintenance command: no `/compact` user bubble is shown, only the compact
  timeline / assistant work activity.

## Structure

```text
ConversationSnapshot.rows.window
  |
  | buildConversationTurnRenderUnits(rows)
  v
ConversationTurnRenderUnit[]
  |
  +-- product turn identity / final action target
  +-- workSegments[]
      +-- trigger user input (original input first, guided input after)
      +-- history status + rows (each segment folds independently)
      +-- assistant text / following rows
  +-- tail boundary rows
```

`ConversationTurnRenderUnit` is a UI view model; it does not change v4 protocol facts and takes no part in
command target, snapshot recovery or replayable gap judgment.

## `/compact` Visibility

A manual `/compact` is triggered through the v4 `compact` command and is not a real user query:

```text
composer "/compact"
  -> command compact
  -> runtime compact turn
  -> compact timeline marker
  -> no visible user bubble
```

The runtime / projection must provide `inputVisibility="model-only"` or equivalent maintenance semantics so
the projection generates no visible `userInput` row. The UI view model must not sniff
`userInput.text === "/compact"`; for old history lacking the field, CLI transcript hydration normalizes it to
canonical visibility/origin/marker before sending down.

Turn actions consume `row.actions` row by row. Any assistant row with an action must render an action entry;
rules like `lastFlowRow`, array position inside a turn, or "last assistant" must not hide an action the CLI
already authorized.

## Assistant Work History

Each product turn is first split into visual work segments by guided `userInput`, then inside each segment by
the rules below. The split affects only the UI work area and creates no new `turnId` / `productTurnId`:

- `latestAssistantTextRow`: the turn's last `assistantText` row, shown as the latest body.
- `historyRows`: the reasoning, toolCall, subagent, compact marker and earlier assistantText rows before the
  latest assistant text.
- `tailRows`: boundary rows after the latest assistant text, e.g. fork notice / goal verification. They
  belong to the end of the turn but are not assistant work history, and "已工作 N 秒" must not fold them
  above the body.
- With no latest assistant text, all assistant rows are history rows and must be expanded, avoiding an empty
  assistant with only "已工作" and no content.
- The currently running segment must expand its history; when a new guide arrives, the previous segment
  closes and can fold independently, and the new segment uses its own expand state.
- The abnormal terminal states `completedInterrupted`, `failed`, `error` must force history expanded even if
  an interrupted / failed assistant partial exists; abnormal context cannot hide inside the "已工作" fold.
  `completedSuccess` keeps the default fold rule of normal completion.
- On cold restore, a transcript assistant message lacking a completion time means the app or Agent exited
  before the turn closed; hydration must normalize that orphan turn to `completedInterrupted` and must not
  forge `completedSuccess` that triggers the normal fold.
- The assistant work history status label distinguishes running, normal completion and interruption: running
  "工作中 N 秒", normal end "已工作 N 秒", and the last segment of `completedInterrupted` shows only
  "已停止"/`Stopped`, with no duration. A guide turn prefers the authoritative segment times in
  `turnHeader.workSegments`; only an ordinary/old snapshot without segment facts falls back to turn-level
  `activeMs`, `endedAt - startedAt` or the runtime UI clock.
- A normally completed product turn shows the turn's output tokens at the right of the status row of the
  **last** work segment (e.g. `Worked for 1m 5s ... 12.3K tokens`), in the same position as the running
  tok/s. The only fact is the CLI-projected `turnHeader.outputTokens` (main-chain ModelComplete total,
  excluding sub Agents); it is a turn-level value, earlier segments split off by guides do not show it, and
  it is not shown when `running`, `interrupted`, a highspeed turn, missing or 0; the UI makes no estimate.
- `turnHeader.executionKind` is the authoritative fact of whether an Agent work lifecycle exists. A
  `controlOnly` turn carries only a visible control input and produces no work status; an old snapshot
  lacking the field derives compatibly only when there is a real work row, running or active work time.
- A `lightBoundary` (e.g. model change) is separated from assistant work rows before computing work status;
  the boundary row itself cannot push a control-only query to "工作中/已工作".

```text
turn
  workSegment(initial)
    userInput(real user)
    historyStatus(running ? "工作中 11 秒" : "已工作 11 秒")
    historyRows(collapsed by default)
    assistantText
  workSegment(guide-1)
    userInput(guided)
    historyStatus(independent)
    assistantText
  tailRows(always after product-turn final assistant text)
```

State chain of the running label:

```text
ConversationSnapshot.rows
  -> buildConversationTurnRenderUnits(rows)           // no clock; rebuilt on rows/phase/pins/footer-expiry change
  -> applyConversationTurnLiveClock(units, nowMs)     // per tick; patches running turns only
  -> split leadingBoundaryRows / assistantWorkRows
  -> unit.workSegments[].workStatus { state, durationMs, outputTokens? } | undefined
       (outputTokens only on the last segment of a completed turn)
  -> each segment AssistantHistoryStatus
       state=running   => "工作中 N 秒"
       state=completed => "已工作 N 秒"
       state=interrupted => "已停止"
       undefined       => render no work status
```

The visible query of `/goal` and the real continuation are two product turns, but only the latter runs the
Agent:

```text
model A completed
  -> select model B
  -> /goal controlOnly turn
       leadingBoundary(modelChange) + userInput
       no session running / activeWorks / workStatus
  -> goalContinuation agent turn
       session running + one work segment status
```

## Virtual Scroll Boundary

The virtual scroll unit is the turn render unit, not the raw row, because: a user query and its assistant
work must not be split apart by `turnHeader` or tool rows; explore / agent / subagent tools already have
their own fold and aggregation semantics and virtual scroll must not enter these aggregates; and the history
collapsed state must be remembered by turn / assistant work key, not a transient row index.

### Render Performance Rules

- The running clock (`nowMs`) belongs only to turns still running: each-second ticks may re-render only live
  turns. Historical (non-running) turns receive no tick-varying `nowMs` or unit object, so the
  `ConversationTurnGroup` memo must take effect for them.
- The unit object identity of the same `turnId` stays unchanged as long as its `turnHeader`, `orderedRows`
  element references, session phase, last-turn position and plugin-card pin result are unchanged. An
  unchanged turn must not get a new object because of another turn's row increment or a tick.
- The Highspeed output footer's expiry depends on `nowMs`, but the builder is not recomputed per tick:
  `nextHighspeedExpiryMs` changes only when a card crosses its expiry boundary, and the timeline uses it as
  the builder's rebuild key; unchanged footer markers keep object identity.
- A running turn does not enter the unit cache. Its duration is patched by `applyConversationTurnLiveClock`
  on each tick: only the turn-level `workStatus` and the last work segment's `workStatus` are replaced, and
  all other fields, plus all non-running units, keep object identity.
- Acceptance: `packages/ui/test/v4ConversationTurnRenderUnits.test.ts` (unit reference stability; asserts
  `applyConversationTurnLiveClock` equals a clocked build per unit) and
  `packages/ui/test/v4ConversationTimelineHistoricTurnStability.test.ts` (3 historical turns + 1 running
  turn, advance 3 seconds: historical group render count unchanged; ticks do not call the builder again and
  the running turn's `durationMs` advances 3 seconds).

## Explore Aggregation and Reasoning Visibility

Explore is a UI aggregate view of assistant work and does not change the raw order of `ConversationRow[]`.
The aggregation boundary must match the reasoning visibility of the current message stream:

- With "Show thinking process" on, every reasoning is visible and a hard boundary of Explore; read-only
  tools on both sides of a reasoning aggregate separately.
- With it off, each turn's first reasoning still shows by the existing rule and keeps its boundary; the
  other hidden reasoning is transparent to Explore aggregation, and consecutive read-only tools before and
  after merge into one Explore.
- Transparency applies only to reasoning rows hidden by the reasoning switch. Visible assistant text,
  visible reasoning, non-exploration tools, subagents, timeline markers and the like still end the current
  Explore; raw row order is never reordered to widen aggregation.
- This is shared UI view-model semantics: Desktop, Web and mobile remote use the same result; the conversation
  snapshot and the message boundaries of `desktop-continuous` or `web-remote-replayable` are not modified.

```text
raw rows:       Explore(A) -> reasoning(2) -> Explore(B)
                                  |
showReasoning: on                visible
render items:   Explore(A) -> reasoning(2) -> Explore(B)

showReasoning: off               hidden / transparent
render items:   Explore(A + B)
```

## Reasoning Expand State

Whether a message-stream reasoning row shows is decided by the "Show thinking process" setting and the
per-turn first-reasoning rule; once shown, its content expand state follows a unified low-distraction
semantics:

- Streaming and complete reasoning both default to collapsed when they first appear, showing only the
  "正在思考" (Thinking) or "思考" trigger.
- Content expands only after the user clicks the trigger; later streaming chunks and the
  `streaming -> complete/interrupted` transition cannot override the user's manual expand/collapse choice.
- `isStreaming` still owns running copy and duration stats and is no longer implicitly equal to `open=true`.
- Expand state is shared UI-local interaction, not written to the conversation snapshot, and does not change
  Desktop continuous or Web remote replayable row order.

## Status Panel

The v4 chat top-right restores the old ChatView status panel semantics, without summary pills:

- Git tools: worktree change summary, branch, commit/push/create branch actions.
- Goal: current goal state.
- Todo / Plan: prefer v4 `plan.items`; if the v4 snapshot later adds `todoGroups`, restore goal iteration
  todo.
- Running: running bash/subagent in `backgroundWorks`.

The status panel is a UI derived layer and does not modify the conversation stream, queue, owner commands,
desktop continuous or mobile replayable semantics. Its form reuses the old ChatView summary-panel
interaction instead of being fixed open:

- The panel has only two renderable forms, `panel` / `mini`; `auto` is the resolution strategy when the user
  override is empty, not a third DOM.
- JavaScript no longer measures the chat container width or auto-switches `panel` / `mini`; with no user
  override it resolves to `panel` by default, and wide/narrow layout is later handled by CSS uniformly.
- The expanded top-right menu shows only "自动" (Auto), to set the override back to `null`; manual `panel` /
  `mini` is still written by the panel's collapse/expand button, and the "always expanded / always collapsed"
  menu options are no longer shown.
- `mini` is the collapsed form of the same floating shell, showing the single most important summary line:
  in-progress todo / goal, running, Git diff, completed goal or todo progress. As long as the goal section
  has content, `active`, `notSatisfied`, `paused`, `verifying` and `verified` must all keep a clickable goal
  summary row, leaving no empty shell; the title shares `summaryTitle.trim() || objective.trim()` with the
  expanded state and must not degrade to a long objective or empty text when collapsed.
- The expanded top keeps title, more menu and collapse button; inside it is divided into Git / Goal / Todo /
  Running sections, each independently foldable.
- The override is a workspace shell UI preference, passed along
  `WorkspaceShellLayout -> V4WorkspaceChatArea -> WorkbenchPane -> SessionPane`, and must not enter the v4
  conversation snapshot.

The main chat area goes through `WorkspaceShellLayout -> V4WorkspaceChatArea -> WorkbenchPane ->
SessionPane`. `V4WorkspaceChatArea` must put the workspace Git summary, dirty file count, worktree change
summary, active task change summary, summary panel variant and refresh handler that the shell already holds
into the primary pane's shell binding; `WorkbenchPane` passes workspace-level Git/status props to
`SessionPane` only for the shell workspace pane, with the active task change summary passed only to the
primary pane. A non-primary pane of another workspace must not reuse the current shell workspace's Git
summary, avoiding wrong repository state in a split.

Git Tools shows only when worktree `added + removed > 0`; a clean repository must not mount the status panel
merely for being a Git repository.

## Multi-Device Boundary

- Desktop `desktop-continuous` still uses the direct continuous main chain.
- Mobile `web-remote-replayable` still recovers by replayable snapshot / gap and does not pull the full
  history because of UI virtual scrolling.
- `workspaceIdentity?.trim() || workspacePath` is used only for workspace identity isolation; file display
  and command cwd still use `workspacePath`.
