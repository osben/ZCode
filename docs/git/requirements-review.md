# Git Requirements Review and Acceptance Checklist

## Document Description

Review of the Git integration against `docs/git/requirements.md` and the landed code. Two statuses are recorded:

- `Implementation status`: `Completed` (implemented, main functional chain runs) or `Not completed` (inconsistent with requirements, or not landed).
- `Acceptance status`: `Accepted` or `Not accepted`. Acceptance is completed manually by the user: `Accepted` when the user confirms, `Not accepted` otherwise (with the problem noted in remarks).

## Scope of the Integration

- Git UI is connected to the real `IGitService`.
- `Not staged` / `Staged` / `All branch changes` use real repository data.
- `Previous round changes` keeps the ZCode task per-turn snapshot chain.
- The Git pane loads single-file diffs on demand.
- The top Git entry and the Git pane share the same Git status.

The Git UI to real service main chain is connected and in manual acceptance. A few items still deviate from the original `requirements.md` and need confirmation.

## Requirement List

| Requirement item                                                                                          | Implementation status | Acceptance status | Remarks                                                                                       |
| --------------------------------------------------------------------------------------------------------- | --------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| Top Git entry located in `WorkspaceHeader`, supports opening/closing right Git pane                       | Completed             | Accepted          | Connected top entry and switch logic                                                          |
| Top displays `Git +/-` capsule statistic when changes exist                                               | Completed             | Accepted          | Visible even when Git pane not opened                                                         |
| Git pane reuses right shared pane, shares slot with Browser / Code Viewer                                 | Completed             | Accepted          | Connected per existing main layout                                                            |
| Git pane maintains lightweight structure: title bar, source switch, main content area                     | Completed             | Accepted          | Current is still lightweight read-only layout                                                 |
| Supports four sources: `Not staged` / `Staged` / `All branch changes` / `Previous round changes`          | Completed             | Accepted          | Four sources all switchable                                                                   |
| After source switch, file list, directory filter, diff content switch synchronously                       | Completed             | Accepted          | Top statistic also follows same dataset                                                       |
| `Not staged` / `Staged` / `All branch changes` connected to real repository data                          | Completed             | Accepted          | Connected to real `IGitService`                                                               |
| `Previous round changes` preferentially reuses current task per-turn file snapshot and summary            | Completed             | Accepted          | Current maintains read-only view                                                              |
| File list displays workspace relative full path                                                           | Completed             | Accepted          | Displayed per list item                                                                       |
| File list displays `+/-` statistic                                                                        | Completed             | Accepted          | Line changes already displayed                                                                |
| Non `Not staged` items can display status badge                                                           | Completed             | Accepted          | Includes `Staged` / `Untracked` / `Conflicted` / `Branch comparison` etc.                     |
| File item supports expand/collapse                                                                        | Completed             | Accepted          | Already supports inline diff expansion                                                        |
| Supports diff for four classes: `Not staged` / `Staged` / `All branch changes` / `Previous round changes` | Completed             | Accepted          | Current is on-demand loaded diff                                                              |
| Binary file gives non-previewable hint                                                                    | Completed             | Accepted          | Degradation text already available                                                            |
| Oversized diff gives cropping hint                                                                        | Completed             | Not accepted      | Degradation text already available                                                            |
| Patch generation failure gives unavailable hint                                                           | Completed             | Not accepted      | Degradation text already available                                                            |
| After Git pane opens file tree, right side expands directory sidebar                                      | Completed             | Accepted          | Current already can expand right tree                                                         |
| File tree supports directory collapse/expand                                                              | Completed             | Accepted          | Current already supports                                                                      |
| File tree top supports file filtering within current directory tree                                       | Completed             | Accepted          | "All directories" entry replaced by search box, supports instant filtering                    |
| After directory selected, main area only displays file changes under that directory                       | Completed             | Accepted          | Current already supports directory filtering                                                  |
| Current version does not include repository summary header                                                | Completed             | Accepted          | Does not display info block such as repo root, branch, ahead/behind                           |
| Current version does not include bottom commit area                                                       | Completed             | Accepted          | Commit area not restored                                                                      |
| Current version does not include commit identity hint area                                                | Completed             | Accepted          | UI does not display identity area                                                             |
| Current version does not include batch operation button area                                              | Completed             | Accepted          | UI does not display batch operation area                                                      |
| Current version at least handles "no changes under current source" empty state                            | Completed             | Not accepted      | Already supported                                                                             |
| Current version at least handles "diff cannot be previewed" empty state                                   | Completed             | Not accepted      | Already supported                                                                             |
| UI layer needs to retain Git pane logs                                                                    | Completed             | Accepted          | Already records source switching, file expansion, opening file tree, directory selection etc. |
| Open/close Git pane needs logging                                                                         | Completed             | Accepted          | Recorded by `useAppPanels`                                                                    |
| Maintain internationalization compatibility                                                               | Completed             | Accepted          | Chinese/English texts all supplemented                                                        |
| Maintain dual theme compatibility direction                                                               | Completed             | Accepted          | Current implementation does not introduce theme-breaking fork                                 |
| Maintain local / remote / multiple operating system compatibility direction                               | Completed             | Not accepted      | Connected via unified `IGitService` chain                                                     |

## Current Conclusion

1. Git UI and the real service main chain are complete and the main chain runs.
2. The 5 items marked `Not accepted` in the table await manual confirmation (see [`unverified-requirements.md`](./unverified-requirements.md)); the rest are `Accepted`.
3. After the user confirms an item, update its status in this file; when the user requires an implementation adjustment, modify code first, then update the item's `Implementation status` and remarks.
