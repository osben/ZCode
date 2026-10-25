# Review tab: "Group by directory" checkbox for the changed-file list

Status: matches the chat card (`specs/message-change-summary-tree-view.md`); it supersedes the earlier Directory/Flatten icon-toggle draft (commit `12eab371`), which defaulted to grouped. This document is the single source of truth for the Review pane; the chat card spec remains the source of truth for the chat card.

## Problem

The Review pane (`packages/ui/src/GitPane.tsx`) lists changes as flat cards. With 10–40 changed files the directory prefix repeats on every row and the touched areas are hard to see. The chat card already offers a "Group by directory" checkbox. The Review pane should offer the same control with the same defaults and the same persistence model, while keeping its own section-aware presentation.

## Product rules

1. **Default is flat.** With the checkbox off, the list is exactly today's list: full workspace-relative paths, no headers, same order, same card rendering.
2. **"Group by directory" checkbox** in the Review header, same label and same visual style as the chat card checkbox (`Checkbox` + text label inside a `<label>`). Checked: the list shows one directory header per run of consecutive files that share a directory **within the same section**. Unchecked: flat.
3. **Grouping never reorders, filters or merges across sections** (`unstaged`, `untracked`, `conflicted`, `staged`, `last-turn`, branch). File order is always the flat order with headers inserted. A directory that occurs in two sections gets two headers.
4. **Group header row** is non-interactive: directory path, file count, aggregate `+a −d`. A run of one file still gets a header. Headers are not collapsible and not sticky in this phase.
5. **File rows in grouped mode** show the basename only (the header gives the directory). Click/Enter/Space expansion, the diff, copy/reveal actions and find-in-changes behave as in flat mode.
6. **Checkbox visibility:** shown whenever the Review list has at least one change, hidden in empty, loading and error states (no dead controls). Unlike the chat card there is no `> 1` file rule: the Review list is not nested, so a one-file grouped list is simply one header plus one file.
7. **Persistence** (same mechanism as the chat card):
   - Global, UI-local boolean in `localStorage` under `zcode-git-pane-group-by-directory`, stored as `"true"` when on and removed when off. Missing or unknown values mean off. SSR-safe; storage errors are swallowed.
   - Not per workspace, not in `setting.json` (fork-unsafe, see AGENTS.md), not broadcast-synced.
   - **Separate key from the chat card.** Each surface keeps its own preference; toggling one must not silently change the other.
8. **Source switches** (unstaged / staged / branch / last-turn) keep the checkbox state. Toggling keeps the expanded card expanded and does not scroll the list to the top.

## State owners and interfaces

- **Preference:** new `packages/ui/src/lib/localBooleanPreference.ts` exports `readLocalBooleanPreference(key, storage?)` and `persistLocalBooleanPreference(key, enabled, storage?)`. It is the single implementation of the `"true"`/absent pattern. Both `lib/changeSummaryTreeViewPreference.ts` (chat, key unchanged) and `lib/gitPaneGroupByDirectoryPreference.ts` (Review, new key) delegate to it. The old `lib/gitPaneFileListLayoutPreference.ts` is deleted.
- **Checkbox:** new shared presentational `packages/ui/src/components/GroupByDirectoryCheckbox.tsx` (props: `checked`, `onCheckedChange`, `label`). Used by the chat card (`v4/ConversationFileSummaryPanel.tsx`) and the Review header (`GitPane.tsx`). It owns no state.
- **Row model:** `packages/ui/src/GitPane/directoryRowModel.ts` (pure, no React):
  - `buildGitPaneRows(changes)`: consecutive-run grouping keyed by `(directory, section)`. Unchanged.
  - `buildGitPaneDisplayRows(changes, groupByDirectory)`: new. `false` returns one `{kind:"file"}` row per change in order; `true` delegates to `buildGitPaneRows`. `GitPane` calls only this function.
  - `getGitPaneRowIndexByPath(rows)`: maps `change.path` to the row index of its file row. In flat mode it is the identity over changes.
- **GitPane** owns `groupByDirectory` state, initialised from the preference and written on change. It derives `paneRows` with `buildGitPaneDisplayRows`, and passes `hideDirectoryPart={groupByDirectory}` to `GitPaneChangeCard`.
- **Not reused: the chat tree.** `lib/changeSummaryTree.ts` builds a nested, folders-first, alphabetically sorted tree with collapse. Applied to the Review list it would reorder files across sections and merge same-directory files from different sections, violating rule 3. Collapse state would also complicate find-in-changes and virtual-row keys. Review therefore keeps one-level runs. This is the one intentional presentation difference from the chat card.

## Layout

- The header keeps the source select on the left. The right cluster becomes `[GroupByDirectoryCheckbox] [Refresh]`, replacing the old two-button layout toggle.
- Long labels truncate (`min-w-0`, `truncate`). Below `sm`, the checkbox label may truncate but must remain visible and clickable as a whole row (`<label>` wraps the checkbox and text).
- Rows use absolute `top` positioning (unchanged, required for inline sticky filenames). Directory headers are `h-7` (28px) and measured like any other virtual row; `estimateSize` 28.

## Directory header row

Non-interactive `div`, no `tabIndex`, no button semantics. Folder icon `size-3.5` muted, directory path (`text-ui-xs`, truncate, `text-foreground-subtle`; root files show `.`), file-count pill, aggregate `+a −d` in the diff add/remove colors. The header is a visual landmark only; the checkbox is the single control.

## i18n

- Reuse `chat.changeSummary.treeView` ("Group by directory" / «Групувати за каталогами» / 「按目录分组」) for the Review checkbox. The label semantics are identical; the key namespace is historical.
- Remove the now-unused `git.fileListLayout.directory`, `git.fileListLayout.flat` and `git.fileListLayout.toggleLabel` keys from `en-US`, `uk-UA` and `zh-CN`.

