# Git Requirement Design

## Document Positioning

This document describes the product requirement baseline of current version Git UI, based on already confirmed existing design, not discussing underlying service, RPC or Git CLI implementation details.

## Current Design Baseline

Current version Git capability positioning is "lightweight change review panel", priority to solve user's problem of quickly seeing what changed in current workspace inside ZCode.

Focus of this version:

- Provide clear Git entry and change hint at top
- Provide lightweight Git operation menu at top (commit / push / create branch)
- View changes from different sources inside right shared pane
- Browse files and diff in lightweight, single column, low burden way

This version does not pursue complete Git workbench experience.

## Product Goals

- Let user perceive whether changes exist without leaving current workspace
- Let user quickly view file changes from different sources in current workspace
- Let Git UI share right pane with existing Browser / Code Viewer, avoid introducing new main layout complexity
- Maintain dual theme, internationalization, local / remote / multiple operating system compatibility direction

## Non-Goals

- Do not make complete Source Control IDE
- Do not make repository summary large panel, do not display repo root, branch, ahead/behind etc. info blocks
- Do not make bottom commit area, identity hint area, batch operation area
- Do not make stage/unstage/discard, pull/fetch, rebase, stash, merge editor, history graph
- Do not make GitHub / GitLab remote collaboration view

## Core User Scenarios

### Scenario 1: I want to know if there are changes in current workspace

User does not need to open Git pane first.

Expected:

- Top toolbar shows Git entry
- When `+/-` change statistics are detected, entry directly shows Git icon and `+/-` summary
- User knows current workspace has changes through this entry

### Scenario 2: I want to quickly browse a class of changes

User clicks top Git entry, then views changes in right pane.

Expected:

- Can switch `Not staged`, `Staged`, `All branch changes`, `Previous round changes`
- Can view files in single column file list
- Can expand a file to directly see inline diff

### Scenario 3: I want to filter changes by directory

User clicks "Show file tree" in Git pane.

Expected:

- Right side pops out directory sidebar
- Sidebar only shows directory levels, not files
- After directory selected, main area file list synchronously filters

## Function Scope

### 1. Top Git Entry

#### 1.1 Entry Position

Git entry is located in `WorkspaceHeader` top toolbar, same interaction group as Terminal / Browser entries.

#### 1.2 Display Rules

- When current workspace has no change statistics to display, entry is displayed as ordinary Git icon button
- When current workspace exists `+/-` change statistics, entry displays as integrated capsule button "Git icon + +/-"
- This change statistics does not depend on whether Git pane is already opened

#### 1.3 Interaction Rules

- Click opens or closes Git view in right shared pane
- Click again closes
- Open state has clear selected state

#### 1.4 Top Git Operation Menu

- Add "commit or push" capsule entry at left of terminal switch button in `WorkspaceHeader` top toolbar
- Main button executes `commit` preferentially according to current Git status, executes `push` when no uncommitted changes but pushable commits exist
- Right side of entry no longer provides three dots / dropdown menu, avoiding splitting commit and push entries into two parallel paths
- `commit` opens independent commit popup, defaults to staging and committing all uncommitted changes within current workspace scope together
- Commit popup additionally provides `commit and push`, after successful commit immediately reuses same Git service to push current branch
- `push` opens independent push popup, executes real `git push`; when current branch has not established upstream, automatically adds `--set-upstream` on first push

### 2. Git Pane

#### 2.1 Layout Positioning

Git pane reuses existing right shared pane, shares same slot with browser / code-viewer.

#### 2.2 Current Structure

Current version uses lightweight layout, divided into three layers:

- Top title bar
  - Git title
  - UI placeholder marker
  - Close button
- Toolbar
  - Left source switch dropdown
  - Right "Show file tree / Hide file tree" button
- Main content area
  - Default displays single column file list
  - After opening file tree, right side displays directory sidebar

#### 2.3 Content Explicitly Not in Current Design

Current version does not include following areas:

- Repository summary header
- Left multi-group status tree
- Independent right diff large panel
- Bottom commit area
- Commit identity hint area
- Batch operation button area

### 3. Change Source Switch

#### 3.1 Supported Sources

Current version supports following sources:

- `Not staged`
- `Staged`
- `All branch changes`
- `Previous round changes`

#### 3.2 Interaction Requirements

- Source switch completed through dropdown selection
- After switch, file list, directory filter and diff content synchronously switch to corresponding dataset
- Currently selected source simultaneously affects statistics source used by top Git entry

#### 3.3 Read-only Constraint

Current version is designed as "change browsing":

- `Previous round changes` is read-only view
- Other sources currently also only bear viewing responsibility, do not promise real Git write operations

### 4. File List and Diff

#### 4.1 File List

Current version defaults to flat single column list, not default tree file area.

List item requirements:

- Directly display workspace relative full path
- Display `+/-` statistic of that file
- Non `Not staged` items can display status badge, e.g. `Untracked`, `Conflicted`, `Staged`
- Supports expand/collapse

#### 4.2 Expanded State

After file expanded:

- No longer repeatedly display full path and `+/-` statistic
- Directly enter diff content

#### 4.3 Diff

Current version supports:

- `Not staged` diff
- `Staged` diff
- `All branch changes` diff
- `Previous round changes` diff

Degradation requirements:

- Binary file gives non-previewable hint
- Oversized diff gives cropping hint
- Patch generation failure gives unavailable hint

### 5. File Tree Sidebar

#### 5.1 Trigger Method

After clicking "Show file tree" button in toolbar, Git pane right side expands directory sidebar.

#### 5.2 Display Rules

- Sidebar only shows directory hierarchy
- Does not display files in sidebar
- Supports directory collapse/expand
- Supports "All directories" entry

#### 5.3 Filter Rules

- After selecting a directory, main area only displays file changes under that directory
- After switching back to "All directories", restores complete file list

### 6. Data Source Requirements

#### 6.1 Sources Allowed in Current Version

Current version allows mixed use of mock data and existing session data:

- `Not staged` / `Staged` / `All branch changes`: allows frontend mock first
- `Previous round changes`: preferentially reuses current task per-turn file snapshot and summary

#### 6.2 Not Required in Current Version

Current version does not require already connected:

- Real `git status`
- Real branch comparison
- Real file tree service
- Real commit identity reading

### 7. Write Operation Scope

Current version only opens 3 lightweight write operations in top menu:

- `commit`
- `push`
- `create branch`

This version still does not require:

- Stage single file
- Stage multi-select files
- Unstage
- Discard
- GitHub / GitLab PR creation

That is, write operation boundary of this version is "top single action", not complete Source Control panel.

### 8. Empty States and Errors

Current version needs to handle at least:

- Current source has no changes
- Current selected directory has no files
- Diff cannot be previewed

Following more complete error states can be supplemented in real service access stage:

- Git not installed
- Current workspace not inside Git repository
- Git repository corrupted
- Git command timeout or execution failure
- Remote connection disconnected

### 9. Log Requirements

Since Git pane is high interaction area, current version UI layer needs to retain logs.

At least record:

- Open/close Git pane
- Switch change source
- Expand/collapse file
- Open/close file tree
- Select directory

### 10. Subsequent Extension Direction

Without changing current UI baseline, subsequent can extend in stages:

1. Connect real `IGitService`
2. Let `Not staged` / `Staged` / `All branch changes` switch to real repository data
3. Then evaluate whether to restore commit area, identity hint area and batch operation area
4. Finally expand real stage / unstage / discard / commit capabilities
