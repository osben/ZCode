# Chat Status Panel

> **Implementation status (2026-11-09)**: The four capsule types are wired into the Composer and replace the top-right Status and the old background badge. The text below is the current spec. The browser candidate passed and a real-session smoke check was done on the desktop dev build. Real-phone checks, reconnection and promotion into CI were not run in this round.

## New status bar spec

### 1. Goal and scope

Move the content of the top-right Status of the conversation and the Composer background activity entry into one status bar above the input box. Errors, quota and initialization failures keep their original separate banners.

The fixed order is **Goal -> Todo -> Git changes -> Background activity**. Each type shows only when it has content and takes no space otherwise. When all are empty the status bar takes no height.

| Type                | Collapsed summary                                  | Expanded content                                                         |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Goal                | Short goal title and status                        | Full goal, accumulated time, existing iteration info, and pause / resume |
| Todo                | Status and completed / total count                 | Full authoritative Todo list                                             |
| Git changes         | File count, total added / removed lines            | List of uncommitted files in the workspace and Git actions               |
| Background activity | Avatars / icons, top-priority status and its count | Current running list of terminals, Subagents and Workflows               |

### 2. Layout and shared interaction

```text
Conversation content
Pending-send recovery hint (as needed)
Message queue (as needed)
Pending interaction (as needed, existing blocking rules)

             Detail popover of the current capsule
┌──────────────────────────────────────────────────────────┐
│ Content area: height-capped, long lists scroll inside    │
└──────────────────────────────────────────────────────────┘
[Goal] [Todo] [Git changes] [Background activity]
┌──────────────────────────────────────────────────────────────────┐
│ Project / branch (draft, as needed), edit hint, attachments, quotes │
│ Text editor                                                      │
│ Mode  Hook / MCP  Computer Use                            Send   │
└──────────────────────────────────────────────────────────────────┘
```

- The status bar follows the width of the Composer main column. It no longer sits at the top right of the conversation, and opening or closing a popover does not squeeze the messages or the input box. The wide-screen horizontal yield and top avoidance that belonged to the old Status are removed. The other conversation layout rules stay.
- Normal user message turns (including the first turn of a session) keep `pt-14` (56px). The first-turn spacing is no longer cleared through the Timeline's old status bar avoidance marker. Turns without a user bubble, such as workflow notifications, still use `pt-0` as before.
- The capsules are horizontally centered relative to the input box and stay on one line: no wrapping and no horizontal scroll. The rule for further shrinking on narrow screens is still to be confirmed. The four capsule types do not include error prompts.
- Clicking a capsule expands it upward. Clicking the same capsule, clicking outside, or pressing Escape closes it. Clicking another capsule switches the detail directly, and at most one is open at a time.
- The popover is centered on its capsule (`align="center"`), uses the default offset of the shared Popover (currently 4px) without overriding it, and uses the viewport collision handling of the shared Popover. All four popovers are 320px wide (`w-80`), with a maximum width of the viewport minus 24px. A popover is bounded by the current viewport width and height, long lists scroll inside, and the fixed title and main actions must not be clipped.
- The four detail panels drop the duplicated category title. The goal text, list item names and actions such as pause / resume stay.
- The four detail panels share the soft drop shadow `--shadow-status-panel` (small offset, wide spread, low opacity). The drop shadow stays when the panel itself has focus, and the global focus reset does not clear this container shadow.
- The Goal, Todo, Git changes and Background activity capsules share a `0.5px` border, the `border-input-border` border color, a `bg-input bg-clip-border` background (the default state matches the input box; the background extends under the border and does not inherit the padding-box clipping of the base button), the `--shadow-composer-soft` shadow shared with the input box, a compact rounded capsule shape and the existing border tokens. The detail popovers follow the container radius, layering and shadow rules in [DESIGN.md](../../DESIGN.md), and the capsule radius and border width are not copied to the detail directly.
- Capsule text uses `text-ui-base` and follows the global base font size (14px by default), not the one-step smaller `text-ui-sm`. Existing semantic colors and localized copy are used. Zai Light / Zai Dark, Chinese and English, and desktop and mobile touch are supported. Color is not the only status cue.
- Titles may be truncated and the detail keeps the full text. Buttons have an accessible name, expanded state and keyboard focus. Enter / Space opens, and Escape closes and returns to the trigger. A desktop hover hint is never the only way to act.
- The popover open state is local display state of the current pane. It closes after a session / workspace switch, so an old detail is never carried into a new conversation. When the expanded category disappears because its content became empty, the popover closes with it.
- The four regular types follow the display scope of a real session and do not create fake activity because of draft warm-up. Error prompts still cover the existing draft send / initialization failure cases. Read-only mode, pending confirmation interactions and floating-window mode keep following the existing capabilities and Composer visibility boundaries and open no extra write operations.

### 3. Error prompts (independent banners restored)

Conversation / send errors, quota and service limits, and initialization failures do not go into the status capsules. The display position, banner style and conditions from before the redesign are restored:

- Conversation / send errors use the original `ChatErrorBanner`. The banner border is `0.5px` and keeps the `border-border` color, the close button uses `ghost`, and the other action buttons all use `secondary`. The copy button shows only localized text, no icon. The banner padding is `py-2 pl-3 pr-2` (8px top and bottom, 12px left, 8px right), and the banner is shown directly above the input area with no capsule click needed. The existing error priority, the de-duplication of invalid model and quota takeover, and the retry / reconnect / copy / feedback / dismiss abilities stay.
- Quota and service limits use the original `ConversationQuotaBanner`, placed before the recovery hint and the queue in the bottom dock. The original show / hide logic, exposure reporting, closing and send gating stay. It is separate from the show / hide of the Composer's blocking interactions. The banner background matches the conversation / send error banner (`bg-surface backdrop-blur-md`) so scrolling messages do not show through the translucent background clearly. Button styles stay as they were. The banner has no left or right outer padding and has the same usable width as the conversation / send error banner. It uses `border-[0.5px] border-border` and `py-2 pl-3 pr-2`. The upgrade button keeps the original primary button and active gradient style, and the close button keeps the original ghost style.
- Initialization failure keeps the separate prompt and retry button in the Composer. Its look matches the conversation / send error: `bg-surface`, `rounded-xl`, a 0.5px `border-border`, `py-2 pl-3 pr-2`, a 16px Info icon on the left, body text `text-ui-base font-medium text-foreground`, and a small secondary retry button. No extra prompt shows while initialization is in progress.
- The close button of the conversation / send error and initialization failure banners uses `ghost`, and the other buttons (including upgrade, configure, details, copy, feedback, retry and reconnect) use `secondary`. The upgrade entry loses the gradient background that overrode the secondary button look, and keeps the activity badge and the existing actions.
- The error capsule, the error count summary, the two-line error detail inside the capsule and their dedicated styles are removed. The other four status capsules stay.

### 4. Goal

- Goal 胶囊显示图标与实际目标短标题（无短标题时使用完整目标）；active 时右侧以 `text-ui-sm` 和次要文字色显示累计耗时（中文如 `14分 5秒`，英文如 `14m 5s`），不显示“进行中”文案。标题超出可用宽度时使用右侧 mask 淡出，不使用省略号；短标题不淡出，右侧耗时／状态完整保留。verified 状态仅显示与面板一致的绿色完成图标和目标标题，不显示“已完成”文字；其余非 active 状态右侧显示次要样式状态文字。
- 展开以完整目标正文为首行，下方一行左侧显示“已运行 {duration}”，耗时与胶囊共用本地化单位格式（中文 `14分 5秒`、英文 `14m 5s`），前缀也随语言切换、右侧保留暂停／恢复操作；不重复显示短目标标题，无实际轮次数据时不显示占位轮次。保留状态和当前 Goal 已有的轮次／进度信息，不在迁移中丢弃原本可访问的目标内容。验证原因继续由原有对话内容承载，不另建一套目标历史。
- 暂停／恢复按钮显示图标和本地化短文案（中文为“暂停／继续”，不追加“目标”），只放在详情内，继续使用目标控制命令及现有能力判定，不复用通用停止。按钮操作不得同时触发浮层关闭或其他导航。
- Goal 是会话级状态；完成后及后续成功发送消息后继续显示，直到新目标替换。保留当前目标、轮次与验证记录，不新增历次目标目录。live 与冷恢复使用同一投影规则，忽略旧版 summaryHidden 展示标记。
- 不生成推测百分比。Goal active 不代表 Agent 当前正在输出，不能只因未完成就持续播放忙碌动画。
- 目标计时沿用已有累计值和 active 起点；暂停及完成后冻结，界面计时刷新不成为业务状态源。

