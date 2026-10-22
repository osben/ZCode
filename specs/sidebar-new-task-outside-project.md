# Sidebar: distinct names for the top "New task" and the conversation "+"

## Product rules

The project sidebar has two task-creation entries with different destinations:

- The top "New task" control (`NewTaskButtonGroup`, visible text `taskList.newThread`) creates a task in the active project. It calls `onCreateTask()` without an ownership argument, so the sidebar root inherits the current project.
- The "+" button on the conversation section (`PurposeSections`, `data-testid="virtual-project-new-task"`) creates a task outside any project. It calls `onCreateTask({ projectId: null, taskGroupId })`.

Both controls must therefore carry different accessible names and tooltip titles. The conversation "+" uses the existing `workspaceSidebar.newTaskOutsideProject` message in every locale, for both `aria-label` and tooltip title. The project "+" on the projects section keeps `project.new`.

## State owners

- Accessible name and tooltip text of the conversation "+": `packages/ui/src/project-sidebar/PurposeSections.tsx`. Presentation only.
- Creation ownership (`projectId: null` for the conversation entry, inherited project for the top entry): `packages/ui/src/project-sidebar/index.tsx`, `start()` and the `ProjectSidebarNavigation` `onCreate` wiring. This spec does not change ownership.
- Test id: the rendered button keeps `virtual-project-new-task` (`TID_VIRTUAL_PROJECT_NEW_TASK`). Upstream tests and desktop e2e rely on it. An element carries one `data-testid`, so the shared `TID_CONVERSATION_NEW_TASK` (`conversation-new-task`) is retired and is not rendered.

## Interfaces

- `ProjectSidebarProps.onCreateTask(options?)`: an omitted `options` means inherited ownership; `{ projectId: null, taskGroupId }` means outside any project.
- Locale keys: `workspaceSidebar.newTaskOutsideProject` (en-US "New task outside a project", uk-UA "Нове завдання поза проєктом", zh-CN "不在项目中新建任务"). Each differs from `taskList.newThread` and `sidebar.newTask` in that locale.

## Acceptance scenarios

1. In each of en-US, uk-UA and zh-CN, the conversation "+" has an accessible name equal to `workspaceSidebar.newTaskOutsideProject`. That name differs from the same locale's `taskList.newThread` and `sidebar.newTask`.
2. The tooltip title of the conversation "+" uses the same message as its accessible name.
3. Clicking the top "New task" calls `onCreateTask` with no arguments.
4. Clicking the conversation "+" calls `onCreateTask` with `{ projectId: null, taskGroupId: null }` in the projects view.
5. The project-row "New task" action in `ProjectNodeContent.tsx` (`project.createTask`) is unchanged.
