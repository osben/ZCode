# Git Requirement Design

## Document Positioning

Product requirement baseline of the current Git UI, based on confirmed design. It does not discuss underlying service, RPC or Git CLI implementation.

## Current Design Baseline

Git capability is a "lightweight change review panel": quickly see what changed in the current workspace inside ZCode.

This version provides:

- A clear Git entry and change hint at the top.
- A lightweight Git operation menu at the top (commit / push / create branch).
- Change viewing from different sources inside the right shared pane.
- Lightweight, single-column, low-burden browsing of files and diff.

It does not pursue a complete Git workbench.

## Product Goals

- Users notice whether changes exist without leaving the current workspace.
- Users quickly view file changes from different sources in the current workspace.
- Git UI shares the right pane with Browser / Code Viewer, adding no main-layout complexity.
- Keep dual-theme, internationalization and local / remote / multi-OS compatibility.

## Non-Goals

- No complete Source Control IDE.
- No repository summary panel (repo root, branch, ahead/behind info blocks).
- No bottom commit area, identity hint area or batch operation area.
- No stage/unstage/discard, pull/fetch, rebase, stash, merge editor or history graph.
- No GitHub / GitLab remote collaboration view.

## Core User Scenarios

### Scenario 1: Know whether the current workspace has changes

The user does not need to open the Git pane first.

- The top toolbar shows a Git entry.
- When `+/-` change statistics are detected, the entry shows the Git icon and a `+/-` summary.

### Scenario 2: Quickly browse a class of changes

The user clicks the top Git entry and views changes in the right pane.

- Can switch `Not staged`, `Staged`, `All branch changes`, `Previous round changes`.
- Files appear in a single-column list.
- A file can be expanded to show its inline diff.

### Scenario 3: Filter changes by directory

The user clicks "Show file tree" in the Git pane.

- A directory sidebar appears on the right.
- The sidebar shows directory levels only, not files.
- After a directory is selected, the main file list filters synchronously.

## Function Scope

### 1. Top Git Entry

#### 1.1 Entry Position

The Git entry is in the `WorkspaceHeader` top toolbar, in the same interaction group as the Terminal / Browser entries.

#### 1.2 Display Rules

- With no change statistics to display, the entry is an ordinary Git icon button.
- With `+/-` change statistics, the entry is an integrated capsule button "Git icon + +/-".
- The statistics do not depend on whether the Git pane is open.

#### 1.3 Interaction Rules

- Click opens or closes the Git view in the right shared pane; the open state has a clear selected state.

#### 1.4 Top Git Operation Menu

- A "commit or push" capsule entry sits left of the terminal switch button in the `WorkspaceHeader` top toolbar.
- The main button runs `commit` first according to the current Git status, and `push` when there are no uncommitted changes but pushable commits exist.
- The entry has no three-dots / dropdown menu, so commit and push do not split into two parallel paths.
- `commit` opens an independent commit popup; by default it stages and commits all uncommitted changes within the current workspace scope together.
- The commit popup also provides `commit and push`: after a successful commit it reuses the same Git service to push the current branch.
- `push` opens an independent push popup and runs a real `git push`; when the current branch has no upstream, the first push adds `--set-upstream`.
- A failure of a commit / push mutation started from a popup must never be lost: while the mutation is in flight, dismissing the popup must not discard the pending failure.
- The same holds when the popup disappears because its host unmounts mid-mutation (the dialog vanishes without a dismissal event): the failure must still surface as a toast.
- If such a mutation fails after the popup has been dismissed, show an error toast with the same error text as the inline popup error; exactly one surface (inline popup error or toast) presents the failure.

### 2. Git Pane

#### 2.1 Layout Positioning

The Git pane reuses the right shared pane and shares the slot with browser / code-viewer.

#### 2.2 Current Structure

Lightweight layout in three layers:

- Top title bar: Git title, UI placeholder marker, close button.
- Toolbar: left source switch dropdown; right "Show file tree / Hide file tree" button.
- Main content area: single-column file list by default; after opening the file tree, a directory sidebar on the right.

#### 2.3 Content Explicitly Not in the Current Design

- Repository summary header
- Left multi-group status tree
- Independent right diff large panel
- Bottom commit area
- Commit identity hint area
- Batch operation button area

### 3. Change Source Switch

#### 3.1 Supported Sources

- `Not staged`
- `Staged`
- `All branch changes`
- `Previous round changes`

#### 3.2 Interaction Requirements

- Source switching is a dropdown selection.
- After switching, the file list, directory filter and diff content switch synchronously to the corresponding dataset.
- The selected source also drives the statistics used by the top Git entry.

#### 3.3 Read-only Constraint

This is "change browsing": `Previous round changes` is a read-only view; the other sources only bear viewing responsibility and do not promise real Git write operations.

### 4. File List and Diff

#### 4.1 File List

A flat single-column list by default, not a tree file area. List item requirements:

- Show the workspace-relative full path.
- Show the file's `+/-` statistic.
- Non-`Not staged` items can show a status badge, for example `Untracked`, `Conflicted`, `Staged`.
- Support expand/collapse.

#### 4.2 Expanded State

An expanded file no longer repeats the full path and `+/-` statistic; it goes straight to the diff content.

#### 4.3 Diff

Diff is supported for `Not staged`, `Staged`, `All branch changes` and `Previous round changes`.

Degradation:

- Binary file: non-previewable hint.
- Oversized diff: cropping hint.
- Patch generation failure: unavailable hint.

### 5. File Tree Sidebar

#### 5.1 Trigger Method

Clicking "Show file tree" in the toolbar expands a directory sidebar on the right of the Git pane.

#### 5.2 Display Rules

- Shows the directory hierarchy only, not files.
- Supports directory collapse/expand.
- Supports an "All directories" entry.

#### 5.3 Filter Rules

- After selecting a directory, the main area shows only file changes under that directory.
- Switching back to "All directories" restores the complete file list.

### 6. Data Source Requirements

#### 6.1 Sources Allowed in the Current Version

Mock data may be mixed with existing session data:

- `Not staged` / `Staged` / `All branch changes`: frontend mock allowed first.
- `Previous round changes`: preferentially reuses the current task's per-turn file snapshot and summary.

#### 6.2 Not Required in the Current Version

Real `git status`, real branch comparison, a real file tree service and real commit identity reading are not required to be connected.

### 7. Write Operation Scope

Only 3 lightweight write operations in the top menu: `commit`, `push`, `create branch`.

Not required: staging a single file, staging multiple selected files, unstage, discard, GitHub / GitLab PR creation. The write boundary is a "top single action", not a complete Source Control panel.

### 8. Empty States and Errors

At least handle:

- The current source has no changes.
- The selected directory has no files.
- The diff cannot be previewed.

More complete error states may be added at the real service access stage: Git not installed; workspace not inside a Git repository; Git repository corrupted; Git command timeout or execution failure; remote connection disconnected.

### 9. Log Requirements

The Git pane is a high-interaction area, so the UI layer logs at least: open/close Git pane, switch change source, expand/collapse file, open/close file tree, select directory.

### 10. Extension Direction

Without changing the UI baseline, extend in stages:

1. Connect the real `IGitService`.
2. Switch `Not staged` / `Staged` / `All branch changes` to real repository data.
3. Evaluate restoring the commit area, identity hint area and batch operation area.
4. Expand real stage / unstage / discard / commit capabilities.
