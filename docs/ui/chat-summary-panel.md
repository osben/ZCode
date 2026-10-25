# Chat Status Panel

> Current state: this document describes the current product semantics and projection boundary of the V4 `ConversationStatusPanel`.

The chat status panel is the resident status panel at the top right of the V4 conversation pane. It gathers Git tools, goal progress, the terminal plan catalog, todo and background running resources. `packages/ui/src/v4/ConversationStatusPanel.tsx` hosts both the collapsed and expanded content in one shell.

## Display rules

- The status panel shows when the current V4 pane is bound to a session and has displayable content. Without a user override, the named `conversation` container query decides the form: below `1280px` of container width it shows mini and the conversation does not shift; from `1280px` it expands the full panel and shifts the message column and Composer left by `168px`. The always-expanded mode reuses the same `@min-[1280px]` shift rule, with no shift in a narrow container; the always-collapsed mode never shifts. The `max-w-6xl` wide layout of Conversation is also enabled uniformly from `1280px`. This decision must not read `window.innerWidth` or register a `ResizeObserver`; split-screen and right-pane changes are driven uniformly by CSS container size.
- The new-task / draft state does not show the status panel, so the Git tools block does not crowd the empty state and the input entry.
- An existing task shows the Git tools block only when the current worktree has `added + removed > 0`; a clean repo does not mount the status panel just because it "is a Git repository".
- An existing task with nothing displayable from Git, goal, todo and running does not mount the status panel and reserves no inline offset for the full panel. A finished subagent alone does not mount the mini/status panel; catalog tabs the user already opened are unaffected.
- When the full status panel uses the inline layout, the `ChatViewEmptyState` component root reuses `CHAT_VIEW_SUMMARY_PANEL_INLINE_OFFSET_CLASS_NAME` and keeps the transform transition, staying horizontally aligned with the message column and input area; the outer empty region and the task restore loading placeholder share the centered layout and do not apply this offset.
- The workspace header has no status panel toggle; the expanded state collapses through the button at the panel's top right, and the collapsed state expands by clicking the summary row.
- The collapsed summary row shows only one summary and does not join the main status and live activity in one capsule. **A running workflow comes first**: whenever a pending / running workflow run exists, the capsule shows the first one (start order): name, status light, phase word and `+n` (rules in `docs/dynamic-workflow/presentation.md`, "Other places a run appears"). It states a name and position, not a count, so it does not duplicate the composer's background count. Clicking the workflow capsule expands the panel and opens the "workflow" section at the same time: what you see after expanding must not be less than the capsule. Without a running workflow the main status priority follows Progress current, Goal active, Git, Goal done, Progress finish, Progress fallback: whenever any of them is visible the capsule shows only that main status; only with no main status at all are running resources used as the fallback summary. Progress current uses an arrow-right icon and the current todo title; Goal active uses a target icon and the goal title; Git only when `added + removed > 0`, using the Git change icon and `Changes +added -removed / 更改 +added -removed`, with added / removed in the diff semantic colors; Goal done uses a target/goal icon and the goal title; Progress finish uses a circle-check-big icon and the title of the last completed todo; Progress fallback uses a list icon and `Progress completed/total` / `进程 completed/total`. In the live fallback Bash is counted from `backgroundWorks` and Subagent from the unified `session/subagents.running`; with only Bash it shows a terminal icon, with only Subagent a Bot icon, with both an Activity icon, and the text shows only the running total with no running timer. A finished subagent does not enter mini. All text in the collapsed summary row uses the ordinary UI font, never `font-mono`.
- The status panel shell is always the same `aside`. The collapsed visual size, height and padding follow the original summary capsule, but the shell radius and the expanded state both use `rounded-2xl`. The collapsed capsule stays in the DOM; the expanded state hides it only through `opacity` / `visibility` / `pointer-events`. The collapsed shell width is decided by CSS: `w-max`, capped at `max-w-[min(20rem,calc(100cqw-2rem))]`, i.e. it measures the conversation container (`@container/conversation`) and not the window. The summary width is no longer measured in JS into a CSS variable: that measurement existed to interpolate-animate the width, the shell no longer transitions width, and the measured value lags the content by one render while its cap was computed from `100vw`, either of which could put text outside the capsule. The expanded state keeps the original full-panel width `w-80` (same container cap expression), with the height cap unified as `min(64dvh, 32rem)` so a desktop breakpoint's fixed `36rem` does not override the viewport-relative constraint. `p-2` sits on the expanded content container so it does not affect the collapsed capsule size. The expand/collapse animation is on the shell and transitions max height, radius, padding, background and shadow; content only does a light opacity switch, so a separate capsule and panel unmounting do not break the animation.
- The status panel's outer position relative to the conversation pane is fixed at `pt-4 right-4` (16px top and right); auto, always-expanded and mini share this margin and it does not drop to 12px on narrow screens.
- The collapsed capsule follows the summary content width, with a single summary content height of `h-8` and a width cap equal to the shell's container cap; the inner summary uses `truncate` so a long goal / todo / workflow title does not stretch the layout.
- On hover / focus of the collapsed summary row the left status icon switches to `maximize-2`, hinting that a click expands the full status panel.
- The user clicking the collapse button at the panel's top right or the collapsed summary row writes a manual preference into the current workspace shell: `panel` means always expanded, `mini` always collapsed, `null` automatic CSS response. In automatic mode the expanded content and the mini summary stay in one shell and are shown mutually exclusively by `@container/conversation`; React does not switch the variant by width. The more menu at the expanded top right shows only an "auto" option, which restores the preference to `null`; "always expanded / always collapsed" are no longer menu options, but the existing collapse/expand buttons and the internal `panel` / `mini` logic remain. The preference lives only in the current renderer's workspace shell and is not written to task, session, relay or main process, so it does not affect the realtime chain semantics of desktop continuous and web remote replayable.