## Find-in-changes and virtualizer

- `fileChangeFindTargets` / `fileChangeFindState` stay keyed by change path. Unchanged.
- The scroll effect resolves `rowIndexByPath.get(activeMatch.path)` from `paneRows` (display rows of the current mode) and calls `scrollToIndex(index, {align: "center"})`. The map is a dependency, so an active match re-resolves after a toggle.
- `getItemKey`: file rows `${dataset.id}:file:${path}`; directory rows `${dataset.id}:dir:${runIndex}:${directory}`. Keys are unique within a mode; mode switches remount rows, which is acceptable because expansion is keyed by path, not by row.
- Remeasure effect (`changeRowVirtualizer.measure()` on dataset or expansion change) is unchanged.

## Acceptance scenarios

1. **Fresh state:** no stored value. The list is flat, identical to the pre-feature build (full paths, no headers, same order). Checkbox unchecked.
2. **Check "Group by directory":** consecutive same-directory files share one header showing directory, count and `+a −d`. Files appear in the same order as in flat mode, headers interleaved. A same-directory file in another section produces a second header.
3. **Uncheck:** returns to flat without changing order. An expanded card stays expanded and the scroll position is kept.
4. **Reload:** the checkbox state is restored from `localStorage`. An invalid stored value means unchecked.
5. **Find in grouped mode:** next/prev scrolls the matched file's row into view. A match in a file below many headers lands on the right row. Toggling while a match is active keeps the match visible.
6. **Expanding a diff in grouped mode:** single-expanded behavior, lazy diff load and row remeasure work as in flat mode. Headers do not overlap the expanded card.
7. **Empty, loading, error and worktree-missing states:** unchanged, and the checkbox is hidden.
8. **Narrow (mobile remote and narrow web):** no horizontal page overflow; the header label and source select truncate; the checkbox and Refresh stay reachable.
9. **Chat card unaffected:** the chat checkbox still reads and writes `zcode-change-summary-tree-view`, and toggling the Review checkbox does not change it.

## E2E scenario (interaction change)

Case: open a workspace with mixed changes (a modified file and an untracked file in the same directory, plus a file in another directory). Open the Review pane. Check "Group by directory", assert one header per directory run and the header count, uncheck, assert flat rows, reload, assert the preference is restored. Status: unrun — the desktop E2E harness (`packages/desktop/test/e2e/`) has not been extended yet and no desktop E2E run has been performed for this feature. The component test in `packages/ui/test/gitPaneGroupByDirectoryView.test.ts` covers the same behavior in jsdom and is not a substitute for this E2E case.

## Tests

- `packages/ui/test/gitPaneDirectoryRowModel.test.ts` (pure row model):
  - grouped runs and section splitting;
  - `buildGitPaneDisplayRows(changes, false)` returns file rows only, in input order, and has no directory rows;
  - `buildGitPaneDisplayRows(changes, true)` equals `buildGitPaneRows(changes)`;
  - `getGitPaneRowIndexByPath` covers exactly the file rows in both modes and points at the right row index;
  - `canShowGroupByDirectory` hides the checkbox for empty, loading and error states.
- `packages/ui/test/gitPaneGroupByDirectoryPreference.test.ts`: default off on empty and invalid values, `"true"` reads on, writing off removes the key, storage that throws reads off and does not throw on write, and the Review key does not collide with the chat key.
- `packages/ui/test/gitPaneGroupByDirectoryView.test.ts` (jsdom, real `GitPane` render; services, store, i18n, file-context hooks and `GitPaneChangeCard` are stubbed; a 800px viewport is stubbed so the virtualizer renders the fixture rows):
  - Scenario 1: fresh state is flat, unchecked, no headers, files in change order, `hideDirectoryPart` false.
  - Scenario 2: checking the box shows one header per consecutive directory run per section (`packages/ui/src` appears twice across sections), with file count and `+a −d` aggregate, file order unchanged, `hideDirectoryPart` true, stored value `"true"`.
  - Scenario 3: unchecking returns to flat order and removes the stored key; a flat-mode expanded card stays expanded across grouping toggles.
  - Scenario 4: remount restores the checked state from storage; an invalid stored value reads unchecked; the chat key is neither read nor written.
  - Scenario 5 (partial): an active find match auto-expands its card and its row `data-index` equals the grouped row index after toggling. The scroll request itself is not asserted.
  - Visibility: checkbox hidden for empty, loading (with stale rows) and error states; shown when settled.
  - Source switch: the checkbox state survives a `selectedSourceId` change.
- `packages/ui/test/changeSummaryTree.test.ts` keeps covering the chat preference via the shared helper.
- `packages/ui/test/v4ConversationFileSummaryPanel.test.ts` keeps covering the chat flat path (Radix checkbox mocked).

### Not covered by the unit or component tests

- Real `GitPaneChangeCard` rendering, including basename-only display in grouped mode (only the `hideDirectoryPart` prop wiring is checked).
- Real scroll position, "toggling does not jump to the top", and find scrolling to the correct on-screen row (only the row index mapping is checked).
- Real row measurement and header/expanded-card overlap.
- Narrow and mobile layout (scenario 8).
- Real app reload and `localStorage` in the desktop renderer.
- The desktop E2E case above.

## Non-goals

- Collapsible groups, sticky headers (phase 2), nested tree (the chat tree is not reused here).
- A Settings entry or a per-workspace preference.
- Reordering, filtering or cross-section merging of changes.
- Applying grouping to other surfaces.
- Cross-machine sync of the preference.
