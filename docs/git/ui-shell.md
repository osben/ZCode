# Git UI Landing Status

## Current Target

The Git pane's "read real repository changes" main chain is connected, and a top lightweight write entry is added. The user can keep browsing changes and also commit or push from the top entry without leaving the current workspace.

## Commit Message Generation

- The top "commit" popup is a compact lightweight operation panel in a standard overlay: current branch and the selection's `+/-` statistic at the top, the commit message input in the middle, the commit action list at the bottom.
- The branch entry at the top of the popup reuses `GitBranchSwitcher`; clicking it only expands the switchable local branch list. After a successful switch the current branch's commit range is re-read so the old branch's staged / unstaged snapshot is not shown.
- The popup `+/-` statistic prefers the current conversation's file modification summary, so a conversation that touched a few files is not inflated by other uncommitted changes in the work area; without a conversation summary it falls back to the Git statistic of the current commit range.
- The commit message input supports manual entry and generation by clicking an icon. If the user clicks `commit` / `commit and push` with an empty message, UI first generates a Conventional Commit message and then continues the action.
- Acceptance (QA ISSUE-043): the commit popup is a `Dialog` with a title and description. The title is an sr-only `DialogTitle` (`git.actionMenu.commitDialog.title`, "Commit changes") rendered before the loading or form branch, so the dialog has an accessible name from its first open and Radix emits no missing-title warning. The description is an sr-only `DialogDescription` from `git.actionMenu.commitDialog.description`. The changed-file count uses the explicit plural family `git.actionMenu.commitDialog.changesValue.one|.other` through `intl.formatPlural`, so one file reads "1 file". Catalogs follow this repo's plural-family convention, not ICU syntax, because `createIntl.formatMessage` only substitutes `{key}` placeholders.
- The commit panel includes unstaged changes by default; the user can turn off `包含未暂存的更改` (include unstaged changes), after which commit, statistics and message generation reference only staged changes.
- Generation carries the recent user / assistant text of the current conversation so the model understands the intent of this round; context is trimmed by message count and character count, and the generated result must not explicitly write meta-narration such as "according to the conversation" or "per the user's request".
- Generation reuses the current workspace's model selection. The Git service only reads Git status/diff, builds a limited prompt and validates Conventional Commit output.
- Model call chain: `Git service -> IZCodeAgentService -> ZCode Protocol workspace/generateText -> AgentRuntime -> modelAdapter.generateText`.
- UI does not prefetch request-time auth material for Start Plan / zcode-plan for commit message generation, and passes no scoped runtime headers to the Git service.
- Start Plan request-time runtime headers are refreshed by AgentRuntime through `providerRuntimeHeaders.request` before every real `modelAdapter.generateText` request, the same as ordinary conversation, prompt enhance and other independent model requests.
- The Git service does not call an OpenAI / Anthropic compatible HTTP endpoint directly and does not parse provider responses / SSE; after the protocol layer returns plain text, the Git service cleans the output and converges errors.

## Completed UI

### 1. Top Entry

- The `WorkspaceHeader` top toolbar has the Git entry.
- When the work area has `+/-` line statistics, the top shows an integrated capsule button "Git icon + +/- statistic", also when the Git pane is not open, so the user knows about changes without opening Git.
- Click opens or closes the right Git pane.

### 2. Right Git Pane

- Reuses the right shared pane, sharing the slot with browser / code-viewer.
- The pane top keeps the title and close button.
- The body is a lighter single-column reading mode, avoiding too many operation areas up front.

### 3. Top Git Operation Entry

- A "commit or push" capsule entry sits left of the terminal switch button in the `WorkspaceHeader` top toolbar.
- The main button runs `commit` first according to the current Git status; with no uncommitted changes but pushable commits it runs `push`.
- No three-dots / dropdown menu, so commit and push do not become two parallel paths.
- `commit` opens an independent commit popup that by default stages and commits all uncommitted changes within the current workspace scope.
- The commit popup also provides `commit and push`; after a successful commit it reuses the same Git service to push the current branch.
- `push` opens an independent push popup and runs a real `git push`; when the current branch has no upstream, the first push adds `--set-upstream`.

