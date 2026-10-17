# Review tab: group changed files by directory (JetBrains-style Directory/Flatten toggle)

Status: draft 2026-10-16 (ZCO-37). Decided direction: Variant 1 from the issue — single-level directory grouping with static (non-collapsible, non-sticky in phase 1) header rows, plus a Directory/Flatten presentation toggle. Collapsible single-level groups were evaluated and rejected (see Non-goals); a full nested tree stays a separate follow-up (issue Variant 2).

## Problem

The Review pane list (`packages/ui/src/GitPane.tsx`) is a flat list of change cards sorted by `workspaceRelativePath`. With agent-driven diffs of 10–40 files the user gets no spatial orientation: long path prefixes (`packages/ui/src/components/…`) repeat on every row, and there is no way to see at a glance which areas of the project a change set touched. JetBrains solves this with a Directory vs Flatten presentation toggle in the commit/changes toolwindow; this spec ports that interaction to the Review pane only.

Verified current state (2026-10-16):

- `currentChanges` = flatMap of the active dataset's sections (`GitPane.tsx:102`); virtualizer consumes it directly (`count: currentChanges.length`, `GitPane.tsx:302`).
- Per-section order is `workspaceRelativePath.localeCompare` (`useGitRepository.ts:240` `buildSectionsForSource`), but the unstaged dataset flattens **three** sections — `SECTION_ORDER_BY_SOURCE.unstaged = ["unstaged", "untracked", "conflicted"]` (`useGitRepository.ts:84`). Files of the same directory can therefore be non-adjacent across a section boundary. The issue's "already sorted → already adjacent" claim holds per section, not across the flattened list — the row model must respect section boundaries.
- Rows are absolutely positioned with a `top` offset, deliberately not transforms, so inline sticky positioning inside cards keeps working (`GitPane.tsx:508` comment). Row heights are variable (`measureElement` + `estimateSize: 32`, remeasure effect at `GitPane.tsx:318`).
- Find-in-changes scrolls via `currentChanges.findIndex(...)` → `scrollToIndex(activeMatchIndex)` (`GitPane.tsx:369-376`); match targets are built per change path (`fileChangeFindTargets`, `GitPane.tsx:282`).
- `GitPaneChangeCard` renders the full `workspaceRelativePath` in its header (`GitPaneChangeCard.tsx:103`) and is consumed only by `GitPane`.
- Sticky folder headers already exist for the workspace file tree (`workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx`, plus a scroll-synced mask in `WorkspaceFileTreeList.tsx:33-34`) — but that mechanism assumes fixed-height virtual rows; the Git pane has variable-height rows. Sticky headers here are real work, not free (see §8).

## Contract

### 1. Row model — pure, order-preserving, section-aware

New pure helper `packages/ui/src/GitPane/directoryRowModel.ts` (colocated with the existing `GitPane/helpers.ts`, `GitPane/fileChangeFindSearch.ts`):

```ts
type GitPaneRow =
  | {
      kind: "directory";
      runIndex: number;
      directory: string;
      fileCount: number;
      additions: number;
      deletions: number;
    }
  | { kind: "file"; change: GitPaneFileChange };

function buildGitPaneRows(changes: readonly GitPaneFileChange[]): GitPaneRow[];
function getGitPaneRowIndexByPath(rows: readonly GitPaneRow[]): Map<string, number>; // change.path -> row index
```

- Walks the flattened `currentChanges` **in order** and opens a new directory group whenever `dirname(workspaceRelativePath)` changes **or `change.section` changes** (consecutive-run grouping). The section survives the flatten — `GitPaneFileChange extends GitFileChange` (`useGitRepository.ts:44`) and the last-turn builder stamps `section: "last-turn"` (`useGitRepository.ts:299`) — so the helper needs no changes to `buildSectionsForSource`. Same directory may legitimately produce two headers (e.g. a modified file in "unstaged" and a new file in "untracked" under `packages/ui/src/`) — this preserves today's exact list order and section semantics; grouping never reorders or merges across sections.
- A run of one file still emits a directory header (JetBrains behaves the same; the header deduplicates the path prefix and carries aggregate stats).
- Aggregate `additions`/`deletions` sum the run's changes.
- Flat mode does not use the helper: `paneRows` = `currentChanges.map(change => ({ kind: "file", … }))`, byte-identical to today's list.
- `id` uniqueness rules are defined in §5.

### 2. Layout toggle and persistence

