# Settings Project Memory Layered Navigation

## Problem Summary

The Settings Project Memory viewer must show the Memory files of a Workspace Scope and open the real file
directly with the user's chosen editor. Memory reuses the Scope interaction of capability settings but offers
only a Workspace Scope, no User Scope:

```text
Workspace Memory switch
  └─ Workspace Scope + current memory count + refresh
       └─ All Memory files of the current Workspace
            └─ editor button opens the real file
```

## Product Contract

### Workspace Scope and File List

- The "工作区记忆" (Workspace memory) switch card is fixed above the Scope toolbar; it is the Memory feature
  entry setting. It uses one concise description: "在工作区中保存并复用长期上下文，新会话生效。开启后可能增加模型调用和 Token 成本。"
  (Save and reuse long-term context in the workspace, effective for new sessions; enabling may increase model
  calls and token cost), with no separate repeated cost-hint paragraph.
- After the catalog finishes loading, the first Workspace is selected by default; the Scope menu lists only
  Workspaces that have a Memory catalog and shows no User option. The project name prefers the real names from
  the app's open Workspaces and recent Workspace records, keeping the original case and characters.
- The Scope menu order follows the recent-use order of `settings.json.recentProjects`: Memory Workspaces that
  match by project directory name come first in that order, unmatched historical Memory keeps the catalog's
  original order appended at the end. A currently open Workspace not yet in `recentProjects` only adds its name
  and an end order and does not override the settings order.
- The Scope toolbar reuses MCP's button, menu width, Workspace icon and selected state, showing on the left in
  turn the Scope, a divider and the current Workspace's Memory count, and filename search on the right; the
  refresh entry sits at the right of the `文件` (Files) group title.
- Switching Scope directly replaces the file list below, without a project list or breadcrumb second-level
  navigation. Scope expresses the Memory's effective range over the project, not its physical storage location;
  the underlying store may still be in User Home.
- Search filters only file names of the current Scope, case-insensitively; the query is kept when switching
  Workspace. With no match, the "Files" group title and list hide and a unified search empty state shows.
- The list visuals match the MCP, Skills and Hooks resource lists of Settings: the `文件` group title uses a
  unified `h-7` height; the list container has no outer border and uses `bg-surface`, with independent
  `bg-border/50` separator elements between rows. The file icon uses a `size-9`, `rounded-xl`, `bg-background`
  icon container; row hover uses `bg-hover`.
- The count includes all `.md` files returned by the catalog for that project directory, including
  `MEMORY.md`. Projects keep the service's most-recently-updated-first order, with no UI re-sorting.

### Memory File List

- The list shows all files returned by the catalog flat; `MEMORY.md` is an ordinary selectable item, no longer
  a virtual parent node.
- Each file reuses `FileDisplayIcon` to show a file-type icon by extension; a file row only shows information
  and neither reads nor expands Markdown content.
- The middle of a file row shows the file name and update time on two lines: the file name uses the UI font
  with `font-medium` main text, the update time uses secondary small text; the right keeps an independent
  editor segmented menu.
- Each file row's right side reuses the top toolbar's `WorkspaceEditorButtonGroup`: the main button shows the
  current editor icon and opens the file directly, the down arrow selects another editor. File rows show no
  expand arrow and set no expand state; the buttons and the row body interact independently. The row body is
  not an expandable button; only the right native-editor button group is operable.

### Scroll Contract

Like the Settings Plugin list/detail, the Settings main content area bears the vertical scrolling uniformly,
and the outer scroll is not locked for the Memory viewer. The Memory toolbar and file list share the same page
scroll chain. No second vertical scrollbar inside the viewer and no fixed card header.

### Refresh

The Scope toolbar keeps an explicit refresh entry. After refresh the selection is kept if the current Workspace
still exists; when it disappears the new first item is selected automatically.

### Empty and Loading States

Catalog loading, no saved memory and the local-view-only hint all use a transparent-background
`rounded-xl border border-dashed border-border` hint container; when the feature is off only the switch card
above shows and no extra hint container renders. The empty state fakes no Workspace Scope, offers no create
entry and does not change the existing Memory data source.

## State and Events

```text
memories(workspaceId)
  ├─ selectScope(nextWorkspaceId) ─────────> memories(nextWorkspaceId)
  ├─ open(file, editor) ───────────────────> external editor
  └─ refresh
       ├─ workspace exists ────────────────> memories(workspaceId)
       └─ workspace missing ───────────────> memories(firstWorkspaceId)
```

The UI's Scope selection exists only while `MemorySettingsSection` is mounted and is not written to setting,
localStorage, Host, Runtime or the catalog service.

## Platform and Architecture Boundary

- Desktop Settings still reads the current local profile through the local Base Host only.
- Memory directory resolution and the `stat` before opening also use the local Base Host fixedly; with an active
  SSH, WSL or Docker workspace the local Memory path must not be handed to the remote Host.
- The catalog returns each file's real absolute path; the file button hands that path to the existing
  `IPlatformService.openInEditor`, and the Renderer does not build paths itself.
- Web Remote / Mobile still show only the switch and the "前往本地桌面端查看" (Go to the local desktop app to
  view) hint and do not call the catalog.
- No aggregation of SSH, WSL, Docker, custom-agent or external storage Memory. No change to the app-global
  persistence and session materialization semantics of `memoryEnabled`. No new protocol, watcher, polling,
  inline read, delete, search or export capability.

## Responsive and Accessibility

- Desktop and phone widths use the same Scope and file list semantics; the information architecture does not
  change at breakpoints.
- Scope uses native menu keyboard semantics; a Memory file row is a static information container, and the editor
  button group uses native button keyboard semantics. Folder/FileText icons only aid recognition; Workspace and
  file names remain the main body of accessible names. Long Workspace and file names may truncate with no
  Tooltip.
- All copy uses i18n, and all colors, font sizes, spacing and radii use the semantic tokens of `DESIGN.md`.

## Acceptance Cases

| ID    | Setup                             | Action                  | Assertions                                                                                                                                                    |
| ----- | --------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PMN01 | Desktop, Memory on, two projects  | catalog ready           | Switch on top; Scope defaults to the first item with no User; the toolbar shows the count; the current Workspace's files show directly below                  |
| PMN02 | Scope menu has several Workspaces | Switch Workspace        | The file list is replaced with the target Workspace content, no project list or breadcrumb appears                                                            |
| PMN03 | Current Workspace file list       | View and use a file row | File-type icon, name, update time and the right editor segmented menu are correct; the main button opens the real path, the down arrow selects another editor |
| PMN04 | Non-first Workspace selected      | Explicit refresh        | Selection kept if the Workspace still exists; the new first item selected if it disappeared                                                                   |
| PMN05 | catalog loading, empty or error   | Load, retry             | loading/empty use the unified transparent dashed container; errors keep clear feedback and an explicit refresh entry                                          |
| PMN06 | Web Remote / Mobile               | Open Memory             | Only the switch and the local-view hint show; the catalog gets zero calls                                                                                     |
| PMN07 | File list exceeds the viewport    | Scroll                  | Only the Settings main content area scrolls vertically                                                                                                        |

## Pruning

- Runtime, provider, desktop continuous and mobile replayable message combinations are not enumerated: the
  change triggers no Runtime or protocol and proves isolation only by zero-call invariants.
- No new service file-system equivalence classes: directory containment, symlink, concurrent delete, atomic
  update and the 5 MiB limit stay covered by `memoryService.test.ts`.
- The old selector, virtual tree, collapse and roving-focus cases are not kept: those interactions left the
  product contract and are replaced by native button-list keyboard semantics.
