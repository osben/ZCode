# Non-project Conversation Workspace Design

## Goal

New users no longer must pick a project first, and `~/ZCodeProject` is no longer auto-created. The app uses one stable internal conversation backing workspace:

```text
workspacePath = <dataBaseDir>/.zcode/workspace/default
workspacePurpose = conversation
selectedProject = null
```

The default `dataBaseDir` is the user home, so the default path is `~/.zcode/workspace/default`. The directory provides the real cwd that Agent, session, terminal, and file tools need, but is never presented to the user as a project. All non-project conversations share this directory; per-conversation directories (and the Agent recycling, directory registry, and GC they need) are out of scope for this phase.

## State and boundaries

New `WorkspacePurpose = "project" | "conversation"`. Legacy data without the field is treated as `project`. Purpose is a product classification only and does not change workspace identity:

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

The local conversation workspace synthesizes no `workspaceIdentity` and does not change the App/Agent ZCode Protocol. The purpose field lives in app-owned workspace session, tab, task meta, task-index, and Web remote workspace descriptions so recovery, queries, and display use the same fact.

At local desktop startup, idempotently ensure the conversation backing directory first; it also serves as the Agent spawn cwd fallback for non-project conversations and for any invalidated historical workspace. When a real project exists, only create the directory — do not activate it as the current workspace. Then:

```text
ensure conversation backing directory
  -> 有可恢复 workspace session
  -> 恢复原 descriptor 与 active index

ensure conversation backing directory
  -> 无可恢复 workspace session
  -> Main 预热该路径
  -> Renderer 激活 purpose=conversation 的内部 tab
  -> composer 可直接首发
```

Main is the first-bootstrap authority; Renderer only consumes the complete descriptor, or idempotently ensures when the user explicitly switches to non-project mode. Main and Renderer must never each assign a different default directory.

## Sidebar information architecture

The top level stays `分组 / 项目`; no new top-level "任务". The `项目 + 按项目` view has two sortable second-level sections:

```text
已置顶                         仅有数据或加载中时显示
项目             [drag]    [chevron] [+]
  Workspace A
  Workspace B
任务             [drag]    [chevron] [MessageCirclePlus]
  非项目任务
```

- First run, legacy preference, or corrupt data defaults to `项目 → 任务` order; the user can reorder via the dedicated drag handle on each header, persisted in a renderer-local preference. Both headers always show and collapse independently; empty lists show「尚未打开项目」and「还没有任务」respectively.
- Drag handle, collapse trigger, and right-side actions are independent; mouse, touch, and keyboard reordering all work. Empty or collapsed sections remain movable as a whole; expansion state and content travel with the section, and workspace/task ordering or caches are not cleared.
- The header row outside the title and right-side actions is the collapse trigger: expanded shows a down chevron, collapsed a right chevron. Chevrons and actions appear on hover by default, with `focus-within`, open-menu, and no-hover-device fallbacks keeping them visible; actions are siblings of the trigger and never collapse the section.
- The `任务` right icon invokes the same `startDraft` flow with the target fixed to the conversation backing workspace — it never inherits the active project.
- Tasks under `任务` use the normal single-line row, never show the internal backing workspace's `default` directory name, and never show the meaningless plain idle gray dot; unread, error, and running states reuse the shared leading indicator.
- The `项目` right-side `+` menu contains only「打开文件夹」and「远程连接」, reusing existing Root actions; hide unavailable items by capability.
- Section expansion state and `sectionOrder` persist in renderer-local `zcode-sidebar-purpose-section-preferences`, defaulting on first run, corrupt data, or storage failure; right-side actions never change expansion state. Local preferences do not enter Host/Agent and are not required to sync live across open windows.
- Top `Expand all` / `Collapse all` controls the `项目` section and all workspace rows in the project view and never affects `任务`; collapsing a section does not clear workspace-row expansion, task caches, or DnD order.
- The global「新建任务」and its shortcut keep using the current active workspace.
- The conversation list contains only non-pinned, non-archived `purpose=conversation` tasks; default fold count and「显示更多」follow the single-workspace list.
- A pinned conversation task shows only in「已置顶」; unpinning returns it to `任务`. An archived conversation task shows only in the archive view.
- Existing `按项目 / 时间线` and `Created / Updated` preferences are kept; the timeline keeps aggregating all purposes.

Two scopes must stay split; never pre-filter task sources to hide the internal workspace:

```text
allTaskWorkspaceTargets = project + conversation
  -> pinned / conversation / grouped / timeline / archived
  -> sessions-index / service resolver / task actions

projectWorkspaceTabs = purpose=project
  -> project section / workspace DnD / expand-collapse / empty state
```

`workspaceTabs.length === 0` is never an early-exit for the whole task area. Even with no real project, the conversation backing target still participates in task queries and the Group view still mounts.

## Grouping semantics

- A normal non-project task defaults to an ungrouped top-level task in Group and can enter any normal group via drag or menu.
- Conversation tasks use the same task service as project tasks for group membership, ordering, rename, archive, and unread state.
- pinned/archived still leave the active Group list under existing membership rules; unpinning restores the original group membership.
- Workspace bootstrap generates project groups only for `purpose=project`; never generate an auto-group named `default` or the old/new user copy「对话 / 任务」for the backing path.
- Group sessions-index, structure, membership, optimistic overlay, and service lookup all use `allTaskWorkspaceTargets`.

## Composer workspace interaction

- Workspace menu order:「打开文件夹」→「远程连接」→「不在项目中工作」.
- The conversation state's trigger shows「选择项目」with no close button;「不在项目中工作」shows checked, and re-selecting it is a no-op.
- The project draft state shows an independent close button on hover / `focus-within`; clicking it switches to the conversation backing workspace, keeps the project tab open, and does not open the menu.
- The close button applies only to unsent drafts; an already created task does not migrate workspaces.
- Switching must first ensure the target workspace is available, then change the active target. On failure, keep the original workspace and draft and show a retryable error.
- Project selection uses `{ workspacePath, workspaceIdentity?, workspacePurpose }` — never match remote workspaces by path alone.
- The conversation purpose hides the Git branch selector; file tree, terminal, and copy-path keep using the real workspacePath.

## Multi-client and lifecycle

- Desktop keeps `desktop-continuous`; the conversation backing workspace reuses one local runtime.
- Mobile `/remote` keeps `web-remote-replayable` and shared-host attachment; it never creates a new local/remote Agent runtime.
- Mobile can start a new conversation when a conversation attachment exists; without one the action is unavailable with a prompt to create it on desktop first.
- Relay and desktop main gain no task/session/queue/snapshot business state.
- Closing a tab, archiving, or deleting a task never deletes the backing workspace or user files inside it.
- Multi-window mkdir, repeated clicks, and recovery must be idempotent; a path occupied by a file, insufficient permissions, or a full disk must never enter a half-activated state.
- The task section / workspace tab label for conversation purpose uniformly shows「任务」and never leaks the internal leaf name `default`; other copy (conversation flow, mobile workspace kind badge) is out of this rename except path-semantics UI.

## Accepted / pruned

Accepted: first-run direct conversation, one stable shared backing path, project/non-project draft switching, second-level `任务/项目` sections, no-project task pinned/grouped/timeline/archive behavior, Desktop/Mobile shared-host boundaries.

Pruned: per-conversation directories, migrating existing tasks between projects, a mobile-created separate runtime, disguising conversation as a project workspace, path-prefix matching instead of an explicit purpose.