- Segmented icon control in the pane header, in the existing right-side button cluster next to Refresh (`GitPane.tsx:457-477`): two icon buttons — `FolderTree` (directory) and `List` (flat) from `lucide-react`, JetBrains-style, composed with the existing `button-group` primitive (`components/ui/button-group.tsx`; if its API fits composition only, two ghost `Button`s with `aria-pressed` are the fallback). Labels/tooltips from i18n (§7).
- Rendered only when `currentChanges.length > 0` (the pane's empty/loading states already own the full header area below; the toggle would be dead weight there).
- New `packages/ui/src/lib/gitPaneFileListLayoutPreference.ts` following the `workspaceExpansionPreference.ts` `StorageLike` pattern: key `zcode-git-pane-file-list-layout`, value `"directory" | "flat"`, default `"directory"`, SSR-safe (no `window` → default), unknown values fall back to the default. Single global value, deliberately **not** per-workspace (presentation choice, like JetBrains) and **not** in `setting.json` (fork-unsafe — upstream writes strip unknown keys) and **not** broadcast-synced (UI-local preference).

### 3. Directory header row

Non-interactive `div` (nothing on it is clickable — no button semantics, no `tabindex`): `FolderTree` icon `size-3.5` muted, directory path (`text-ui-xs`, mono, truncate, `text-foreground-subtle`), file-count pill, aggregated `+a −d` in the cards' add/delete colors. No collapsible chevron, not sticky in phase 1. Height ≈ 28px, `estimateSize` 28.

### 4. File rows inside groups

`GitPaneChangeCard` gets an optional prop (exact name at implementation, e.g. `hideDirectoryPart: boolean`, default `false`) that renders the basename only in the card header — the group header directly above already shows the directory. Implementation note: the card header already renders through `FileDisplayInline` with a `showFilePath` option (`GitPaneChangeCard.tsx:105`, `lib/fileDisplay.tsx:32,172`), so the new prop only forwards `showFilePath: false`; no `fileDisplay` changes needed. Flat mode passes nothing → full path, today's rendering byte-for-byte. No other consumers exist (`GitPaneChangeCard` is used only by `GitPane.tsx`), so the default-value change is safe by construction.

### 5. Virtualizer and keys

- `useVirtualizer` count = `paneRows.length`; the render loop switches on `row.kind` (directory header vs `GitPaneChangeCard`). `expandedPath` / diff lazy-load / single-expanded semantics stay keyed by change path and are untouched.
- `getItemKey`: file rows `${dataset.id}:file:${change.path}` (same as today modulo the `file:` infix — still unique and stable across mode toggles); directory rows `${dataset.id}:dir:${runIndex}:${directory}` where `runIndex` is the run ordinal, so two same-directory runs never collide.
- The remeasure effect (`GitPane.tsx:318-323`) keeps firing on `expandedPath` change; directory headers are constant-height rows measured like any other row.

### 6. Find-in-changes integration

The one real regression risk. `fileChangeFindTargets`/`fileChangeFindState` stay keyed by change path (§ unchanged). The scroll effect (`GitPane.tsx:369-376`) replaces `currentChanges.findIndex(...)` with `getGitPaneRowIndexByPath(paneRows).get(activeMatch.path)`, falling back to today's flat index in flat mode (where the map is the identity). The effect's dependency list gains the row-index map so an active match re-resolves its row after a mode toggle (the virtualizer scrolls to the same file's new row). Match-count and active-match highlight logic untouched.

### 7. i18n

Keys in `packages/ui/src/i18n/locales/{en-US,uk-UA,zh-CN}.ts`: `git.fileListLayout.directory` ("Directory"), `git.fileListLayout.flat` ("Flatten"), `git.fileListLayout.toggleLabel` (aria-label for the group). Directory header content is icon + path + numbers — no plural forms needed. uk-UA: «Каталог» / «Плоско» / «Режим списку файлів»; zh-CN: 「目录」 / 「平铺」 / 「文件列表布局」.

### 8. Phase 2 (explicitly out of this change): sticky current-directory header

While scrolling a long grouped list, show the current directory as a floating header, reusing the `workspace-file-tree` approach (overlay + scroll-synced mask, `WorkspaceFileTreeList.tsx:33-34`). Not free here: that mechanism assumes fixed-height rows; Git pane rows are variable-height and `measureElement`-driven, so the visible-run computation and mask height need adapting. Ship phase 1 without it; decide phase 2 after using phase 1 on real diffs.

## Acceptance scenarios

1. Grouped mode on the unstaged dataset: consecutive same-directory files share one header; a section boundary (unstaged → untracked) with files in the same directory produces two headers; the total list order matches flat mode exactly (headers interleaved, files never reordered).
2. Toggle Directory ↔ Flatten: list switches in place; the expanded diff (if any) stays expanded on the same file; toggling does not scroll the list to the top.
3. Reload the app: the chosen layout persists (localStorage) and applies to every source option (unstaged / staged / branch) and to worktree sessions.
4. Find-in-changes in grouped mode: next/prev match scrolls the matched file's row into view (`align: "center"`); a match inside a file below many headers still lands on the right row (map covers all file rows).
5. Expanding a diff in grouped mode: single-expanded behavior, lazy diff load, and row remeasure work as today; directory headers do not clip or overlap the expanded card (absolute `top` positioning preserved).
6. Flat mode: rendering is identical to the current build (full paths, no headers) — verified by existing behavior, no visual diff expected.
7. Empty/loading/error states and worktree-missing banner render exactly as today (toggle hidden when the list is empty).

## Compatibility

Renderer-only, no protocol/CLI changes. Old builds and new builds share the localStorage key namespace safely (unknown values → default). No new permissions, no host RPC.

## Non-goals

- Collapsible single-level groups: worst-of-both-worlds — collapse state without real hierarchy; the state machine (persist, restore, force-expand on find/filter) is not S-sized, and the code does not carry over to a real tree. Rejected.
- Full nested directory tree (issue Variant 2): separate follow-up, referencing `packages/ui/src/workspace-file-tree/` as the model/flatten/sticky reference.
- Applying grouping to chat change summaries (`MessageChangeSummaryPanel`, `ConversationFileSummaryPanel`): not in this change.
- Reordering, filtering, or cross-section merging of changes.
- Cross-machine sync of the preference.

## Verification

- Unit tests (vitest, colocated `packages/ui/src/GitPane/directoryRowModel.test.ts` — first tests in the `GitPane/` dir): grouping correctness, section-boundary splitting, aggregate stats, single-file runs, empty input, `getGitPaneRowIndexByPath` covering exactly the file rows with correct indices for both modes.
- `pnpm typecheck`, `pnpm lint` on the touched packages; architecture check per `.agents/skills/architecture-governance/SKILL.md` for `packages/ui`.
- Manual `pnpm dev:desktop` pass on a repo with a mixed diff (modified + untracked in the same directories): scenarios 1–7.