- Status capsules and their details use the registered semantic color classes (such as `text-success`, `text-foreground-subtle`, `border-border`) and no longer reference them again through `text-[var(--color-...)]` and similar.

### 5. Plan (not in the status bar)

The status bar no longer shows a Plan capsule or the plan catalog popover. Plan generation, pending confirmation interactions, the plan entry in messages and existing plan details stay unchanged. A session that has only plans produces no status capsule.

### Last turn and Context

Spec: `specs/status-panel-context-and-last-turn.md`. Both sections only read the v4 projection, are collapsed by default and do not take part in `hasContent`: they never mount the status panel on their own, add no inline offset and do not enter the mini capsule. Last turn follows Git Tools and shows the most recent turn that has file changes (the same selection rule as the Review "Last turn" source). It reads the `fileChanges` details only when expanded. Context comes last of all sections and shows the context usage of `snapshot.usage`, the auto-compaction threshold, the source breakdown and cumulative tokens. The secondary meta information in the bodies of the two sections (directories, write counts, legend, `used / max` and cumulative token rows) uses `text-ui-sm`.

### 6. Todo

| State                            | Summary                          |
| -------------------------------- | -------------------------------- |
| Not started                      | `Pending 0/4`                    |
| Has an in-progress item          | `In progress 1/4`                |
| Partly done, no in-progress item | `Completed 2/4`                  |
| All done                         | `Completed 4/4`, completion icon |

- Keep the existing selection rules for the latest Goal iteration Todo, the live plan and the session Todo. When the current Goal iteration has no Todo yet, the list of an older iteration is not shown as a fallback.
- The Todo popover does not show the top "Progress" title or the completed count. The completed count stays only in the capsule summary.
- When all Todos are done, the capsule completion icon uses `text-success`, matching the Goal completed color. The status text and the count keep their own text levels.
- Capsule status text uses the main text color and `text-ui-base`. The completed / total count uses `text-ui-sm text-foreground-subtle tabular-nums`, with a 6px gap between the two and no separator. The icon, the capsule size and the status rules stay unchanged.
- The popover renders the full current authoritative list in its original order. It replaces the three-item focus window and the hidden before / after group previews of the old panel, and the full list no longer needs a second-level hover.
- pending, inProgress and completed use their own icons. In-progress items stand out and completed items are de-emphasized. Long text can wrap, and the list scrolls for reading.
- On first open the popover positions on the current in-progress item. With no in-progress item it shows from the top. Status updates while it is open do not repeatedly take the scroll position from the user.
- There is no manual checking. Status is updated by the original TodoWrite projection, and a paused Goal state does not replace the state of a Todo item.
- After all are done the list is kept per session. Later real user messages, send failures and system continuation do not clear it, and a new TodoWrite replaces the current list. An empty list is hidden and `0/0` is not shown.

### 7. Git changes

**The counting scope is confirmed to stay with the uncommitted changes of the current working directory: unstaged + staged. It is not attributed to the current session and does not include committed but unpushed differences.**

```text
Git repository data source
   ├─ unstaged files and added / removed lines ─┐
   └─ staged files and added / removed lines ───┴→ total summary and reviewable file list
                                                    ├→ file diff
                                                    ├→ branch switch
                                                    └→ commit / push
```

- The capsule shows the file count and the total `+added -removed`. The line counts keep summing the two sources and do not change with the source selected in the Git panel.
- The file count is de-duplicated by unique file identity in the current repository. A file that has both staged and unstaged changes is not counted as two files. The stable identity of each source is kept so the right diff can be opened.
- Each list row shows the project's existing file type icon (`FileDisplayIcon`) and the file name, with the added / removed counts aligned on the right. It shows no inline status or staging source text. The source is told apart through the hover hint and the accessible name. Files with the same name get their directory added, and the full path is reachable. When both sources exist, the hover hint and accessible name say so clearly, and the existing source selection is used to view the matching diff, so neither source is dropped silently.
- Clicking a row opens the existing Git review / diff path, and hover gives weak background feedback. Added, deleted, renamed and binary files keep the existing Git data semantics. When counts cannot be computed, no fake `+0 -0` is shown.
- The bottom of the file list keeps the branch switch and commit / push entries, reusing the existing `GitBranchSwitcher` and `GitActionMenu` abilities and confirmation flow. They do not scroll out of reach with a long file list.
- The capsule shows when there are changed files, even when there is only a binary file or a rename with zero line changes. This replaces the old `added + removed > 0` display threshold. A clean or non-Git workspace hides it. Pending-push commits alone do not keep the capsule.
- After a commit the capsule updates from the refreshed uncommitted data and hides when it reaches zero. It does not assume ahead of time that all files are committed. A read failure is not explained as "no changes" and keeps the existing error source and recovery path.

### 8. Background activity

Merges terminal background tasks, Subagents and Workflows. The capsule first shows stacked avatars of the current Subagent / Workflow actors (at most 3, de-duplicated by session identity). When no avatar is available it shows a single SVG monitor activity icon, where the monitor outline and the activity waveform share one stroke and no icon with a background is stacked on top. It shows the count of the status that matches the top-level activity by the priority below, and expands into one list. Users no longer expand three separate sections.

| Type     | Fields shown                             | Click behavior                          |
| -------- | ---------------------------------------- | --------------------------------------- |
| Terminal | Icon, authoritative title, running time  | Opens the existing output view          |
| Subagent | Avatar / icon, title, running time       | Opens the existing child session detail |
| Workflow | Icon, name, phase / status, running time | Opens the workflow detail               |

