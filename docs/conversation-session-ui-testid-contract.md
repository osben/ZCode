# Conversation Session UI Test ID Contract

Goal: a stable, engineering-grade UI locating protocol for conversation-area MVP E2E. WDIO must assert product behavior through `data-testid` and explicit DOM state, never through screenshots, CSS classes, visual position, or volatile copy.

## Existing rules

The single source of test ids remains:

- `packages/shared/src/test-ids.ts`
- `docs/testing/testid-audit.md`
- `docs/architecture/architecture.md`

- All `data-testid` constants are declared in `packages/shared/src/test-ids.ts`.
- The constants are imported only from `@zcode/shared/test-ids`; the root entry `@zcode/shared` does not export them. The workflow family `test-ids-workflow.ts` still imports from the root entry. Reason: see the affected-unit-test section of the [pre-push notes](testing/pre-push-hook.md).
- New constants must carry a Chinese comment.
- UI components must not hardcode test id strings.
- E2E uses `sel(tid)` from `packages/desktop/test/e2e/helpers/selectors.ts` or an equivalent helper.
- Dynamic list items use `testId(BASE, suffix)`.

## Assertion principles

Screenshots are not a pass criterion. Screenshots and video are manual-review artifacts after failure only.

MVP UI verdicts come only from these deterministic signals:

| Signal                        | Purpose                      | Examples                                                  |
| ----------------------------- | ---------------------------- | --------------------------------------------------------- |
| `data-testid`                 | Locate stable elements       | queue item, message, compact marker                       |
| `data-state`                  | State-machine projection     | `running`, `completed-interrupted`, `compacting`          |
| `data-status`                 | Operation outcome            | `queued`, `started`, `completed`, `failed`, `interrupted` |
| `data-role`                   | Message role                 | `user`, `assistant`, `tool`, `timeline`                   |
| `data-session-id`             | Which session owns element   | active session, message list, queue panel                 |
| `data-message-id`             | Message identity             | fork target, edit target                                  |
| `data-queue-item-id`          | Queue item identity          | send-now, edit, remove, reorder                           |
| `aria-disabled` / `disabled`  | Whether an action is allowed | fork/edit/compact/send buttons                            |
| input value / normalized text | User input and content       | queue item text, composer value                           |

Copy may be asserted as content but never used for locating. Asserting that a queue item's text contains “继续解释” is fine; locating a button with `button=继续解释` is not.

### V4 canonical materialization

V4 formal E2E reads the product protocol materialization, not the old M3/M4 debug row copy:

- `TID_V4_ROW-*` timelineMarker roots expose `data-row-kind="timelineMarker"`, `data-marker-type`, `data-status`; compact additionally exposes `data-origin`. The V4 compact terminal vocabulary is `success/failed/noop/cancelled`; the old UI's `started/completed` is legacy mapping context only.
- `TID_CHAT_SUMMARY_PANEL` is the unified shell for goal/background. Both `mini` and `panel` must expose `data-goal-status`, `data-goal-objective`, `data-running-background-count` on the shell; whether the detail region is mounted must not affect reading authoritative state.
- V4 timeline raw projection window, raw total, and logical turn render units use distinct attributes: `data-window-row-count`, `data-total-row-count`, `data-render-unit-count`. Mounted units are counted via `data-v4-turn-unit`; never pass off a `[TID_V4_ROW-*]` count as the virtual item count.
- Inline edit is driven by `TID_V4_EDIT_INPUT/SUBMIT/CANCEL + rowId`; the main composer value is not the edit newText.

## Dynamic suffix rules

Dynamic test id suffixes must be stable, correlatable, and never derived from volatile display copy.

| Object             | Suffix source                                       | Forbidden                 |
| ------------------ | --------------------------------------------------- | ------------------------- |
| session/task       | `sessionId` / `taskId`                              | session title, list index |
| message            | `messageId`; stable `turnIndex` fallback if absent  | message body, DOM index   |
| queue item         | `queueItemId`                                       | queue text, DOM index     |
| compact marker     | `inputId` preferred; compact `operationId` fallback | displayed time text       |
| model/thought item | config option value                                 | translatable label        |
| toast/error        | stable reason code                                  | translatable copy         |

