# Message change summary: "Group by directory" checkbox for the file list

Status: approved 2026-10-17; implemented.

Note: the live panel is `packages/ui/src/v4/ConversationFileSummaryPanel.tsx` (file rows in `v4/ConversationFileSummaryList.tsx`). The legacy `MessageChangeSummaryPanel` has no consumer in `src` and is intentionally untouched.

## Problem

`ConversationFileSummaryPanel` (the "N files changed +a −d" card under an agent reply) renders the turn's changed files as a flat list, each row showing `basename + dim directory path`. For turns touching 10+ files the directory prefix repeats on every row and the touched areas are hard to see.

## Product rules

1. Default stays **flat**, exactly as today (byte-identical rendering when the checkbox is off).
2. A **"Group by directory" checkbox** in the panel header (left of Undo, shown only while the panel is expanded and has >1 file) switches the file list to a nested folder tree. Unchecking returns to flat.
3. Tree mode:
   - Real nested hierarchy built from workspace-relative paths, indented per level.
   - Single-child folder chains are compacted into one row (`packages/ui/src`), like VS Code / JetBrains.
   - Folders sort before files, both alphabetically; flat mode keeps today's order.
   - Each folder row has a chevron to collapse/expand its subtree, plus aggregated `+added −removed` of its descendants. All folders start expanded.
   - File rows keep today's behavior (click / Enter / Space opens the diff; "Review" and `OpenSplitButton` buttons), but show the **basename only** (the folder rows give the directory context).
4. The checkbox is shown only when the panel is open and `fileCount > 1` (a single file has nothing to nest).
5. Collapsed-folder state is local to the panel instance (not persisted).
6. The checkbox value is a UI-local presentation preference, persisted globally in `localStorage` (`zcode-change-summary-tree-view`, `"true"`/absent, SSR-safe, same `StorageLike` pattern as `lib/workspaceExpansionPreference.ts`). Not in `setting.json` (fork-unsafe, see AGENTS.md), not broadcast-synced.

## State owners and interfaces

- Preference: new `packages/ui/src/lib/changeSummaryTreeViewPreference.ts` (read/write, single owner of the key).
- Tree building: new pure helper `packages/ui/src/lib/changeSummaryTree.ts`: `buildChangeSummaryTree(files, workspacePath) -> rows` (flattened, depth-annotated, compacted folder rows with aggregates; takes a `collapsed: ReadonlySet<string>` to elide hidden descendants). No React, unit-testable.
- `ConversationFileSummaryList` owns `isTreeView` (initialised from preference) and `collapsedFolders` state; flat and tree modes share one file-row renderer.
- No protocol, Main, Host, or remote changes. Mobile remote control (`compactForRemoteControl`) gets the same checkbox; indentation capped at 6 levels visually to fit narrow screens.

## i18n

`chat.changeSummary.treeView` in `en-US`, `uk-UA`, `zh-CN` ("Group by directory" / «Групувати за каталогами» / 「按目录分组」). Label truncates on narrow widths; header checkbox keys off `summary.files > 1` (known before details load); indentation is capped at 6 levels.

## Acceptance scenarios

1. Fresh state: panel expanded shows the flat list, identical to today; checkbox unchecked.
2. Check "Group by directory": files regroup under folders; `a/b/c/x.ts` + `a/b/c/y.ts` yield one compacted `a/b/c` folder row with two file rows; folder aggregate equals the sum of children.
3. Collapse a folder: descendants hidden, aggregate still visible; expand restores them.
4. File row in tree mode: click/Enter/Space opens the same diff viewer as in flat mode; Review/Open buttons work.
5. Toggle off then on: folders are re-expanded (collapsed state resets with the mode toggle).
6. Reload: the checkbox state is restored from `localStorage`; invalid/missing value → flat.
7. Files directly in the workspace root render at depth 0 with no folder row.
8. Narrow (mobile) width: no horizontal overflow; long names truncate.

## Tests

- Unit: `changeSummaryTree` (compaction, ordering, aggregates, collapsed elision, root files, Windows separators) and the preference helper.
- Component: `v4ConversationFileSummaryPanel.test.ts` keeps covering the flat path (Radix checkbox mocked, minimal DOM).
- E2E: add a scenario for toggle + collapse (interaction change).

## Non-goals

- A Settings entry for the default (would need fork-safe `fork_` storage; the inline checkbox already persists the choice).
- Tree mode in the Review tab (already has Directory/Flatten, see `specs/review-tab-directory-grouping.md`).
- Sticky folder headers, per-folder "open all diffs", persisted collapse state.