- The counts and the activity list use the same normalized result. Terminals and Subagents keep the existing running rule, and Workflows keep the pending / running rule. Finished items are not counted as current activity.
- A Workflow and its background work are merged by the existing stable ID. A Subagent inside a Workflow is not counted again as top-level activity and is viewed in the detail of its Workflow.
- **Before implementation, the authoritative ownership fields of Workflow and Subagent must be verified.** Ownership is not inferred from names, nearby times or list position. When ownership cannot be proven, the independent item is not hidden. If the existing protocol lacks a needed link, first list the evidence and a minimal contract proposal and confirm it, and do not quietly extend the protocol or coordinate with delays.
- The top-level list is ordered stably by start order. When the time is missing, the stable order of the data source is kept, and the stable identity breaks ties. No fake time is generated. A status update does not reorder existing items.
- The stop action shows according to the existing cancellable / control handle and the platform ability. It is disabled while pending to prevent repeated operations. Stop controls only its own item and does not bubble up to open the detail.
- Clicking the background activity capsule always opens the unified list. The old branch that jumped straight to the detail when there was only one Workflow is gone. Only clicking a specific row navigates.
- For a finished activity whose description equals its title after trimming leading and trailing whitespace, the description row is hidden. A blank description is hidden too. A different description is shown as written, and the title, result status and elapsed time stay unchanged. Terminals, Subagents and Workflows share this display rule, and the authoritative record is not rewritten.
- A running item that ends turns into a result of the current batch and is kept. The bottom of the popover offers entries to the Subagents / Workflow runs history catalogs, and the standalone catalog pages keep the full history.
- The avatar group and the summary text are computed separately. While there is running activity, the avatars of running / waiting and of completed agents are all kept, and successful items keep the completion badge. Completed actors inside a Workflow are kept too. The text and the count still follow active > failed > completed only and do not change with the avatar count. Avatars are first de-duplicated by stable identity. Running avatars take slots first, then waiting avatars, and completed avatars fill the remaining slots, at most three in total. After selection the display order is completed on the left and running / waiting on the right, and avatars of the same state keep their existing order. When three or more running / waiting avatars fill the slots, no completed avatar is shown. When no avatar is available the activity icon is used. With no running activity the avatar rule of the failed / completed summary is kept, and the detail still shows the real state of each item.
- The capsule, the running / finished detail and the message avatar of an independent Subagent share `ToolPresentationCapabilities.agentColor` to configure the identity color. When it is not configured, the same name hash rule on the raw `subagentType` is used. The color expresses identity only, not running state. Workflow actors keep their existing identity color source.
- The capsule shows only the highest-priority status: P0 `Active {active count}` -> P1 `Failed {failed count}` -> P2 `Completed {completed count}`. A count includes only its own status and does not mix in other statuses. The prefix keeps the avatar group / activity icon.
- The failed count belongs only to the current display batch. After the next real user message is accepted, the authoritative `activitySummaryDismissed` is reused to fold the previous batch of finished details, and the failed count returns to zero. Successful finish records of Subagents / Workflows keep counting toward the completed count, while the background Bash success count belongs only to the current turn and is cleared once the next input is accepted. Send failures, draft edits and system continuation do not clear anything. Newly finished activity counts as a new batch. Desktop continuous and mobile snapshot / replay use the same projection and have no separate UI counting cache.
- The cross-turn success count comes from the CLI authoritative projection `completedActivityCount`. It counts by the latest state of each child / run identity, includes successful independent Subagents and completed Workflows, and excludes the duplicate count of Workflow actors. The Bash success count of the current turn is still summed in the UI over results that are not folded. The limits of 100 Subagents / 8 Workflows apply only to details and avatar previews and cannot limit the total success count. The catalog count includes failed / stopped runs, so it is not on the same basis as the success count.
- The CLI rebuilds the counts from existing events and from the full child seed of a cold restore. A Workflow cold restore also reads the full identity / status / sequence and the actor sessionId summary from the journal. It is not limited by the eight-item detailed replay cap, reads no script, node or result body, and the status index is committed / rolled back together with the atomic projection transaction. When the same identity resumes running it is moved out of the success set and counted only once after succeeding again. A Workflow rejects stale count updates by the in-run sequence. The journal summary watermark is kept separate from the consumed event watermark, and a buffer that arrives during the summary read must still update the preview and must not be swallowed by a newer count watermark. Repeated events do not add up. New input clears only the hint of the current turn and not the historical successes, and sessions are independent. Desktop continuous and mobile replayable both consume the same snapshot / delta and add no query or timer sync. When an old CLI does not provide this optional field, the old preview count is kept for compatibility, and only an upgraded CLI provides the full total.
- Regression: after 9 successful runs the count is 9, and adding failed / stopped runs keeps it at 9. 105 successful children exceeding the 100-item preview still give 105. Replay, resuming the same identity, cold restore, transaction rejection, both delivery profiles and reconnection stay consistent. Avatars use only the existing preview and do not enlarge the snapshot.
- When everything is stopped, the stop summary is kept, and stopping is not counted as success. When only the history catalog is left, `Completed {completed count}` is shown and no longer falls back to "Active". With no successful items it is `Completed 0`, and failed or stopped items are not counted as success. The expanded list keeps the real result of each item.

```text
Real input accepted -> authoritative projection marks the previous batch's finished identities -> UI folds the old finished details, excludes the old failed count, keeps the Subagent / Workflow success count and clears the Bash success count
Current running and unfolded results -> active count > 0 ? Active N
                                      -> failed count > 0 ? Failed N
                                      -> completed count > 0 ? Completed N
                                      -> original stop summary / "Completed 0" history entry
```

- Platforms without a detail ability can still view status and run their existing actions, and no dead navigation button is drawn. Mobile remote control must not bypass the existing child session access boundary because of the new layout.

### 9. Migration checklist

| Old content                                                         | New place / handling                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ChatErrorBanner, quota prompt, initialization failure bar           | Restore the original separate banners, positions and display conditions                   |
| Top-right Goal, Todo, Git, background resources                     | Matching capsules. The old top-right Status shell and its dedicated avoidance are removed |
| Background count entry in the input box leadingActions              | Background activity capsule. The duplicate entry is removed                               |
| Git branch / commit / push                                          | Bottom of the Git popover. Other existing workspace entries are not removed               |
| Mode, Computer Use                                                  | Keep the original position                                                                |
| Hook / MCP pending review                                           | Keep the original position and the Sky unread dot. They do not enter this status bar      |
| Message queue, pending-send recovery                                | Keep the separate display and the existing actions                                        |
| Blocking interactions such as permission, Q&A and plan confirmation | Keep the original interaction and the input box show / hide rules                         |
| Attachments, quotes, edit hint, quote limit hint                    | Keep the original position inside the input box                                           |

The old `panel` / `mini` / auto form preference no longer drives the new status bar. It is not migrated into new business state and is not written back to the remote. Settings switches and popover changes must not cause a width animation of the message column.

### 10. State ownership and sync constraints

```text
CLI goal / plan / Todo / activity facts -> session authoritative projection -+
Git repository service -----------------> Git dataset --------------------+-> summary / list of the current pane
                                                                           |
                                                      exclusive detail popover (local display state)
                                                                           | user action
                                                                           v
                                                  existing command / Git operation / detail navigation
                                                                           |
                                                              authoritative result returns and updates

desktop continuous -- ordered delta -+
mobile replayable -- snapshot/replay +-> same facts and display rules
```

- Keep the existing owner of each kind of fact. The new layer only does display grouping, summaries and evidence-based de-duplication. It does not copy accepted state and builds no separate business cache, database or global polling.
- Pause, resume, retry and stop must go through the existing entries. Local state must not be changed first to announce success.
- Session, workspace, Goal target and the stable activity identity keep the existing isolation rules, and a late result cannot update a popover that has already switched. After a protocol reconnect, state is restored from the current projection and not derived from local capsule counts.
- Refreshing the running time is for display only, and no timeout is used to solve state sync. Closing / unmounting cleans up resources through the existing lifecycle.

### 11. Acceptance scenarios

When implementing, first maintain the existing E2E case / spec, then change the interaction implementation. No App business unit tests are added. Reuse the real-component browser scenarios and the desktop / mobile paths, and a simulated viewport must not be called a real-device acceptance.

| ID   | Repeatable scenarios that must be covered                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ST01 | All four types together, any subset, all empty. Order is correct, with no empty placeholders and no duplicate old entries                                                                                                |
| ST02 | Click to switch, click again, outside click, Escape, keyboard, touch. Only one detail at a time, and switching sessions does not mix content                                                                             |
| ST03 | Zai Light / Dark, Chinese / English, desktop wide / narrow, mobile. Long titles, no horizontal scroll, popover collision, inner scroll, and the input box and message column are not squeezed                            |
| ST04 | The three original banners shown directly, quota de-duplicated from the same source, dismissible / not dismissible, recovery failure. The original gating is kept and no error capsule is generated                      |
| ST05 | Goal active / verifying / paused / notSatisfied / verified, pause and resume, goal replacement, existing iterations and timing. A completed goal is kept until the next successful send, and no fake percentage is shown |
| ST06 | Plan none / one / several never show a capsule. Pending plan confirmation and the message detail entry still use the original interaction                                                                                |
| ST07 | Todo empty / not started / in progress / partly done / all done, very long list, original order, first-open positioning, updates do not take over scrolling, and a Goal iteration change does not show the old list      |
| ST08 | Git unstaged / staged / same file in both, same-name paths, binary, rename, read failure, commit clears. The file count is de-duplicated, the diff source is reachable, and view-all-changes and commit actions are kept |
| ST09 | The three activity types alone / mixed, Workflow merged with work, internal Subagent de-duplicated with evidence, unknown ownership not hidden by mistake. The capsule count matches the top-level list                  |
| ST10 | Activity finished, stop pending / failed, history only, history ability missing, stable ordering, and opening a detail and stopping do not trigger each other                                                            |
| ST11 | Desktop continuous and mobile replayable: reconnect / snapshot recovery, workspace and session switching, late update isolation. No new polling and no second state source                                               |
| ST12 | Queue, pending-send recovery, blocking interactions, attachments / quotes, edit mode, read-only, draft, floating window. Original behavior is kept, and Hook / MCP / Computer Use are not migrated                       |

