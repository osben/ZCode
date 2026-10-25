# Workspace File Tree

The workspace file tree entry sits in the action area of project and task rows and can also be opened from
"Files" in the right built-in apps. The entry creates an independent file tab on the right while the left
task list stays usable. The file preview is on the left and the directory on the right; the directory width
is draggable and the divider coincides with the border. Collapsing the directory lets the preview fill the
area; expanding restores the directory width and keeps directory search, expansion state and scroll
position. The visibility the user picks with the directory toggle is persisted by
`workspaceIdentity?.trim() || workspacePath`: all file tabs and sessions of the same workspace share the
last state, restored after an app restart; different workspaces do not affect each other. Breadcrumb, file
actions and the directory toggle share one row, and the absolute project path is no longer repeated.

In narrow panels and the mobile view, directory and preview alternate; choosing a file only temporarily
collapses the directory in the current compact layout without rewriting the workspace's explicit
visibility preference, which applies again on wide screens. Tab navigation updates only the matching
instance and does not change task ownership or activate other tabs. Built-in apps are ordered Files,
Browser, Terminal, Review, Side chat; unsupported entries are still hidden by existing capability
conditions.

A cross-workspace file entry first activates the target workspace, then the target workspace's restored
side-pane owner consumes a one-shot request once; the source workspace or source task must not be used to
assign ownership to the tab. The request lives only in the window navigation store, never persisted
settings. A temporary external directory still belongs to the workspace of the originating entry. On mobile
Home, a same-workspace entry also enters Chat; a cross-workspace entry hands the Chat and file-open intent
to the new Root, and the old page no longer creates the tab again.

## Implementation Constraints

- The file tree lives in `packages/ui/src/workspace-file-tree/`; the root
  `packages/ui/src/WorkspaceFileTree.tsx` keeps compatibility exports and provides `FileManagerPane`, the
  container composing directory and preview.
- Tree nodes do not use `Collapsible`; directory expansion is controlled by `expandedPaths`.
- The entry binds per workspace and passes that workspace's `workspacePath`, `workspaceIdentity` and
  `remoteSessionId`, so multiple or remote workspaces do not share the current service.
- A task row entry looks up the workspace tab by `workspaceIdentity?.trim() || workspacePath`. A local task
  can open directly; a remote task shows an executable entry only after its tab has a `remoteSessionId`,
  and must never degrade to the local file service without a remote session.
- The file tree entry of a pinned task only navigates the workspace; it does not change pin state, task
  order, group membership, active task or conversation realtime state.
- The title shows the name on the workspace row; without a passed name it falls back to the path tail.
- Directory content loads on demand through `fileService.readdir({ path, includeHidden: true })`, reading
  only the currently expanded directory with no recursive workspace scan; the tree shows dotfiles such as
  `.gitignore`, `.env`, `.github`.
- The refresh button re-reads the workspace root and the currently loaded or expanded directories. After
  ZCode/Agent renames or adds a file in a loaded subdirectory, clicking refresh must show the latest list;
  an old path must not remain in the tree and fail to open.
- The file-system watcher covers only the workspace root and the currently expanded directories; collapsing
  a directory must release its watcher so browsed directories do not hold OS watch handles. An add, delete
  or rename in an expanded directory auto-refreshes that directory after the watcher event; a loaded but
  collapsed directory is updated via the refresh button; unloaded deep directories keep lazy-loading
  semantics with no repo-wide scan.
- Visible nodes are flattened by `flattenWorkspaceFileTreeRows` and rendered through
  `@tanstack/react-virtual`, so big directories do not mount lots of DOM at once.
- A file-name search box sits above the project name, and the button group right of the project name offers
  a Git-change filter button when Git status is available. With an empty search box the lazy-loaded tree
  keeps showing only nodes loaded by `readdir`; a non-empty box enters search results mode, calling
  `fileService.listWorkspaceFiles({ rootPath: workspacePath })` of the Host owning the workspace to build
  candidates, reusing the file-name, relative-path and absolute-path fuzzy matching and ordering of `@`
  file candidates. The tree search keeps no second blocklist in the renderer, and the default filter equals
  `@` file candidates; a remote workspace must be scanned by its Remote Host, never falling back to the
  local file service. The Git-change filter button uses the `GitCommitVertical` icon, sits after the more
  menu and before refresh, and when active shows only files with direct changes and directories containing
  changed descendants; it is hidden for non-Git workspaces and temporary external directories.
- Loaded chains of shell-only directories merge as compact folders, e.g. `src/features/auth`; expanding
  continues lazy loading only along the single-child chain, with no recursive scan of ordinary big
  directories.
- Compact folders compress only the displayed hierarchy; when expanding descendant directories, the
  original depth of `readdir` child nodes must be computed from `workspacePath` and the directory's
  physical path, never from the already compressed `row.depth`. Flattening then subtracts the compact
  offset so child content is one level deeper than its parent and sticky folders find the right parent.
