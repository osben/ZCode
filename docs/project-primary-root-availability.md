# Sidebar state when the project primary root is unavailable

## Behavior

When a project's configured primary directory is deleted, moved, or becomes a plain file, the project title keeps a grayed-out hint but remains expandable/collapsible by mouse, keyboard, and touch, and history messages stay viewable. The inline "新建任务" and "查看文件" buttons render disabled — no draft creation or file-tree opening. Only those two buttons show the hover hint **该项目主文件夹已被删除或移动** (this project's primary folder was deleted or moved); hovering or focusing the project row and title shows no directory-failure hint. The context menu's new-task entry and all "查看文件" entries are equally disabled. The single-root direct entry and the multi-root directory menu follow the same rule; when the primary root is unavailable, the file tree cannot be opened from the project even if additional directories exist.

The project stays in the sidebar with its unread dot; edit/delete/pin entries remain usable and the user can edit source folders. A missing additional directory does not disable the project; a zero-root project can still be created, with the Host assigning the default directory under existing rules. Existing tasks' cwd, ownership, body, and startup-restore strategy do not change.

## State and ownership

```text
项目列表首次读取 / 项目变更 / 窗口 focus
  → 所属 Host ProjectService 读取项目快照
  → 按主目录去重，异步 stat
  → VirtualProject.primaryRootStatus 只读投影
  → 侧栏接受最新请求的结果
      available / 无字段 → 正常入口
      missing            → 标题置灰但可展开；禁止新建/查看文件 + 删除或移动提示
      unavailable        → 标题置灰但可展开；禁止新建/查看文件 + 无法访问提示

标题展开 → 原折叠偏好 owner → 原任务行与历史消息读取（不依赖主目录存在）
新建请求 → 同一 Host prepareSession 再检查主目录 → 可用才返回 cwd
```

- `primaryRootStatus` is an optional `available | missing | unavailable`, derived live by the directory's owning Host. It is not persisted to SQLite/settings/remote entry caches and needs no migration. When an older Server does not return the field, old behavior applies.
- `ENOENT`, `ENOTDIR`, and a path that exists but is not a directory count as missing; other stat failures are unavailable and must not be reported as deletion.
- A zero-root project with no primary directory is not marked missing; when a configured primary root fails, the project must not re-mkdir the original path, switch to an additional directory, or fall back to a global task.
- Every readTree/readProjects re-checks; no permanent caching, no polling. After the directory is restored or the primary root edited, the next refresh restores the entries. The UI refreshes on focus and discards late responses via the request sequence number.
- prepareSession re-checks before returning cwd, rejecting a failure that occurs between refresh and click; failure does not modify project roots or existing tasks. Filesystem changes after the final check are still reported by the actual execution entry.
- Remote directories are checked only by the existing remote Host attachment; local stat of remote paths, new connections/Hosts/Agents are forbidden. Mobile shared-host reads the same state; desktop continuous and mobile replayable message-stream boundaries stay as-is.
- In both themes the title keeps its existing weakened style without directory-failure `disabled`/`aria-disabled`; the buttons themselves take keyboard focus to avoid double focus. New-task and view-files buttons keep disabled semantics. A remote offline Host keeps the existing non-expandable constraint.
- Primary-root existence gates creation and view-files only; collapse state stays with the original sidebar preference owner and is not force-collapsed on failure or recovery. History clicks reuse the existing task selection/read-only restore chain — no cwd changes and no directory recreation for read-only browsing.

## Acceptance

1. After the primary root of a single/dual-root project is moved away: the title is grayed but expandable/collapsible with real history open; inline and context-menu create/view-files are disabled with the accurate hint; with an additional directory still present, the file tree and creation stay unavailable while edit entries work.
2. After the directory is restored, a focus refresh restores entries; a missing additional directory alone or an empty project never triggers primary-root disabling.
3. Real Host unit tests verify missing/plain-file/recovery, the prepareSession re-check, and no side effects; remote routing does not probe paths locally.
4. Pending E2E `conversation-session-project-missing-primary-root.test.ts` covers real directory move/restore, window refresh, hover, context menu, both themes, and narrow layouts; narrow layout is not equivalent to real mobile shared-host verification.