Completion criteria: the related types, lint (including the Hooks diagnostics review), architecture, affected checks and the applicable runtime acceptance above pass. Not run, simulated and real-device checks are reported separately. After implementation, update the status of this document, delete the obsolete pre-migration display notes, and keep the data contracts that still apply.

## Implementation and verification record

- `ConversationStatusPanel.tsx` provides the capsule row, the exclusive popover and the four conversation details. The three error types use the original separate banners. Switching conversation / workspace clears the popover through the display key and does not clear business state.
- The Git file list reuses the `useGitRepository` data already held by `App` and is injected through Context, so no repository polling is added. A file diff request accepts only the result of the current workspace and the current click generation. Office mode keeps the existing Git hiding rule.
- A Workflow removes the duplicate entry of the same sub-agent only by `actors[].sessionId` of the active run. Without an identity link, the item shows independently. Activity with a missing start time is ordered stably after the ones with a known time.
- Goal keeps the existing iteration summary, Todo preview and timing functions. The Todo list keeps the projection order. The choice of the current goal and historical iterations is still decided by the existing model.
- The exposure callback of the quota prompt is still triggered by the visibility detection of `ConversationQuotaBanner`. It is reported when the separate banner is visible and does not change the quota gating.

Browser candidate: `packages/ui/test/browser/manual-review/pending/composer-status-capsules.test.mjs`.
Run: `node --test packages/ui/test/browser/manual-review/pending/composer-status-capsules.test.mjs`.
2026-11-09: 12/12 passed. Screenshot directory: `packages/desktop/.e2e-artifacts/composer-status-capsules-browser`. Coverage: desktop / 390px touch viewport x light / dark theme x Chinese / English, plus real Goal control, Todo, Plan catalog, Git dual sources, error recovery callbacks and Workflow sub-agent de-duplication. The candidate is still manual-review/pending and does not enter CI automatically.

The desktop dev build checked Goal, Todo, Plan, historical activity, the real Git file list and error details with an existing session, and no new pageerror was observed. No commit / push, real task stop or paid upgrade was run. Control checks in the browser used isolated callbacks and do not represent end-to-end coverage of the host command chain. The above evidence is not recorded as all of ST01-ST12 covered. Mobile remote reconnection, multi-platform whole-machine runs and real phones still need dedicated acceptance.

Static checks: `pnpm typecheck`, `pnpm lint` and `pnpm architecture:check --changed` passed. Lint has 0 errors and keeps the repository's existing warnings. Comparing the five logic files touched this time with HEAD shows no new Hooks diagnostics. The format check and diff whitespace check of the changed sources and browser cases passed.

2026-11-09 error detail layout fix: 8 browser assertion groups (390 / 1200px x light / dark x Chinese / English) with the real `ChatErrorBanner` verify that the body is not truncated, the buttons sit below the body and there is no inner border. The candidate totals 20/20 passed. Original banner scenarios keep the original layout, and the capability checks of the recover and dismiss actions are unchanged.

2026-11-09: At the user's request the original banner logic and style of the three error types were restored. The earlier error capsule and its layout checks are history only and no longer define current behavior.

Verification of this restore: types, lint (0 errors), the architecture check and the existing browser candidate 19/19 passed. In a real desktop session the error banner is directly visible and there is no error capsule. The initialization failure and quota conditions, callbacks and positions were restored to the pre-redesign implementation. A real quota exhaustion or initialization fault was not triggered.

2026-11-10 Todo lifecycle verification: the source and the compiled bootstrap projection each passed 15 regression checks (including keep after completion, clear on the next real input, keep when unfinished, replace by a new list, and cold restore consistency). The desktop Agent was rebuilt and the CLI entry start was verified. This record is not treated as end-to-end acceptance of a real desktop send.

### Queue next to the input box

Status capsules -> message queue -> input box. The outer border of the message queue is 0.5px. The queue renders through the Composer queueContent slot after the status bar, and its negative bottom margin only joins the input box and no longer crosses the status capsules. Queue state, edit, delete, reorder and send-now callbacks are still provided by SessionPane, and the message send timing is unchanged. Desktop and mobile share this structure.

### Unified layout of activity items

The stop buttons of background tasks, Workflows and Subagents all use the Lucide `CircleStop` outline icon, with the original size, stop text and action behavior kept.

Terminals and independent Subagents: the first row has a 16px icon / avatar and a ui-base title, and the last row has the elapsed time in ui-sm secondary color and a separate stop button. Workflow: the first row has a status dot and the title, the second row has side-by-side 16px Agent avatars, and the last row has the elapsed time and the stop button. Avatars read the existing workflowRuns projection directly by runId, and no new state source or polling is added. All later rows are left-aligned with the title, the stop button no longer replaces the elapsed time on hover, and the original capability checks and callbacks are kept.

The status dots of Activity and the Workflow catalog reuse the stationLampClass of the workflow card: 10px, the running state uses the warning color with a breathing glow, the stopped state is hollow, the completed state uses the success color and the error state uses the destructive color. They respect reduced-motion.

### Activity kept results and history catalogs

The Activity capsule shows the running items of the current session and the items finished in the current turn. The next successful input folds the finished details. Entries to the Subagents and Workflow runs history catalogs are provided based on the two kinds of folded history identities, and they are not affected by the finished details of the current turn. An entry shows when the matching finished total is above zero and the current session identity and the host open callback are available, and it reuses the authoritative query and navigation of the catalog page. The catalog count does not enter the running count. When only an openable history catalog is left, "Completed" and the full success count are shown according to the stage table below, a known zero shows 0, and an unknown total shows no number. On mobile remote control without a catalog host, no dead entry is shown.

While permission or Q&A blocks, the queue area follows the visible queue after the pending-guide filter. After the last item is deleted, the queue content and its outer spacing are removed together, and the existence of a React element must not stand in for the check of visible items.

Acceptance: the existing history catalog can be opened both while running and after completion. The catalog matches the current session, and repeated clicks reuse the same tab. After a successful send the catalog records are kept and old finished details do not come back. When only the catalog is left, the completed summary required by the stage table is kept. For parallel Subagents, the capsule count, the real popover rows and the conversation tool entry are checked separately, and the same attribute must not be read twice to pose as cross-checking.

### Stacked avatar outline

The stacked Activity avatars draw a 1px visible outer outline with the rounded path of the SVG itself. The color is input, matching the default capsule background. The outline and the avatar share the same rx, and the independent radius of an outer CSS ring is not used. The avatar size and the stacking spacing stay unchanged.

### Unified capsule structure

The four capsule types share one structure: a 16px icon slot, a shrinkable ui-base main text, and a non-shrinkable ui-sm secondary info slot. Main text overflow fades out with a mask. Secondary info uses the secondary text color and tabular-nums, and Git additions / deletions keep their semantic colors. Goal time and paused state, Todo progress, Git additions / deletions and Activity counts all use the secondary info slot. Capsules may shrink, stay on one line and do not scroll horizontally.

