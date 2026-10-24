# 05 — Settings Safeguards, Edit Connection and Scope Labels

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** none.

**Behavior to deliver:**

- **Safer dangerous actions**:
  - Destructive confirmation dialogs focus "取消" (cancel) by default; Enter does not trigger the confirmation.
  - The remove-device dialog states which open projects will be disconnected, with consistent wording in title and button.
  - Disconnecting a device shows no confirmation dialog, but states "远端任务会继续运行" (remote tasks keep running).
- **Clearer action feedback**:
  - A running button cannot be clicked again.
  - No empty state before loading finishes; the empty state offers a "新建连接" (new connection) button.
  - A toggle rolls back when saving fails.
  - The "last online" time is accurate.
  - "在侧边栏中显示" (show in sidebar) locates the corresponding device.
  - "重新安装并连接" (reinstall and connect) carries this device's information.
  - The same error is not shown twice.
- **Edit connection**:
  - The edit dialog's fields and controls match the new-connection form.
  - Connection name and device name are edited separately.
  - Saving shows a loading state, failure shows the real reason, and the copy truthfully says "下次连接时生效" (takes effect on next connection).
- **Scope labels**: the device name is kept only in the scope menu; the "currently editing" hint row is removed from settings sections and the edit form.

It corresponds to the "Settings: remote devices" section of the parent spec (feedback and state, confirmation dialogs, scope labels) and the edit-connection dialog part of the "connection wizard" section.

Scope:

- **App-wide change**: the default focus and Enter behavior of destructive confirmation dialogs apply to all destructive confirmation dialogs in the app.
- **Scope label coverage**:
  - General, plugins, MCP, skills, commands, hooks and sub-agents show no separate machine hint row.
  - Docker workspaces are covered too.
  - Applies to desktop and mobile, light and dark themes, Chinese and English; the list and the edit form agree.
  - The scope menu spells out the device name; remote workspaces no longer use a monitor icon.
- **Scope rules unchanged**: which machine each section "follows" is not changed in this round.
- **Edit connection fields**: host, authentication segmented buttons, alias, resource download method and private key file selection.

Acceptance criteria (all met):

- **Destructive confirmation dialog**: default focus on "取消", Enter does not confirm. Covered by dialog tests, with regression over other destructive dialogs in the app.
- **Remove and disconnect**: the remove-device dialog lists the projects that will be disconnected with consistent wording; disconnecting shows no dialog and uses an inline note instead.
- **Button and state feedback**: a running button shows a busy state and cannot be clicked again; loading and empty states are clearly distinguished; a toggle save failure rolls back with a hint. Covered by settings panel component tests.
- **Locate and reinstall**: "在侧边栏中显示" locates the device's project; "重新安装并连接" prefills this device's information; the "last online" time is accurate.
- **Edit dialog**: fields match the new-connection form; changing the connection name does not change the device name; saving shows a loading state and failure shows the real reason.
- **Scope labels**: sections and forms show no "currently editing" hint row, and the scope menu keeps the device name. Component and E2E assertions are synced to this behavior.
- **Update spec**: the Settings and edit-connection paragraphs in the UX spec are updated to the latest behavior; Settings-related E2E cases are synced.
- **Required checks**: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected E2E all pass before the local commit.
