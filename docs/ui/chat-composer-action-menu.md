# Chat Composer Action Menu

Product requirement: [PRD] add plugin and context entries to the composer add button: https://internal-docs.example.invalid/redacted

## Product contract

The `+` on the left of the composer opens a Popover as wide as the composer, reusing MentionPanel and the candidate row component.

| Order | Category      | Content and selection behavior                                                                                                                                                                                                                                                                                            |
| ----- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Add           | Attachment calls the existing attachmentAction. Goal appears only in a new conversation with empty input and inserts the same command tag as `/goal`. Workflow follows goal, appears in any conversation with empty input when the CLI slash catalog contains `workflow`, and inserts the same command tag as `/workflow` |
| 2     | Plugins       | Same catalog, ordering and enabled filter as an empty `@`; conflicting items stay unselectable                                                                                                                                                                                                                            |
| 3     | Files         | Current workspace, files first, same kind sorted by relative path, at most 10 items for an empty query                                                                                                                                                                                                                    |
| 4     | Conversations | Current workspace, updatedAt descending, createdAt descending, then title; does not extend to the cross-project scope of `#`                                                                                                                                                                                              |

Files and conversations are hidden when there are no candidates and no loading/error state. Plugins keep an empty state. Whiteboards are not in this menu. A new draft reads the workspace's current plugin catalog and an existing session reads the session-owned catalog, with the lifecycle of `@`.

## Interaction and layout

- `/goal` is currently parsed as a command only at the start of the message; an existing session or non-empty draft hides goal, avoiding an invalid command inserted mid-text.
- `/workflow` is a custom command of the built-in zcode-guide plugin and likewise expands only at the start of the message (the `^\/` pattern in `custom-command-prompt.ts`); a non-empty draft hides workflow. It is not bound to session-level state, so new drafts and existing sessions both offer it; when the catalog lacks `workflow` (plugin disabled) it is hidden, so bare text the CLI would not expand is never sent to the model.
- Clicking a candidate closes the menu and inserts the tag at the cursor position before the menu opened; text on both sides of the cursor is kept, and selected text is replaced. Focus then returns to the editor.
- Attachments use the existing platform selection chain; mobile remote control hides the attachment item when it provides no attachmentAction.
- Up/Down cycle and skip unselectable items, Enter/Tab/Space select, Escape/click outside close.
- The bottom row lists `@ 添加上下文` (add context), `/ 选择能力` (choose capability), `$ 选择技能` (choose skill) and `输入内容以搜索插件、文件和对话` (type to search plugins, files and conversations); it wraps on narrow screens and is internationalized in Chinese and English.
- The hints are explanatory text, not menu candidates. `+` adds no search box; searching still happens through the editor trigger characters.
- The candidate scroll area is at most 24rem and shrinks to the Popover's available height; the original `@`, `/` and `$` panel heights are unchanged.
- Uses theme tokens; the composer's always-on actions remain `+`, permission/mode selection and the remaining slots.

## Data and boundaries

```text
+ opens -> save Lexical selection -> existing providers read candidates
           select candidate -> restore selection -> insert canonical mention -> focus editor
           select attachment -> original platform attachment flow
```

The shared editor covers desktop, Web and mobile. `workspaceIdentity` is passed through; the file execution path stays `workspacePath`. This change only affects the candidate entry and draft editing; it adds no protocol, Host/runtime, persistence or send logic, and the boundary between desktop-continuous and web-remote-replayable is unchanged.

Review boundaries:

- Goal obeys `excludedSlashCommandNames` (including goal being disabled in selection side chat) and is offered only for a strictly empty-string draft, not a whitespace-only one; an empty Add section is hidden.
- If the draft is replaced while the popover is open, a stale selection node is not restored; the insertion goes to the end of the current draft instead.
- The menu snapshots at open time whether the draft is empty (the same snapshot as goal); goal and workflow items follow the snapshot so candidate shifting while open does not disturb keyboard selection.
- A custom anchor must not be overridden by the default button anchor, and the menu must not collapse to zero width after the old button unmounts (verified by opening four times in a row and asserting it is as wide as the composer).
- The old export for SG-03 was removed after `dep:refs` confirmed it was referenced only by its own test; the attachment copy is supplied by the caller and consumed in the menu.

## Acceptance coverage