To verify ordering, do not encode order into test ids. Query the list with one selector, then read each element's `data-queue-item-id` or `data-message-id` sequence.

## Required test ids

Constants needed or confirmed for MVP cases. Reuse existing constants; add missing ones to `packages/shared/src/test-ids.ts`.

### Login and model preconditions

Conversation-area E2E cannot assume an empty project just works. The MVP compact case follows the user path:

1. On the welcome page click `TID_LOGIN_USE_API_KEY_BUTTON` to enter API Key login.
2. Fill the test API Key into `TID_LOGIN_API_KEY_INPUT`, click `TID_LOGIN_API_KEY_CONTINUE_BUTTON`.
3. In the workspace, configure a DeepSeek API Key in model provider settings.
4. Back in the conversation area, switch to `deepseek-v4-flash`.

This precondition chain is itself product protocol: tests must not bypass the welcome page by writing login state directly, unless the case explicitly targets non-UI service verification.

| Constant                             | Element                           | Required attributes              |
| ------------------------------------ | --------------------------------- | -------------------------------- |
| `TID_LOGIN_USE_API_KEY_BUTTON`       | Welcome-page API Key login entry  | `disabled`                       |
| `TID_LOGIN_API_KEY_PROVIDER_TRIGGER` | API Key login provider selector   | current provider value           |
| `TID_LOGIN_API_KEY_PROVIDER_ITEM`    | API Key login provider option     | dynamic suffix = provider choice |
| `TID_LOGIN_API_KEY_INPUT`            | API Key input                     | value                            |
| `TID_LOGIN_API_KEY_CONTINUE_BUTTON`  | API Key login continue button     | `disabled`                       |
| `TID_LOGIN_API_KEY_CANCEL_BUTTON`    | API Key login cancel button       | `disabled`                       |
| `TID_LOGIN_API_KEY_SKIP_BUTTON`      | API Key login skip-for-now button | `disabled`                       |
| `TID_LOGIN_API_KEY_ERROR`            | API Key login error message       | normalized text                  |

`TID_MODEL_PROVIDER_NAV_ITEM` in model provider settings must expose `aria-selected` and `data-state`. When E2E selects DeepSeek, GLM, or another provider it may only read `aria-selected="true"` or `data-state="selected"` — never infer selection from CSS classes such as `border-*` / `bg-*`.

When the chat toolbar model selector is two-level, provider groups expose `TID_CHAT_MODEL_SELECT_GROUP` with a dynamic suffix of the provider group key (for example `provider:e2e-deepseek`). E2E must open the provider group first, then select `TID_CHAT_MODEL_SELECT_ITEM`; do not read "no model items in the top-level menu yet" as "model unavailable".

### Root container and state