### Unified capsule acceptance run (2026-11-10)

Keep the existing 26 browser regressions first, then add a width / theme / language matrix with the real four types of content, and assertions for the long title mask, 32px height, 16px icon, 12px secondary info, 0.5px border, input box token alignment, SVG avatar outline, and keyboard and outside close. New cases are not marked covered before they run. A browser fixture state update does not stand for the real Agent lifecycle. The desktop command chain and a physical phone remote are recorded separately.

In narrow containers (under 640px) the spacing inside and between capsules drops to 4px. The left / right padding stays 8px / 10px, and the icon and secondary info are kept. A capsule uses three columns: icon, compressible title and secondary info. The minimum width must include the fixed slots, and only shrinking the outer frame so that content overflows is not allowed.

#### Evidence and limits of this round's acceptance

- The browser regression of the earlier five-type capsule version passed 40/40 (the original 26 + a 12-group geometry matrix + 2 projection update cases). `acceptance-before.log` and `acceptance-final.log` keep the before and after results. Types, lint (671 existing warnings, 0 errors), architecture and the E2E type check passed.
- Browser evidence directory: `packages/desktop/.e2e-artifacts/composer-status-capsules-browser/`. `geometry-*.json/png` store the bounds, sizes and screenshots of the five types of content at that time, and `*-focus.json` records the real focus and the tooltip layering before Escape.
- The first new geometry check reproduced a narrow-screen defect: the usable width of a 390px container was 358px while the row scrollWidth was 366px, and several capsule frames were smaller than the fixed icon and number so the contents covered each other. The fix then was a Grid with a fixed slot minimum width plus compressing the whitespace in narrow containers. The final padding follows the spec at the end of this document. The protocol and the state source were not changed.
- Escape was not a panel closing defect: when Goal auto-focused the pause button the tooltip was already open, so the first Escape closed the tooltip and the second closed the panel. The test accepts the real layering, and no business event handling or timeout was added.

| Acceptance item                                                                         | Evidence and result                                                                                                                                                                                                    | Boundary not covered                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified structure, size, font size, background / border / shadow tokens, avatar outline | 12 new real-component geometry scenarios, 390 / 600 / 1200px x Zai light / dark x Chinese / English. After the fix the targeted regression passed 12/12                                                                | The phone is a browser touch viewport, not a physical remote                                                                                               |
| Real Todo chain                                                                         | A real TodoWrite in an independent temporary project: in progress 1/3 -> done 3/3. It is kept after the turn ends. After the next user message is accepted and answered, the capsule disappears                        | Send failure, refresh recovery and cross-device reconnection are not accepted yet                                                                          |
| Real background task stop                                                               | A terminal actually started a background task that prints the time every 5 seconds. Activity 1 appeared and the panel showed the elapsed time. After clicking Stop on that item, the capsule and the panel disappeared | Natural end, failed stop and the real command chain of mixed activity are not accepted yet                                                                 |
| Real Goal chain                                                                         | Blocked: the current model reported that the Goal tool does not exist. No goal was created or faked                                                                                                                    | Pause / resume / complete / hide after send were not accepted on a real run                                                                                |
| Real Plan and Git chain                                                                 | After unblocking, the Plan detail entry at that time, the staged diff source and the rename display were verified. The temporary repository changes were committed and cleared                                         | A binary file did not appear in the capsule list and the reason is unconfirmed. Hiding after clearing was not accepted. The Plan capsule was removed later |
| Phone remote control                                                                    | A connected physical Android device was found                                                                                                                                                                          | Login pairing, touch commands, refresh and disconnect recovery were not run, so this cannot be marked as passed                                            |
| Queue, attachment, edit, read-only and send failure together                            | The full combination was not run this round. The original error banner browser scenario is kept                                                                                                                        | Still pending acceptance under ST11/ST12                                                                                                                   |

The user stopped further runtime tests. The browser cases were not rerun after Plan was removed, the whitespace was changed and the Git bottom actions were changed. The historical 40/40 does not mean the current version passed.

The overall status stays partial / manual-review pending. It is not promoted automatically or added to CI. Before real desktop and phone acceptance is done, component callback tests are not written up as a full end-to-end pass.

Status capsules use the same padding `pl-2 pr-2.5` (8px left, 10px right) at all container widths, and narrow containers do not override the padding. The other spacing shrink rules stay unchanged.

The outer status bar uses `px-3` (12px on each side), and the capsule group is centered in the remaining content width. The capsule's own padding is not affected.

Status capsules use `backdrop-blur-md`, keeping the original background opacity on hover and when expanded while blurring the message content behind.

The Git capsule uses a separate 0.5px divider between the file list and the bottom actions, with 4px spacing above and below. With no file list the divider is hidden. The bottom action layout is unchanged.

Below the file list divider, the Git capsule popover shows, in order, view all changes, the current branch, and commit / push. It reuses the real gitSummary and the existing branch label parsing, and a detached HEAD uses the existing i18n text. The whole branch row uses the existing GitBranchSwitcher to open the branch switch panel, and the right dropdown arrow is fixed at the far right in the secondary text color, right-aligned with the count of view all changes. Switching keeps the existing service, confirmation and refresh chain. The branch row and the action rows share a 32px height, a 16px icon, ui-base font size, 8px horizontal padding and icon-text spacing. A long name is clipped to one line and fades out with a mask on overflow, with no ellipsis. The left and right icons do not shrink, and the title keeps the full name. This popover uses `gap-0` on its own, so the 16px gap of the shared Popover does not stack on top of the divider whitespace. The divider has 4px above and below.

The Git popover divider color uses `border-border/50` (the border semantic color at 50% opacity).

At the bottom of the Git popover, above the commit / push entry, there is a FileDiff icon and a "View all changes" button. It reuses the Git Review callback of the current workspace and the source identity, and is disabled when there is no open ability. The right side of the button shows the same de-duplicated file count as the capsule, in the ui-sm secondary text color. The label takes the remaining space and the count does not shrink.

### Banner and status bar are mutually exclusive

When a conversation / send error, quota and service limit, or initialization failure banner is actually shown, the whole status bar and any open status popover are hidden. After any of the three banners is gone, the capsules that qualify come back. The banner render conditions are reused, and the business state of Goal, Todo, Git and Activity is not cleared. An error that is filtered out or already closed does not hide the status bar. Desktop and mobile share this rule.

### Capsule main text overflow

When the Todo status text, the Git file count text or the Activity name cannot be shown in full, the whole text is hidden and is not truncated or faded. The icon and the secondary number stay. The decision uses the real text width and the available width, and it is measured again and restored when the container gets wider or the text changes. While hidden, the text leaves the layout and its slot and extra spacing are removed, so the capsule shrinks. Restoring is decided by the width needed for the full text, to avoid a show / hide loop caused by the width bouncing back after collapsing. The Goal title keeps fading out with a mask.

### Vertical spacing of the status bar

Based on the existing `pb-4` (16px) at the bottom of the Timeline input box: the scroll-to-bottom button keeps the top anchor of the whole input area and uses `mb-4` (16px). The status bar keeps only `pb-4` (16px) and has no top padding. In the normal input state, the button to the capsules, the capsules to the input box, and the input box to the bottom are all 16px. With no capsules the status bar takes no height and the button to the input box is still 16px. The button size, the input box inner padding, the bottom safe area and the existing floating window layout are unchanged.

The scroll-to-bottom button keeps its original 28px size and 16px icon, and shares the look of the status capsules: a 0.5px `border-input-border` border, a `bg-input bg-clip-border backdrop-blur-md` background and the `--shadow-composer-soft` shadow, with the outline hover kept. The button stays round.

### Activity session-level kept results