- PLUS01: Add/Plugins/Files/Conversations grouping, candidate order, disabled menu and platform attachment boundary.
- PLUS02: goal visible only in a new conversation with empty input; plugin/file/conversation selection keeps text on both sides of the cursor; canonical markdown matches the original entry.
- PLUS03: keyboard skips unselectable items, Escape closes, the attachment callback runs once.
- PLUS04: desktop horizontal footer, taller list, no horizontal overflow on narrow screens.
- PLUS05: workflow follows goal; visible for an empty draft, hidden for a non-empty one; selecting inserts `/workflow` and stays at the start of the message.

Component test: `packages/ui/test/chatPromptActionMenuInteraction.test.ts`. Electron candidate case: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-plus-menu.test.ts`. The new case has not had human acceptance or formal promotion and is not claimed to be in the Docker/CI suite. The formal `conversation-session-v4-mention.test.ts` also verifies the bottom hint and the manual-trigger path. The coverage audit checks only the directory/matrix contract and does not run E2E.

Verification summary (2026-09-08/09): focused UI tests, related workspace tests, the Electron pending E2E (target visible only in a new empty conversation, plugin reference/Escape, wide and narrow layout, provider capture empty after each) and `pnpm typecheck`, `typecheck:e2e`, lint, fixture check, coverage audit all passed. Full-repo `pnpm fmt:check` did not pass because of existing repository-wide format differences and a parse error in sample HTML under `docs/electron/docs/fiddles/`; unrelated files were not changed. Real mobile remote control and Windows/Linux were not verified; no human promotion or Docker suite was run.

## Conversation list read range

The frontend does not truncate sessions-index candidates, but it does not read all historical bodies either. CLI cold start reads at most 200 unarchived lightweight summaries for the current workspace and merges loaded runtime sessions; this is not a permanent total cap. The sidebar and mention reuse subscriptions per endpoint/workspace; the menu uses a virtual list to bound the DOM. Showing the first 5 in the frontend only reduces candidate processing/browsing and does not replace backend paging or search.

## Workflow entry (2026-09-11)

Interview decisions:

| Question                           | Decision                                                                                                                                     | Boundary fixed                                                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source of the workflow item        | **CLI slash catalog decides**: it appears only when the workspace's `slashCommands` contains `workflow`                                      | Follows the existing ruling that the command catalog is authoritative from the CLI; the UI hard-codes no second command source. Goal stays hard-coded as before (it has a session-level semantic gate unrelated to the catalog)            |
| When offered                       | **Empty draft, any conversation** (new drafts and existing sessions)                                                                         | `/workflow` expands only at the start of the message, so a strictly empty-string draft is required (same criterion as goal); unlike goal it is not limited to new conversations because starting a workflow mid-conversation is legitimate |
| `/` panel order                    | **CLI catalog assembly side**: `workflow` is a built-in command, and `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES` puts it after `goal` | Single data source: desktop, Web and mobile remote control see the same order; the UI adds no ordering allowlist (an earlier bugfix removed the UI-side command allowlist). Only the order changes, not source, de-dup or reserved rules   |
| `/workflow` tag icon in the editor | **lucide `Workflow`** (`WORKFLOW_COMMAND_MENTION_ICON_NODE`)                                                                                 | Same icon as the `+` menu item and the rest of dwf UI; the dedicated-icon mechanism of `/goal` and `/compact` is copied                                                                                                                    |

Data flow:

```text
CLI listProtocolSlashCommands
  builtins[goal, workflow, compact, init, dream, plan] + custom[...]
  -> fixed order [goal, workflow, compact, init, dream, plan, ...custom]   (the only ordering point; with the rollout off, builtins lack workflow)
  -> available_commands_update -> store.slashCommands
        |-- `/` panel: shown in catalog order (unchanged)
        `-- `+` menu "Add": attachment -> goal (new conversation, empty draft) -> workflow (empty draft AND catalog contains workflow)
select workflow -> insert the `/workflow` command tag (canonical same as the `/` panel) -> focus editor
```

Tests: `chatPromptActionMenuInteraction.test.ts` (order, visible in any conversation, hidden when catalog lacks it / draft non-empty / excluded name, inserts `/workflow`); `promptMentionNode.test.ts` (icon node); `apps/zcode-cli/packages/bootstrap/tests/protocol-slash-commands.test.ts` (catalog order); Electron pending case PLUS05.