| Constant               | Element                  | Required attributes                                                                                                                                                                        |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TID_CHAT_VIEW`        | Conversation detail root | `data-session-id`, `data-state`, `data-queue-count`, `data-target-id`, `data-target-objective`, `data-target-status`, `data-runtime-status`, `data-active-input-id`, `data-stop-requested` |
| `TID_CHAT_MESSAGES`    | Message list             | `data-session-id`                                                                                                                                                                          |
| `TID_CHAT_INPUT`       | composer input           | value                                                                                                                                                                                      |
| `TID_CHAT_SEND_BUTTON` | send button              | `disabled`                                                                                                                                                                                 |
| `TID_CHAT_STOP_BUTTON` | stop button              | `disabled`                                                                                                                                                                                 |
| `TID_CHAT_LOADING`     | generating indicator     | `data-session-id`                                                                                                                                                                          |

### Messages and turns

| Constant                                      | Element                                  | Dynamic suffix              | Required attributes                                                            |
| --------------------------------------------- | ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `TID_CHAT_TURN`                               | turn group container                     | `turnIndex`                 | `data-turn-index`, `data-session-id`                                           |
| `TID_CHAT_MESSAGE`                            | single message container                 | `messageId`                 | `data-message-id`, `data-role`, `data-turn-index`                              |
| `TID_CHAT_USER_MESSAGE`                       | user message container                   | `messageId`                 | `data-message-id`                                                              |
| `TID_CHAT_ASSISTANT_MESSAGE`                  | assistant message container              | `messageId`                 | `data-message-id`                                                              |
| `TID_CHAT_ASSISTANT_HISTORY_TRIGGER`          | assistant history collapse trigger       | `historyStateKey`           | `data-history-state-key`, `data-history-open`, `data-history-has-content`      |
| `TID_CHAT_ASSISTANT_HISTORY_CONTENT`          | assistant history collapse content       | `historyStateKey`           | `data-history-state-key`, `data-history-open`                                  |
| `TID_CHAT_TOOL_MESSAGE`                       | tool message container                   | `messageId` or `toolCallId` | `data-tool-call-id`                                                            |
| `TID_CHAT_TOOL_CALL_BLOCK`                    | tool call block inside assistant message | `toolCallId`                | `data-tool-call-id`, `data-tool-name`, `data-status`                           |
| `TID_CHAT_TIMELINE_MARKER` / `TID_V4_ROW`     | timeline marker                          | marker id / rowId           | `data-row-kind`, `data-marker-type`, `data-status`; compact adds `data-origin` |
| `TID_CHAT_COMPACT_MARKER`                     | compact marker                           | `inputId` or `operationId`  | `data-trigger`, `data-status`, `data-operation-id`, `data-input-id`            |
| `TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON` | change summary undo/reapply button       | `messageId`                 | `data-message-id`, button label                                                |

### Compact marker minimal loop

A manual `/compact` success is the first conversation-area E2E case verified end to end. Automated pass requires all of:

- `TID_CHAT_COMPACT_MARKER` appears with `data-status="started"`, `data-trigger="manual"`.
- The same marker identity later updates to `data-status="completed"`. If agent lifecycle events swap the `operationId` from the local optimistic id to the real operation id, `data-input-id` stays constant; the test correlates started and completed via `data-input-id`.
- Marker copy may change with i18n and is not part of locating; the current Chinese strings “正在压缩上下文” and “上下文已自动压缩” are manual-review hints only.
- The network layer must capture one logical compact attempt: the first physical provider request uses `stream:true`; on stream success there is only the streaming leg; on an eligible stream failure the same logical attempt may append a non-stream fallback leg. Every compact provider request must carry the main session content and the `CRITICAL: Respond with TEXT ONLY` compaction instruction.
- The `session/compact` ACK is not success evidence; success evidence is a later `context_compaction` timeline event / snapshot with `status="completed"`.

### Queue

| Constant                            | Element                     | Dynamic suffix | Required attributes                             |
| ----------------------------------- | --------------------------- | -------------- | ----------------------------------------------- |
| `TID_CHAT_QUEUE_PANEL`              | queue panel                 | none           | `data-session-id`, `data-auto-drain`            |
| `TID_CHAT_QUEUE_ITEM`               | queue item                  | `queueItemId`  | `data-queue-item-id`, `data-kind`, `data-index` |
| `TID_CHAT_QUEUE_ITEM_CONTENT`       | queue item content          | `queueItemId`  | normalized text                                 |
| `TID_CHAT_QUEUE_SEND_NOW_BUTTON`    | send-now button             | `queueItemId`  | `disabled`                                      |
| `TID_CHAT_QUEUE_EDIT_BUTTON`        | edit queue item button      | `queueItemId`  | `disabled`                                      |
| `TID_CHAT_QUEUE_EDIT_INPUT`         | queue item edit input       | `queueItemId`  | value                                           |
| `TID_CHAT_QUEUE_EDIT_SAVE_BUTTON`   | save queue item edit button | `queueItemId`  | `disabled`                                      |
| `TID_CHAT_QUEUE_EDIT_CANCEL_BUTTON` | cancel queue item edit      | `queueItemId`  | `disabled`                                      |
| `TID_CHAT_QUEUE_REMOVE_BUTTON`      | remove queue item button    | `queueItemId`  | `disabled`                                      |
| `TID_CHAT_QUEUE_DRAG_HANDLE`        | reorder drag handle         | `queueItemId`  | `aria-disabled`                                 |

### Message actions

| Constant                       | Element                | Dynamic suffix  | Required attributes                                               |
| ------------------------------ | ---------------------- | --------------- | ----------------------------------------------------------------- |
| `TID_CHAT_MESSAGE_FORK_BUTTON` | fork assistant button  | `messageId`     | `disabled` / `aria-disabled`                                      |
| `TID_CHAT_MESSAGE_EDIT_BUTTON` | edit user query button | `messageId`     | `disabled` / `aria-disabled`                                      |
| `TID_CHAT_MESSAGE_EDIT_INPUT`  | edit input             | `messageId`     | value                                                             |
| `TID_CHAT_MESSAGE_EDIT_SUBMIT` | edit submit button     | `messageId`     | `disabled`                                                        |
| `TID_CHAT_MESSAGE_EDIT_CANCEL` | edit cancel button     | `messageId`     | `disabled`                                                        |
| `TID_V4_HOOK_DETAILS_TRIGGER`  | turn-end hook details  | `productTurnId` | `aria-label`, `aria-expanded`                                     |
| `TID_V4_HOOK_DETAILS_CONTENT`  | hook details popover   | `productTurnId` | event/tool, source and status text; no commands or absolute paths |

A tool call is not a standalone message; it is a structured block inside an assistant message. To verify "tool cannot be edited / forked", locate `TID_CHAT_TOOL_CALL_BLOCK` and assert it has no `TID_CHAT_MESSAGE_EDIT_BUTTON` or `TID_CHAT_MESSAGE_FORK_BUTTON` descendant. The assistant message itself may still show fork per assistant rules; that does not mean the tool block can be forked.

Current failing probe: `conversation-session-tool-actions.test.ts` proved the persistence layer holds the tool part, but the conversation page DOM does not render `TID_CHAT_TOOL_CALL_BLOCK`. This contract is therefore an acceptance target for the future UI projection fix, not a satisfied state.

### Command feedback

By default a positive conversation E2E must assert that `TID_CHAT_ERROR_BANNER` is absent. If a case intentionally covers error recovery, provider/network fault, permission failure, or another negative path, its case doc must explicitly allow the error banner and assert the error cause and recovery state. "Error banner appeared but the flow eventually continued" does not make a positive case pass.

| Constant                | Element                                             | Dynamic suffix                                                    | Required attributes                                                   |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `TID_CHAT_TOAST`        | toast container                                     | reason code                                                       | `data-reason`, `data-severity`                                        |
| `TID_CHAT_ERROR_BANNER` | `ChatViewErrorBanner` / `ChatErrorBanner` container | none; use `data-reason` / `data-error-code` to distinguish causes | `data-reason`, `data-error-code`, `data-trace-id`, `data-dismissible` |
| `TID_CHAT_GOAL_STATE`   | goal state projection                               | session id                                                        | `data-goal-status`, `data-target-id`                                  |

### Session switching and settings

| Constant                                | Element                            | Dynamic suffix         | Required attributes                                       |
| --------------------------------------- | ---------------------------------- | ---------------------- | --------------------------------------------------------- |
| `TID_TASK_ITEM`                         | session/task list item             | `sessionId` / `taskId` | `data-session-id`, `data-active`, `data-state`            |
| `TID_CHAT_MODEL_SELECT_TRIGGER`         | per-session model selector         | none                   | `data-session-id`, `data-model-value`                     |
| `TID_CHAT_MODEL_SELECT_GROUP`           | per-session model provider group   | provider group key     | `data-model-provider-key`, `data-model-provider-selected` |
| `TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER` | per-session thought-level selector | none                   | `data-session-id`, `data-thought-level`                   |

### Project sidebar (after the 2026-09 virtual-project refactor)

The old workspace sidebar nodes (`workspace-item` / `workspace-list` / `workspace-close` / `workspace-file-tree-button` / `conversation-new-task`) were removed together with the Group view and directory nodes, and their constants were deleted from `test-ids.ts`. E2E locates projects via `data-project-id` / `data-project-name` on the project `<section>` (an old workspace migrates into a same-named root project; project name = directory basename). Helper: `packages/desktop/test/e2e/helpers/project-sidebar.ts`.

| Constant                                                   | Value                                                   | Purpose                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `TID_PROJECT_SECTION` / `TID_CONVERSATION_SECTION`         | `project-section` / `conversation-section`              | project / task section containers (`data-slot="collapsible-trigger"` with aria-expanded)                                          |
| `TID_VIRTUAL_PROJECT_ADD`                                  | `virtual-project-add`                                   | new-project button in the project section                                                                                         |
| `TID_VIRTUAL_PROJECT_NEW_TASK`                             | `virtual-project-new-task`                              | global new-task button in the task section                                                                                        |
| `TID_VIRTUAL_PROJECT_ROW`                                  | `virtual-project-row`                                   | project row (parent section carries `data-project-id` / `data-project-name`)                                                      |
| `TID_VIRTUAL_PROJECT_TOGGLE`                               | `virtual-project-toggle`                                | project row expand trigger; `aria-expanded` shows whether the task list is expanded                                               |
| `TID_VIRTUAL_PROJECT_UNREAD`                               | `virtual-project-unread`                                | collapsed-state unread indicator                                                                                                  |
| `TID_VIRTUAL_PROJECT_TASKS`                                | `virtual-project-tasks`                                 | project row task-list container; task rows inside remain `TID_TASK_ITEM`                                                          |
| `TID_VIRTUAL_PROJECT_ACTIONS` / `TID_VIRTUAL_PROJECT_MENU` | `virtual-project-actions` / `virtual-project-menu`      | hover actions and more-menu trigger (Radix trigger; needs pointerdown gesture)                                                    |
| `TID_VIRTUAL_PROJECT_FILES`                                | `virtual-project-files`                                 | open the main directory file tree (dropdown trigger when multiple roots)                                                          |
| `TID_VIRTUAL_PROJECT_CREATE_TASK`                          | `virtual-project-create-task`                           | per-project new task (cwd = main directory)                                                                                       |
| `virtualProjectActionTestId(id, context)`                  | `virtual-project-<id>` / `virtual-project-context-<id>` | more-menu / context-menu action items: `edit`, `pin`, `delete`, `remove-entry`, `device-settings`, `create-task`, `files-<index>` |
| `TID_PROJECT_PINNED_TASKS`                                 | `project-pinned-tasks`                                  | global pinned-tasks section                                                                                                       |
| `TID_REMOTE_PROJECT_HOST`                                  | `remote-project-host`                                   | remote host group; `data-host-id` is the host id; connect button icon `lucide-plug`                                               |

Note: `packages/ui/src/project-sidebar/*` still hardcodes these strings; the constants and implementation match by value. Switching the components to the constants is outstanding src-side work.

## WDIO page objects

Conversation tests must not assemble CSS in specs. Use a conversation/session page object that centralizes locating and assertions.

Interface sketch:

```ts
chat.sessionRoot(sessionId);
chat.queuePanel(sessionId);
chat.queueItems(sessionId);
chat.queueItem(queueItemId);
chat.queueSendNowButton(queueItemId);
chat.message(messageId);
chat.messageForkButton(messageId);
chat.messageEditButton(messageId);
chat.compactMarker(inputId);
chat.expectQueueOrder([queueItemIdA, queueItemIdB]);
chat.expectNoProtocolFrame({ method: "session/compact", inputId });
```

## Correction to the validation matrix

The UI layer of the validation matrix must read "assert via test ids and DOM attributes". Screenshots and video stay in the Artifact layer and are never an automated pass condition.

Correct:

```text
UI:
  - [data-testid=chat-queue-panel] 存在
  - data-auto-drain=false
  - queue item 数量为 1
  - stop button disabled=true

Artifact:
  - 保存 final.png，供失败后人工复盘
```

Incorrect:

```text
UI:
  - 截图看起来 queue 还在
```