Avatar regression constraint: for a Workflow that is still visible this turn, even when it is stopped or abnormal, its completed actors can still enter the avatar group and keep their own completion badge. Details folded for the next turn are not revived. The three slots are chosen in the order running, waiting, finished, and after selection are still shown with completed on the left and in progress on the right. The text and count priority is unchanged. Browser coverage includes a stopped / abnormal parent run with a completed actor, and three waiting actors with one running independent agent, across 390 / 1200 viewports and light / dark themes.

Activity keeps the real finished state of terminals, Subagents and Workflows per current session. A later successful input only folds the details and turns them into an available history catalog. Running items come first, and when everything is finished the result status is shown. Desktop and remote control share the snapshot / delta and no UI cache is added. The Subagent preview still holds at most 100 items, with a title of 256, a type of 128 and a result of 4096 UTF-16 code units. The full result and the total are read through the history catalog.

### Review regression: continuous clearing and the queue under blocking interactions

- The Activity finished summary folds after a later successful input, while the authoritative record and the history catalog stay. A new execution of the same child updates its record. Continuous input, unrelated events and a process restart give the same result.
- Waiting for permission / Q&A only hides the input area. An accepted queue still shows independently and can be deleted. The normal layout stays status bar -> queue -> input box. In the blocked state the queue stays in the bottom interaction area, and the queue owner and command callbacks are not changed.

### Activity finished badge (2026-11-11)

The panel avatar and the capsule aggregate badge reuse the same SVG: bottom left, scaled in proportion from an 11-unit circle in a 20-unit avatar. A 16px avatar gets a badge of about 8.8px. Completed is a success circle with a contrast check mark, stopped is a gray solid circle with a contrast small square, and abnormal is a destructive circle with a contrast exclamation mark. The outer edge keeps the background color as separation. A single avatar expresses only its own result. The capsule stacks only one aggregate result badge, and no finished badge is shown while running. A completed Agent inside a Workflow keeps its completion check and does not turn into stopped when the Workflow stops. The existing status priority and lifecycle are kept and the protocol is not changed.

Visual acceptance: `activity badge parity` in `composer-status-capsules.test.mjs` passed 12/12, covering three results x 390px touch / 1200px desktop viewport x Zai Light / Dark. It verifies the shared SVG content, the 16px avatar, the bottom-left position and the stop square, and saves `packages/desktop/.e2e-artifacts/composer-status-capsules-browser/badge-*.png`. This is a shared-component browser acceptance and does not stand for a real phone remote or a tool lifecycle E2E.

Finished avatar expression: stopped uses the plain idle eyes and stops the animation. Failed uses the existing failed -> sad expression, and undefined must not be passed because it falls back to the waiting three dots. The panel and the capsule both follow this mapping. A finished avatar in the capsule is still, and the waiting three dots are used only for the waiting state.

Expression regression: before the fix the stopped-state browser assertion reproduced `dots` instead of `pill`. After the fix it passed 12/12 and covers switching from running to completed / stopped / failed, confirming that the old animation cleanup does not overwrite the current result expression.

## Status capsule E2E entry migration (CR-01, accepted)

The old unified panel is removed. The formal E2E uses `data-status-capsule` to open Goal, Git and Activity, then verifies the original actions inside the `data-status-capsule-content` popover. The popover renders through a Portal, so it cannot be found inside the SessionPane subtree. The Goal state is read from the read-only projection attribute of the current pane. The activity count reads the de-duplicated running items of the capsule and does not treat the finished summary as running items. Plan details keep the plan card entry in the conversation flow, and the Plan capsule is not restored. The old left / right offset layout assertion is migrated to "the status row above the input box and the message column do not shift".

The assertions for pause / resume, single item stop execution identity, Git source, plan order and session isolation are kept. This change does not alter the product lifecycle. The history catalog entry is now restored per "Activity kept results and history catalogs". Migration verification status: partial, 14 related local replays passed, and the SSH Goal was not run. The evidence and the audit blockers are in the coverage matrix section. At the user's request Docker was not run.

The migration run evidence is in the [E2E coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md). The Goal read-only diagnostic attribute belongs to SessionPane. The Activity running count and the rendering share one de-duplicated model. Unfinished remote verification and the baseline audit errors are listed separately.

Migration cleanup: the message column and the input area use the same normal width. The old summary layout parameter that was always none is no longer passed, and no inline offset branch is kept. The old section and collapse copy is deleted, and the stop and view-all-changes copy that is actually used is kept. The existing layout regressions for wide and narrow windows and mobile Web prevent the offset from coming back.

### Workflow summary identity after resume

When a Workflow resumes with the same runId, the original record is updated and other in-session activity is kept. After it ends again, this result is still shown. Live and hydration share this rule.

Migration cleanup addition: delete the six multilingual keys of the old Composer background entry, the workflow badge direct-jump / row copy helper functions that no longer have consumers, and the sessionPlans model and props of the old Plan capsule. The conversation flow plan data and the plan detail entry are kept.

Branch entry regression (2026-11-12): the real desktop `conversation-session-git-review-entry` passed 2 cases, covering expanding the branch list, closing with Escape and continuing into change review. Artifact: `packages/desktop/.e2e-artifacts/desktop-e2e-20261112024516477-p36510-654f164723258622`. Four browser checks across light / dark themes x 390 / 1200 width verify the long name mask, no ellipsis and the fixed icon size. Real phones and Windows / Linux were not run.

### Git file list scroll boundary

The file list has a maximum height of 256px, the scroll viewport extends to the left and right inner edges of the popover, and the file rows keep their original padding. The scrollbar sits on the right side of the panel. ScrollFadeViewport is reused: no fade without overflow, only the bottom fades at the top, both top and bottom fade in the middle, and only the top fades at the bottom. The branch and action area does not take part in list scrolling. Wheel scrolling at the boundary does not pass on to the chat.

### Git refresh after a whole turn completes

When the current actionable session goes from running to completedSuccess within the same live projection and log generation, the existing onRefreshGit is called, and the Git summary, file list, added / removed counts and branch are fetched again at once. Only the whole-turn state is observed, and tool or sub-agent completion does not trigger it. A cold history mount, a session switch, a disconnect and resubscribe, a failure and a stop do not trigger this new refresh. The 60-second debounce of the original file watcher and the refresh after Git operations stay unchanged.

Verification (2026-11-12): the old build showed no new file within 15 seconds after a controlled whole-turn success, red evidence `packages/desktop/.e2e-artifacts/desktop-e2e-20261112031535993-p57477-bd58c7bc81be613e`. After the fix, App / Agent were rebuilt and `conversation-session-git-review-entry` passed 3 cases, artifact `packages/desktop/.e2e-artifacts/desktop-e2e-20261112031644793-p58417-26babb11f063f0e7`. In it the new completion refresh case read the file before the watcher debounce. Types, lint, architecture and the fixture check passed. Real phones and Windows / Linux were not run.

### Branch menu opens the Git graph

When the branch menu in the Git capsule opens the graph, the same action closes the branch menu and the outer capsule. The graph is owned by the session Git operation host outside the status bar, so closing the capsule does not unmount the graph. After the graph closes, the two layers of menus do not reopen automatically. Other branch entries keep the original graph behavior, and the lifecycle problem of nested popovers is not covered up by raising the global z-index.

Graph linkage regression (2026-11-12): the old build `desktop-e2e-20261112033327465-p66461-9546c59277bd9a9c` reproduced that the Git capsule was not removed after the graph opened. After the fix, `desktop-e2e-20261112033741769-p72296-56d245e960681d68` passed opening the graph, both menu layers disappearing, closing with Escape and re-entering change review. The other two Git regressions of the same build passed in `desktop-e2e-20261112033449266-p67591-a1ced37903e3ed9e`. All are under `packages/desktop/.e2e-artifacts/`. Types, lint and the architecture check passed. Windows / Linux and real phones were not run.

