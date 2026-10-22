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

## Draft lifetime (global "New task outside a project")

The sidebar entry `onCreateTask({ projectId: null })` starts a root draft whose project scope is
`null`. That scope is the single owner of the draft's project identity until another explicit
start replaces it.

Rules:

1. **Model resolution is symmetric.** A `null`-scope root draft resolves its initial model exactly
   like a project draft: its own scoped Recent first (`zcode-composer-recent:v2:<scope>`), then the
   Host view's `preferredSelection`. A Recent from another scope is never used as a fallback, so an
   empty model picker means the Host view has no completable model, not that the scope differs.
2. **`projectId = null` is carried by prewarm and create.** A prewarm generation captures the
   project scope when it starts. Its `createSession`, including every bounded retry, carries that
   captured value (`null` for the global draft). It never re-reads `draftProjectId` from the store
   at dispatch time, so a later store value cannot change the target of a generation that was
   started for another scope. A scope change retires the current generation before a new one starts.
3. **A blocked Send names its reason.** A Send with content that is refused by
   `resolveComposerSubmitBlockReason` shows a notice that names the reason (`composer.sendBlocked.*`).
   It never returns silently.
4. **Recent is written only by accepted submissions** of the same scope. A prewarm `createSession`
   without `firstInput` does not own the pending task draft; only the first submission or the send
   that follows it does.

Acceptance scenarios:

- A global draft with a valid Host preferred selection and no scoped Recent starts with that
  selection, the same as a project draft with no Recent.
- A prewarm `createSession` for the global draft is dispatched with `projectId = null` on its first
  attempt and on each retry, even after the store's `draftProjectId` has changed to a project id.
- Switching the pane to a project scope retires the global generation; the new generation's
  `createSession` carries the project id.
