# Agent row context menu (subagent trajectory)

Status: approved 2026-10-24 (user decision). Owner: `packages/ui/src/v4/ConversationAgentToolCallRow.tsx`.

## Product rules

1. Right-clicking a paired subagent row (an Agent/Task tool call with a `childSessionId`) in the conversation opens a context menu with two items:
   - **Trajectory** (labelled with the existing `taskList.viewModelTrajectoryV2` key, "View model trajectory v2", like the header and sidebar entries): opens the model trajectory v2 side-pane tab for the child session (`useModelTrajectoryStore.requestOpen({ taskId: childSessionId, workspaceKey, title, kind: "v2" })`, the same request the header and sidebar send for a task). The child writes its own `model-io-<childSessionId>.jsonl`, and the host reads the trajectory by session id, so no new protocol or host method is needed.
   - **Copy session ID**: copies the child session id (`appHeader.copySessionId` label, existing copy helper).
2. Shown only on desktop for local workspaces. The trajectory reader reads files on the machine that runs the app, so a remote workspace would read the wrong machine; mobile web keeps long-press for selection. Rows without a `childSessionId` keep the native menu.
3. When the user has a text selection inside the row, the native menu is kept (Copy stays available).
4. Left click is unchanged (opens the right-pane `subagent-session` tab). The token and duration numbers are unchanged (user decision: values are correct; no display change).

5. Keyboard: Shift+F10 or the Context Menu key on a focused element inside an eligible row dispatches `contextmenu` and opens the same menu.
6. The row is always wrapped in the menu trigger (ineligible rows pass `disabled`), so the row subtree never remounts when its child session id arrives mid-run.

## Acceptance

1. Right-click a finished subagent row → menu with Trajectory and Copy session ID; Trajectory opens a `model-trajectory-v2:<childSessionId>` tab showing the child's calls.
2. Copy session ID puts the child id on the clipboard.
3. A remote workspace or mobile web row shows no custom menu; a row with a text selection shows the native menu.
4. Shift+F10 or the Context Menu key with focus inside an eligible row opens the same menu.
5. A running Agent row keeps its expansion state when its child session id arrives.