Git actions area E2E regression (2026-11-12): "View all changes" is located by a stable test id, and the checks cover that the de-duplicated count matches the capsule, the action order, and that the arrow and count alignment on the right and the secondary color are consistent. The desktop entry scenario passed, artifact `packages/desktop/.e2e-artifacts/desktop-e2e-20261112051237469-p10610-d52261764416896f`. The task completion refresh and large-file memory scenarios of the same build passed in `desktop-e2e-20261112050817003-p5005-35a0b7881f12be98`. An earlier attempt waited for the exit animation before opening, and a later Windows CI showed this measure was not enough. The real focus restore problem and its fix are described below. Real phones and Windows / Linux were not run.

After the branch menu in the capsule closes, Radix restores focus to the branch trigger button and does not call the input box focus path of the toolbar entry. The end of the exit animation does not mean the async focus is done. A late input box focus used to close a menu that had been reopened. The standalone toolbar branch entry keeps its original input box focus behavior.

Focus regression (2026-11-12): the Windows log of CI showed that the search box was unmounted after it was created a second time. A local event record reproduced that after the search box got focus, focus went into the input box again. After the fix, the three real desktop Git E2E cases passed in the same run: `packages/desktop/.e2e-artifacts/desktop-e2e-20261112060213251-p30241-cee8ce4053678c65`. The case asserts directly that focus returns to the branch button after Escape. Types, E2E types, lint and the architecture check passed. Windows CI of that version later passed on rerun, which does not mean the stable host fix below has been verified on Windows. Real phones were not run.

### Git operation stable host

The branch controller, all branch confirmation dialogs and the Git graph are owned by the stable Git operation host of SessionPane, isolated by workspaceIdentity, session and gitCwd. The capsule mounts only the entry view of the controller. Entering a modal flow closes both layers of menus. The file count reaching zero, and the error / initialization failure / quota banners hiding the status bar, do not unmount the operation host. After a commit succeeds and the refresh shows zero modifications, the error and recovery UI of a failed switch must be kept. An explicit close or a session / directory switch releases the UI, and the graph must not be handed back to the capsule subtree.

Acceptance: real-component browser coverage of creating a branch, canceling after being blocked, a switch failure with a controlled delay after a commit success, and the graph being kept while the error / quota hides the entry. The existing desktop Git entry and refresh E2E regressions.

The input box auto focus staged while the session connects must not take over an already open Popover / Dialog. When the focus is fulfilled and focus has already entered the popover, this old request is canceled. This check happens before the real focus and does not use a timeout or reopening the menu to compensate.

Stable host regression (2026-11-12): 10 new real-component browser acceptance cases passed, covering light / dark themes and 390 / 1200px. A controlled service verified that changes are cleared after a commit succeeds, that the error can still be handled when the switch fails, and that the graph DOM and loaded content are kept after the status bar is hidden. Evidence: `packages/desktop/.e2e-artifacts/git-action-lifecycle-browser/`. This is a component and structure unmount check and does not stand for real error / quota server events or a phone remote acceptance. The existing capsule browser suite passed 64 cases.

The new desktop build passed three cases: `packages/desktop/.e2e-artifacts/desktop-e2e-20261112074805483-p96073-986c3cffda268120`, including a real branch creation, keeping the Git popover after the connection is ready, branch menu Escape / reopen, the graph and change review, task success refresh and the large-file memory check. Before the fix, events and call stacks located that on connection recovery `flushPendingFocus` fulfilled an old intent and focused the input box, which closed the popover. The fix keeps the popover focus before the real focus and uses no delayed retry. The root types, desktop E2E types, lint, architecture and fixture checks passed. Lint has existing warnings. This version was not run on Windows / Linux, a real phone or Docker.

Git isolation only resets the controller and does not remount the input box and the timeline through a React key around paneContent. First-send promotion, switching task in the same pane and an async cwd update keep the subtree node identity. An async Git response of an old scope must not be written into a new scope. A commit / switch that was already confirmed keeps finishing in its source directory and keeps the original operation semantics. The acceptance of the new-branch submit button locates it by form submit semantics and does not depend on the Chinese or English button text.

Verification of this Git scope fix: 14 real-component browser acceptance cases passed (including creating a branch in Chinese and English, switching session / directory and old response isolation). The desktop E2E `conversation-session-git-review-entry.test.ts` passed 3 cases, run record `desktop-e2e-20261112090850482-p56991-76d518ce6fab5bcc`. Windows CI needs separate confirmation after push, and the local macOS result does not stand in for it.

Graph request isolation: only the graph subtree is rebuilt by Git scope, and the chat area nodes stay unchanged. After the graph is closed, reopened or the scope changes, the results and errors of the previous first load, refresh and pagination become invalid and cannot overwrite the current commit, the selected item, the pagination state or pop up an old error hint. Acceptance uses real components and controllable delayed responses, covering the same directory A -> B -> A, directory switching, close and reopen, and an old pagination / refresh failure.

Graph isolation regression (2026-11-12): before the fix, the real browser reproduced the old first load overwriting the current history. After the fix, the lifecycle browser suite passed 20 cases, of which 6 controlled out-of-order cases cover an old first load success / failure, refresh failure, pagination, directory switching and close and reopen. The new build passed 3 desktop cases, record `desktop-e2e-20261112092219804-p74164-8e751acf3220226d`. Types, lint (existing 669 warnings, 0 errors), architecture and the format check passed.

Conversation column width: `w-full max-w-6xl` is used uniformly, and the width deduction rules of the 864px and 1280px breakpoints are removed. The content fills the available width, is capped uniformly by `max-w-6xl` and keeps the existing centered layout. The width of an empty new conversation and the body / input area padding stay unchanged.

### Session-level capsules always shown (2026-11-13)

Goal, Todo and Activity all come from the Agent's session authoritative projection. Goal and Todo stay shown and are replaced by a new goal / list. Activity shows according to the details / history entry stages below and finished records are not deleted. Subagent still keeps a bounded preview of the latest 100 items, and the full history is queried through the catalog, so the snapshot does not grow without limit. Switching session does not mix state, and refresh and cold restore recover through the same event reduction. Git still shows only when there are changes.

```text
Session event -> Agent projection -> snapshot/delta -> desktop and phone
New message -> keep Goal / Todo, Activity folds old details and shows the available catalog
Goal or list update -> replace the matching content
Activity event -> update the running and finished records
```

Acceptance: after completion it can still be expanded after two consecutive sends. A failed send does not change the state. It is kept across refresh / restart. A new goal and Todo replace the old ones. The same child / run of Activity does not repeat on recovery. Session isolation and the 100-item capacity limit are unchanged.

Verification of this round: CLI projection and related regressions 289/289, real-component browser 64/64 (Chinese and English, light / dark themes, wide / narrow and touch viewports). Desktop Subagent / Workflow 2/2, see `desktop-e2e-20261113-082400-552`, and after the terminal fix to the refresh wait 1/1, see `desktop-e2e-20261113-082757-520`. The earlier terminal failure was caused by the test changing the new-draft isolation assertion by mistake, and the one after that waited only for the pane to mount after refresh and not for the snapshot. The root and CLI package type checks, E2E types, lint and architecture passed. The CLI summary command ran the original lint admission with the equivalent package-level typecheck and a temporary pnpm JS forwarder, and no engineering script was modified. Goal / Todo had no real model end-to-end acceptance, and real phones were not run.

### Activity details and history entry stages (2026-11-13)

This rule replaces the permanent display of Activity finished details. The always-shown rule of Goal and Todo is unchanged.