### 4. Source Switch

- Four sources: `Not staged`, `Staged`, `All branch changes`, `Previous round changes`.
- The selected source is lifted into `App`, so the top entry statistic and the Git pane content always come from the same source.

### 5. File List and Diff

- Items show the workspace-relative full path.
- File items expand / collapse; expanded, they show the inline diff directly without repeating path and `+/-`.
- Non-`Not staged` items show a status badge by section, for example `Untracked`, `Conflicted`, `Staged`.
- Diff uses the existing `PatchDiff` component and reuses the code preview theme configuration.

### 6. File Tree Sidebar

- "Show file tree" expands a directory sidebar on the right of the Git pane.
- Sidebar width is draggable and keeps the last dragged width.
- A "filter files..." search box at the top filters instantly by file relative path in the current tree.
- The sidebar shows directory and file leaf nodes; while filtering, ancestors of hit files are kept for hierarchy positioning.
- Selecting a directory filters the main file list. Selecting a file leaf narrows the main area to that single file. Clicking the currently selected directory or file again returns to the full list.
- The tree supports directory fold / unfold.

### 7. Conversation Input Area Bottom Bar

- The input box interior keeps only editing controls (input area, attachment, send / stop button).
- Current agent, current model, mode setting and token context statistics are split out of the input box shell into a bottom bar below the input box.
- The Git branch switch entry shares this bar and is fixed at the far right, reducing horizontal crowding inside the input box.
- The current agent icon follows the task provider currently being viewed, so switching to a history or fork task does not show something inconsistent with the real conversation.

## Current Data Source

Real Git data (connected to the real `IGitService`): `Not staged`, `Staged`, `All branch changes`.

- `useGitRepository` reads `refresh / getChanges / getBranchComparison` through `services.gitService`.
- `App` fetches the real repository snapshot once; the header and the Git pane reuse the same status, avoiding duplicate Git commands.
- Single-file diff is loaded on demand in the Git pane through `getDiff`, so the top entry statistic does not trigger full diff reads.

Semi-real data: `Previous round changes` prefers the current task's per-turn file snapshot and summary from the ZCode task store; this is the data source closest to real agent output.

## Current Interaction Boundary

Not a complete Source Control workbench, but a set of lightweight write operations is exposed at the top: frontend `commit`, `push`, `create branch`.

Not exposed: frontend `stage / unstage / discard`; commit area and batch operation area.

Connected read-only capabilities: real `git status`, real branch comparison, real single-file diff, real `user.name / user.email` reading (not displayed in UI yet).

`packages/ui/src/hooks/useGitActions.ts` remains a placeholder extension point that can be reused when the service is connected.

## Key Implementation Files

- `packages/ui/src/App.tsx`
- `packages/ui/src/v4/ConversationComposer.tsx`
- `packages/ui/src/GitBranchSwitcher.tsx`
- `packages/ui/src/GitActionMenu.tsx`
- `packages/ui/src/WorkspaceHeader.tsx`
- `packages/ui/src/GitPane.tsx`
- `packages/ui/src/git-action-menu/display.ts`
- `packages/ui/src/hooks/useGitRepository.ts`
- `packages/ui/src/lib/workspaceSidePane.ts`
- `packages/services/src/git/gitService.ts`
- `packages/services/src/git/repo/gitCliRepo.ts`

## Tests

`packages/services/test/gitService.test.ts`, `packages/ui/test/gitActionMenuDisplay.test.ts`, `packages/ui/test/gitBranchSwitcherDisplay.test.ts`.

## Follow-ups

1. Decide whether the Git pane restores `stage / unstage / discard` with a batch operation area.
2. Add more empty states, failure states and permission hints for the top commit / push menu.
3. Keep refining Git interaction for empty / non-repository / Git-unavailable scenarios.