## Sections

All section titles use normal weight and no uppercase transform, so status panel titles do not over-claim attention in the compact layout. Git Tools, Goal, plan, process, terminal and agents stack in actual render order; the second and later sections get a `border-border` divider on top, and a missing section takes no space and shows no extra divider. Except Git Tools with fixed content, Goal, plan, process, terminal and agents all get a scroll viewport uniformly from the `StatusSection` section type, and callers must not decide on their own whether to limit height; titles are fixed outside their scroll viewports. Goal, plan, terminal and agents expanded content take at most `12rem`; the process section takes at most `20rem`, to hold 6 two-line Todos. Beyond its cap only that section's content scrolls. This constraint is independent of section combination: even if only one section's content exceeds the limit while other short sections exist, the long section keeps its own cap and scroll position. When the titles and capped content of several expanded sections still total more than the shell cap, the expanded content container provides a fallback vertical scroll for the whole panel; directly clipping later sections is forbidden. The agents section shows the running items of the unified projection; after them a single line `已结束 · N / Ended · N` opens or reuses the Subagent catalog and no terminal item is previewed in the summary.

Status panel font sizes use UI tokens: the Goal ordinal dot uses `text-ui-xs`; section titles, Git rows, Goal body, plan, process, the stop button, terminal and agents body and metadata, finished rows and the collapsed summary use `text-ui-base`; only the summary on the right of section titles, Git change counts and Goal progress use `text-ui-sm`.

### Git Tools

Git Tools shows workspace-level Git state and does not depend on whether the current task is running:

- When the current workspace is not a Git repository, or the worktree `added` and `removed` are both 0, the Git Tools section is not shown and the collapsed summary row shows no Git change metric either.
- The Git Tools title supports collapse / expand, expanded by default; the left title and arrow are clickable, and when collapsed the far right of the title row shows the `+added -removed` change summary.
- Changes: shows added / removed line counts of the current worktree. Clicking opens the existing Git review pane and prefers a worktree source that has content.
- Branch: reuses `GitBranchSwitcher`, shown as a whole-row button in the same style as Changes; inside the status panel the branch menu pops out to the left, the trigger arrow follows the branch text, and it continues through the existing Git service and branch-switch blocking handling.
- Commit / Push / Create branch: reuses `GitActionMenu`, where the menu itself shows the primary action name by current repo state; inside the status panel the trigger keeps the two-segment interaction of primary action and more menu, clicking the parent row triggers the primary action; the more entry is a `...` icon in ordinary icon-button style right after the action text, with the default text color at secondary level, and clicking it only opens the menu; on parent row hover the `...` button shows a `surface` background. When nothing can be committed / pushed the whole-row button shows `Create branch`.

Git Tools does not issue Git RPC directly. Git data comes from the `gitSummary` and worktree dataset summary already maintained by `useGitRepository`.

### Last turn 与 Context