| Stage                                      | Capsule                                                                                                               | Popover                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The current turn has running items         | Running avatars take slots first, shown with completed on the left and running on the right. Active N                 | Current running items and the finished details of this turn                                             |
| All items of the current turn finished     | Avatars / icon and their own result badges. Failed N comes before Completed N, and all stopped keeps the stop summary | Finished details of this turn. When history of the previous turn exists, the matching catalog shows too |
| The next real user message is accepted     | Finished details fold, and still-running items stay                                                                   | Openable catalogs by folded sub-agent / workflow identity, shown together with this turn's details      |
| Only history catalogs left                 | Completed N (0 with no successful items). Available successful avatars and badges are kept                            | Only the catalogs, with no blank divider on top                                                         |
| Only terminal history, no openable catalog | Hidden                                                                                                                | No empty panel is generated                                                                             |

The Agent records the boundary of finished activity identities at the real input accepted event, and the full data and catalog records are not deleted. A send failure and system continuation do not advance the boundary. After a new execution or after the same identity resumes, the details of this turn are shown again. Desktop and phone recover through the same snapshot / delta. The catalog entry is bounded by the host ability and no entry that cannot be operated is shown. The history count does not enter the running count. The two kinds of catalogs that already entered history show independently. New running items or finished details of this turn cannot hide an existing catalog. When there are only records of this turn and no archived identity yet, the catalog is not shown ahead of time.

```text
This turn's results -> next successful input -> fold finished details -> history catalog entry
Still running -> keep running state -> new result -> this turn's results
```

Acceptance: stage switching for completed / stopped / failed of the three result kinds. Continuous sends, failed sends, refresh and restart. Running and history mixed. Resuming the same child / run. No empty capsule without a catalog host / terminal-only. Passed: Agent projection and related regressions 289 cases, real-component browser 67 cases (including light / dark themes, wide / narrow / touch viewports and the no-catalog boundary), desktop terminal / Subagent see `desktop-e2e-20261113-084740-671`, and Workflow see `desktop-e2e-20261113-085159-611`. The first Workflow failure was an old case that looked up the catalog in the this-turn-results stage, and it passed after the assertion was migrated. Root / CLI types, E2E types, lint, architecture and format checks passed. Real phones were not run.

### Fix for history entries coexisting with this turn's results (2026-11-13)

Root cause: the shared condition `endedActivities.length === 0` made this turn's terminal or newly completed item hide the history catalog of the previous turn. The catalogs now read the folded subagentIds / workflowRunIds of the Agent separately and combine them with the existing catalog counts and the host ability. An existing history entry keeps showing after this turn adds results, and the first completion does not show a catalog ahead of time. One divider is kept between the details and the first catalog, and there is no top divider with the catalog only. The rules for no history, an unsupported catalog, running counts and result badges are unchanged.

Regression: two catalogs of the previous turn plus a terminal finished in this turn. With only one kind archived, the other catalog is not shown ahead of time. Both catalogs are clickable, across wide / narrow screens and light / dark themes. The browser suite passed 72 cases, and the desktop Workflow regression passed with evidence `desktop-e2e-20261113-091404-466`. Real phones were not run.

CR-01 cold restore adds old children: the Agent seed also fills in the archived identities within the accepted input boundary and keeps the history records. The UI keeps consuming the same archive projection, old results are reached only through the catalog, results after the boundary still show as this turn's details, and continuous input and another cold restore do not change the archive stage.

The Chinese main label of the Activity capsule uses the Chinese word for "active", while English stays "Activity". Only `chat.capsule.activityLabel` is adjusted, and other activity area copy and status semantics are unchanged.

CR-01 verification: CLI projection and publisher regression 345 cases, browser 78 cases, desktop Subagent lifecycle and two restarts passed (`desktop-e2e-20261113-094900-803`). The root types, CLI package types, root / CLI lint, architecture and format checks passed. The CLI top-level entry is limited by the lack of Turbo and a runnable pnpm format on this machine, so the original per-package type scripts and the same lint entry were used. The exact orphan seed scenario is covered by CLI tests. Real phones were not run.

### Independent Activity avatar state (2026-11-13)

Capsule avatars consume the state of their own Subagent or Workflow actor one by one, and the result badge shared by the avatar group is removed. An independent Subagent uses a check / gray round square / exclamation mark for completed / cancelled / failed. A Workflow actor keeps the three protocol states waiting / running / completed, where completed means the work is settled, and no actor-level error or stop is made up from the run result. Each avatar badge is drawn in the same proportion inside the existing 16px avatar, and the stacking raises the level from left to right and allows overflow, so avatars in front or behind do not cover the badges. A terminal without an avatar still keeps the monitor-activity result badge. The overall capsule count, status text and lifecycle are unchanged.

Acceptance of the independent Activity avatar badges: 86 real-component browser cases passed, including each completion badge of three avatars being visible, mixed completed / running / waiting states, the three result types of an independent Subagent and light / dark themes. Screenshots are in `composer-status-capsules-browser/all-actor-badges-{light,dark}.png`. Types, lint, architecture and format checks passed. The phone is a browser touch viewport and no real device was run.

The full-width conversation layout keeps `w-full max-w-6xl`. The clickable area of the left turn navigation must sit inside the reserved space to the left of the body and must not intercept clicks on links at the start of a line or text selection. The old responsive body width limit is not restored for the navigation. The horizontal lines are all left-aligned and stretch to the right with the left end as the scale origin. The navigation is 12px from the left edge of the conversation, the hit area stays 24px, the lines are at most 24px, and the left edge does not move as the length changes. On a wide screen with at least two queries and the navigation not hidden by share selection, the body scroll area gets 12px of extra left whitespace, so that the navigation does not intrude into the body after the spacing is restored. The phone gets no extra whitespace.

## Capsule navigation and catalog loading (2026-11-13)

- When opening background output, a sub-agent, a workflow or a history catalog from Activity, and when opening a file / all changes from Git, the current capsule popover is closed first and then navigation happens. A hidden child session tab is still mounted, so closing the popover cannot rely on unmount cleanup.
- Navigation does not change task state or output ownership. In-place actions such as pause, resume and stop do not close the popover.
- The workflow catalog tells loading, success (including an empty list) and unavailable apart. While a query is unfinished a generic loading text is shown and no unavailable hint is shown. An expired request must not overwrite the query of the current session.

### Cold restore fault boundary (2026-11-18)

- When orphan run convergence only changes the journal row, the cold replay settlement is a synthetic state and not a real journal event. It may update the stop preview but must not take the next real event sequence number or advance the real event de-duplication watermark. The start event that resumes the same run must enter the projection, the running state and the stop action recover at once, and the final success is counted only once.
- A failure to read the full activity summary affects only the full count and cannot block the recovery of the transcript, the detailed run replay and the live buffer. The bridge records a warn with the sessionId. `completedActivityCount: null` means the full number is unknown, and the preview count or 0 must not be taken as the full success count. The completed summary shows no number for now, and the existing count and stop semantics of running / failed are unchanged. A missing field is kept only for old CLI compatibility. After the full seed is obtained again the number is restored, with no timer retry or UI cache.
- Regression: SQLite interrupted after updating only the row, then reopened and resumed the same run, verifying the start, the stop entry and one success. A summary read exception was injected, verifying that the history and the live tail are kept, the warn can be located, and snapshot / delta keep the unknown state until the full recovery. Desktop continuous and mobile replayable share the projection, and the browser verifies the unknown count in two themes and wide / narrow viewports.

Cold restore first frame and mixed results addition (2026-11-18): a history-first first frame that has persisted history but no runtime record yet must explicitly mark the full count as unknown, while a newly created empty session is still 0. An initialization failure and a reconnect keep the unknown state and the history body, and after ready the exact value is restored from the full seed. Whether the total is known does not decide the success state already observed: with no running / failed items and some success results, "Completed" is shown, and when the total is unknown no number is shown. The stop summary is kept only when everything is stopped and there is no known success. Failures are still shown by the existing priority with their count. The regression covers the first frame / failure / retry ready of both delivery profiles, and the mixed unknown + success-stop / stop-only / failure cases.