- When scrolled to a deep file, the directory ancestors of the currently visible row are combined in a
  single zero-height CSS sticky container inside the scroll container, before the virtual list; clicking
  jumps back to that directory, and the original virtual rows stay in their slots. The sticky trigger line
  of each child level is `scrollTop + stuck ancestor count x 28px`, matching row positions in the combined
  container, so not every level waits for the absolute scroll-container top. The sticky outer layer and the
  inner combined sub-container stay transparent without backdrop blur; the inner sub-container only clips
  the corners of all sticky layers uniformly. The virtual list uses a top mask moving with `scrollTop` and
  sticky layer count, hiding only the original rows passing under the sticky area, without covering the
  sticky container or taking part in height computation; the mask offset must be written by the native
  `scroll` event straight into a list CSS variable, not wait for virtualizer state to trigger a React
  re-render. Sticky switching must not change scroll-container height, scrollbar length or actively write
  `scrollTop`; the scroll container keeps only a bottom fade hint.
- A single click on a directory expands or collapses it; a click on a file opens the right `PreviewPane`
  via `onOpenPreview`; a Git deleted virtual file can only be selected and have its path copied. Search
  result mode reuses only the file index and search ranking, inheriting none of the `@` panel's grouping,
  preview limit or Markdown mention insertion; clicking a file in results still opens `PreviewPane`,
  clicking a directory locates/expands per tree semantics, lazily loading ancestors level by level as
  needed. Clearing the search must restore the original `expandedPaths`, loaded directory cache, sticky
  folders and watcher boundary, and must not pour the repo-wide index into the lazy tree cache.
- Right-clicking a file shows a file menu: `Open` reuses the row's primary action and `Copy path` copies
  the absolute file path; directories show no such menu for now.
- Grid, row height, indentation, selected and hover states use Tailwind classes and design tokens; the
  selected-file border uses `--color-input-border-focused`, consistent with the input focus border.
- Tree rows and virtual slots are both `28px` high with no extra row gap; rows use a `0.5rem` base left
  margin and nested nodes indent `0.75rem` per level. The indent area draws continuous vertical hierarchy
  guide lines by `row.depth`, not shown at the root level. Guides start at `0.625rem` and repeat every
  `0.75rem`, `1px` wide, so the last line's right edge keeps exactly `4px` from the current level icon's
  left edge; guides use `-inset-y-px` to extend `1px` beyond the row top and bottom, use the `--color-border`
  semantic color, and sit as a pointer-event-free decoration layer beneath row content, never changing row
  height, click, drag, selection or keyboard focus behavior.
- Hierarchy guides are rendered uniformly by `WorkspaceFileTreeRowView`, shared by ordinary virtual rows
  and sticky folders, with the same structure on desktop, ordinary Web, mobile Web, and Zai Light / Zai
  Dark, with no platform or theme branch.
- On open, the workspace-scoped `gitService` reads staged / unstaged changes and shows the Git status right
  of the file name: `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked. A directory row uses
  a `●` descendant hint that its descendants contain Git changes; ignored paths show no letter and keep the
  weakened `--color-git-ignored` text style; a deleted file row can only be selected and have its path
  copied, no longer opening preview, local editor or file manager.
- The descendant directory `●` style priority follows VS Code's Git resource priority: `modified` is above
  `added` / `deleted` / `renamed` / `untracked`; equal priority keeps the Git status collection order.
- Git status colors all go through design tokens: `--color-git-modified`, `--color-git-added`,
  `--color-git-deleted`, `--color-git-renamed`, `--color-git-untracked`, `--color-git-none`,
  `--color-git-ignored`, `--color-git-descendant`, so the tree does not scatter status colors borrowed from
  diff / warning.
- A more menu left of the title-bar refresh button: a local workspace can open the system file manager at
  the workspace root and copy the workspace path; a remote workspace disables the local file-manager entry
  so a remote path is not handed to the local machine.
- The Desktop Project Memory project list can reuse the Shell dispatch of Markdown local-directory links,
  opening the Memory root resolved safely through the Base Local Host as a temporary external directory;
  this does not change the current workspace identity and does not expose local paths to Web Remote /
  Mobile.
- File drag uses the custom MIME `application/x-zcode-workspace-file` plus `text/plain` as the fallback.
  After a file or directory starts dragging, the hierarchy guides of the drag-source row are hidden and
  restored on drag end, drop or window blur, so lines do not cross the system drag preview.
- The prompt input converts that MIME into a Markdown mention consistent with `@` file mentions.

Performance principles:

- Load only the workspace root initially; request child directories only on expansion.
- Loaded directories are cached. Outside search, the refresh button force-refreshes only the loaded/expanded
  directories and the root and refreshes Git status, avoiding repo-wide recursive scans. In search state,
  refresh may refresh the `listWorkspaceFiles` search index, but results stay an independent result set and
  are never written into `childrenByDirectory`. The watcher lifecycle is bounded by the root and currently
  expanded directories and must not grow unbounded with the loaded cache or search index.
- The `workspaceIdentity?.trim() || workspacePath` semantics are kept by the drag payload; path reads and
  writes still use `workspacePath` and the absolute file path.