规格见 `specs/status-panel-context-and-last-turn.md`。两个区块只读 v4 投影，默认收起，且不参与 `hasContent`：它们不会单独挂载 status panel、不增加 inline offset，也不进入 mini 胶囊。Last turn 紧跟 Git Tools，展示最近一个有文件变更的轮次（与 Review「Last turn」来源同一选择规则），展开时才读取 `fileChanges` 明细；Context 位于所有区块最后，展示 `snapshot.usage` 的上下文占用、自动压缩阈值、来源构成和累计 token。两个区块正文中的次级元信息（目录、写入次数、图例、`used / max` 与累计 token 行）使用 `text-ui-sm`，属于上文字号约束的补充例外。

### Goal

Goal shows goal/prompt progress and no longer carries todo details:

- The V4 goal summary reads only the authoritative `goal` state in the CLI `ProductProjection`. The projection must keep the current target's `targetId`, `summaryTitle`, `timeUsedSeconds`, `activeRunStartedAtMs`, per-iteration todos and the verifier's `reason/nextAction`; live delta and cold snapshot use the same projection structure, and the renderer does not persist goal state itself.
- When the goal is active the title's right side shows accumulated time and an independent `pauseGoal`; when paused it shows frozen time and a triangular `resumeGoal`; when verified it shows frozen time and a green circle check. pause/resume are target control commands, do not reuse the generic stop, and do not change the stop/hold semantics of the queue.
- The Goal title supports collapse / expand, expanded by default; the left title and arrow are clickable, and the right shows only the goal-level `elapsed` with no goal/token usage; when collapsed it appends `· status icon`, for example `1m 42s · <icon>`. The collapsed status icon of active / paused remains a clickable pause / resume icon button, with tooltip and aria-label still using localized text; complete uses a completion icon. The status summary and goal-level metrics use ordinary auxiliary text style with no capsule background. When collapsed the prompt list is hidden.
- The Goal summary consumes only the verifier timeline, goal iteration todo and goal stats of the current `target.targetID`. After switching to a new goal, the old target's verifier stays in the chat timeline but must not keep driving the top-right summary's title, iteration number or elapsed time.
- Row titles come from the goal iteration title: iteration 1 prefers `target.summaryTitle` by default; after replacing with a new goal, iteration 1 prefers the current `target.objective`, and the old target's `summaryTitle` or the session title fallback must not stay as the new target title; later iteration titles still prefer the previous verifier's `nextAction` of the current target.
- Each prompt item uses a compact horizontal layout: a status icon on the left, the prompt title of at most three lines on the right, and the `completed/total` progress fixed at the top right of the title area, for example `0/5`; the prompt item neither repeats goal-level elapsed nor carries the pause / resume button, to avoid expressing goal-level information as iteration-level information.
- Prompt items sort completed first: completed iterations show above incomplete / running ones; within the same completion state the original iteration order is kept.
- An incomplete / in-progress prompt item uses the goal icon on the left, so for example `prompt... 3/5` still reads as the current goal in progress; a completed prompt item shows the iteration ordinal on the left, wrapped in a 10px green text + green outlined circle, so completed history is not misread as in progress. pause / resume appears only as a title-row control button.
- Every iteration must keep a visible action and state. Iteration 1's action prefers `summaryTitle`, else objective; later iterations prefer the previous verifier's non-internal-fallback `nextAction`, and show a localized iteration title if missing. Whenever an iteration has todos it shows `completed/total`; only when the todos are non-empty and all done does the left change to a green numbered circle. An iteration without todos keeps the goal icon and iteration action and does not disappear because the projection data is sparse.
- The Goal prompt list is fully rendered and limited to a `12rem` scroll viewport inside the section; the title, accumulated time and pause / resume controls do not scroll with the list. Growth in iteration count must not directly clip the process, terminal or agents sections after Goal.
- A non-latest-running prompt item with iteration todos shows a light preview panel on the left on hover: the process title on top (styled like the Progress title's ordinary auxiliary text style but with no collapse control) and that iteration's todo list below, without repeating the prompt; the preview uses `rounded-xl`, with border and shadow aligned to the Branch menu, and position and distance following the Branch menu's left top alignment with a 4px gap; since todo content can be very long the preview has a max height, the title is fixed and the todo list area scrolls; the latest running prompt item shows no hover preview so it does not cover the current control.

The verifier's `reason` stays carried by the conversation timeline; the top-right Goal section does not append an extra gray verification summary card after the iteration action. Todo details all go into the process section.

Goal timing and command chain:

```text
TargetChanged / TodoWrite / verifier
                 |
                 v
CLI ProductProjection (persistent facts + per-iteration state)
                 |
       snapshot / ordered delta
                 |
                 v
SessionDataLayer -> UI goal summary
                         |
                         +-- active: base + (now - startedAt) display refresh only
                         +-- paused/verified: base frozen

UI pauseGoal/resumeGoal -> Host -> CLI command handler -> target state event
```

### Plan

The plan section is the terminal `ExitPlanMode` catalog of the current effective branch of the conversation; it is not the same as the todo in the process section:

- The list keeps the terminal plans of the current effective branch in full, in descending `rowId`; clicking an entry opens the matching Side Pane by the stable parent session + tool call identity.
- The plan title is fixed outside the scroll viewport; when plan entries exceed `12rem` only the plan list scrolls, it must not stretch the whole status panel, and it must not lose its height cap because process, terminal or agents appear before or after it.
- Plan, process, terminal and agents may all exist; each section keeps its own `scrollTop`, and the outer fallback scroll only makes section titles reachable and does not replace the internal scroll of any long section.

### Process

The process section shows todos uniformly:

- With goal iteration todos, only the latest todo list of the current goal is shown, no longer grouped by goal iteration; the list style reuses ordinary todo. When the current goal iteration has no todo yet, the old todo of the previous iteration is not shown as a fallback.
- Without a current goal todo, the live `plan` is shown; when that is missing too, the todos with `source === "session"` in `todoGroups` are shown.
- Completed items are kept, de-emphasized by style; pending / in_progress / completed keep using the existing status icons.
- The process list strictly keeps the authoritative original order of the current todo snapshot (`plan.items`); a status change only updates that item's icon and de-emphasis style and must not move completed items to the end.
- With no more than 6 todos, all are shown in snapshot order. With more than 6, a compact window applies: it locates `in_progress` first, else the first incomplete item, else the end when all are done; by default 3 consecutive items are shown, backfilling from the front when near the end. Items before and after the window collapse into position buckets: a front bucket entirely completed shows "已完成 n 项" (n completed), else "前面 n 项" (n earlier); a back bucket entirely pending shows "待处理 n 项" (n pending), else "后面 n 项" (n later); falsely reporting status by position slice is forbidden.
- The "已完成 n 项 / 待处理 n 项" entry uses the main UI body size `text-ui-base`. On desktop hover or keyboard focus it opens a light preview 4px to the left of the Status Panel, modeled on the Goal item hover card, and no longer inserts details into the panel document flow; without hover input a click on the entry opens the same card. The card and trigger can be moved between safely, and its width, radius, border, shadow and `120ms / 80ms` open/close delays follow the Goal preview; when content is too long only the list inside the card scrolls.
- Each Todo text shows at most two lines, with an ellipsis at the end of the second line when exceeded; this limit applies only to visual rendering, the full content stays in the snapshot and DOM text, and model data must not be truncated.
- When a Todo's id, content or status change forms a new snapshot, an open hidden-group preview closes and the focus window is recomputed; this state belongs to the renderer only and is not written to session, store or protocol.
- The process section title row is collapsible, with only the left title and arrow clickable; the far right of the title row always shows `completed/total`; when collapsed it appends `· status icon` in the auxiliary-info style of the Goal title's right side, for example `3/4 · <icon>`, and the right arrow likewise shows only on hover / focus of the title content area.
- The process model must keep the full todo snapshot; the renderer applies only the user-reversible focus window above and must not drop items in the projection layer. Section content takes at most `20rem` and must hold 6 Todos of two lines each; longer text or expanded groups scroll inside the process section, with the title and `completed/total` always fixed and visible.

Goal todos and ordinary todos are both `ZCodePlanStep[]`; the iteration semantics of a goal todo apply only to Goal prompt rows and no longer affect the list structure of the process section.

### Terminal and agents

Background running resources are split by kind into two independent sections and no longer share a Running list: `kind === "bash"` goes to "终端" (terminal), `kind === "subagent"` goes to "智能体" (agents). The two sections collapse, count and compute the longest running time independently; a type with zero takes no space.

- The Composer toolbar offers a single background-task entry after "add menu -> mode selection"; the entry consumes only `backgroundWorks` with `status === "running"` in the current session snapshot and does not aggregate other tasks, sessions or workspaces. A wide input area shows, in the same button, a terminal icon + Bash count and a Bot icon + Subagent count, with a zero-count type taking no space; at a Composer container width `<= 480px` they merge into an Activity icon + running total. The hover tooltip must also follow the non-zero types: Bash only is "运行中的终端" (running terminals), Subagent only is "打开运行中的智能体" (open running agents), mixed is "打开运行中的终端与智能体"; the accessible name keeps the full counts of Bash, Subagent and total. `resultPending`, `failed`, `cancelled` and finished tasks are not counted, and the entry disappears at once when the last running task closes.
- Clicking the Composer background entry must switch the effective panel preference to `panel` and expand the currently non-empty "终端" and "智能体" sections, so the user sees all background details in one action. The two sections can later be collapsed manually and separately; on session switch both reset, and when a type's running count drops to zero only the matching section resets. If the current pane has no workspace shell preference callback, a pane-local variant fallback is used, so the entry is never a dead button.
- The current stage has removed the JavaScript inline/overlay decision for narrow screens; clicking the entry always switches to the full `panel`. The later CSS layout must restore the narrow-container overlay without letting the Composer overflow horizontally; mobile `/remote` still forbids opening the Subagent side pane from an agents row.
- The "终端" and "智能体" titles both support collapse / expand and default to collapsed. The left title and arrow are clickable; when expanded the right shows the localized background running count of that type, and when collapsed the right shows the longest running time and count of that type, not the accumulated time of several tasks.
- "终端" and "智能体" each fully render the current running list and each scroll within their own `12rem` height cap; the two sections do not share scroll position, and the title, count and collapse control are fixed outside the scroll viewport.
- Each running item uses a two-line layout modeled on the Goal prompt item: a background subagent uses a bot icon, bash/process a terminal icon; the first line on the right shows only the authoritative `title` and must not concatenate the internal `bash/subagent` kind into the user-visible title; the second line shows the localized "已运行 elapsed" (running for elapsed) and a stop button with short text.
- When a background subagent also has a `childSessionId` and the current UI has injected the ability to open a subagent right-side tab, the whole running item is an accessible session entry: click or Enter/Space must reuse the `parentSessionId + childSessionId` opening logic of the Agent tool summary row, creating or activating the same complete read-only child session tab on the right. No open state is kept inside the Status panel and no second child session is created; repeated activation is still de-duplicated by the workspace side pane's stable tab ID.
- A newly started background subagent must write the `childSessionId` from the Agent launch output / runtime task snapshot as is into `BackgroundTaskStarted/Updated/Completed` and project it to `backgroundWorks`; `workId` is only for background task control and cannot replace the child session identity. Only historical events lacking that field may degrade to an item that cannot be drilled into.
- A bash/process item, a subagent without `childSessionId`, or a UI without the right-side tab ability stays an ordinary non-interactive item. The mobile `/remote` compact mode keeps using the existing entry gate and must not bypass the `web-remote-replayable` boundary just because the Status panel is visible.
- The stop button shows only when the projection declares `cancellable !== false`; the UI does not infer cancel ability from kind or local phase.
- Inside an openable subagent item the stop button stays an independent action; clicking or keyboard-activating it sends cancel only and must not bubble up to open the child session tab.
- Background items do not show `outputTail`, `stderrTail`, `stdoutTail`, a fallback command or PID helper text, so the background task list does not take visual priority over goal/todo in the compact panel.
- The list is sorted by running time descending. Task classification comes from the CLI `backgroundWorks[].kind`; the UI does not read `toolName` to classify again. Tool-alias compatibility for old events must be completed before CLI materialization.

Neither the terminal nor the agents section shows finished jobs; terminal states are still closed by the runtime snapshot.

```text
CLI backgroundWorks (current session snapshot)
        |
        +-- status=running --+--> Composer: Bash / Subagent counts
        |                    +--> kind=bash ----> Status Panel / terminal
        |                    `--> kind=subagent -> Status Panel / agents
        `-- terminal ----------------> not shown

Composer background trigger
        |
        +--> effective panel variant = panel
        +--> Bash count > 0 ----> terminal open = true
        `--> Subagent count > 0 -> agents open = true

Status capsule
        |
        +-- pending / running workflow --> show the first run: name · light · phase · +n
        +-- Goal / Todo / Git etc. main status --> show only the main status
        `-- no main status and running work --> show the live-activity fallback (terminal / agents counts)
```

## Compatibility

- Desktop local and web remote reuse the same UI projection; no agent protocol and no DB table is added.
- Opening Git review only operates the UI side pane and the selected source and does not change task stream, snapshot, queue or owner command semantics.
- At the current stage mobile remote control no longer switches the summary row automatically by width; the narrow-container overlay and not squeezing the main content are left for the CSS layout refactor to restore.
