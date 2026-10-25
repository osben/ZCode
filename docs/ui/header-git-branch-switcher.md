# Header Workspace and Branch Hint

The workspace Header no longer shows the workspace capsule and branch switch entry after the task name. Workspace information is folded into a ghost icon button before the name: a local workspace shows Folder, a cloud/remote one shows Cloud.

Spacing between title-area elements is `gap-2` (8px); narrow mobile remote-control screens keep the existing compact `gap-1`. The Header's default left padding is 8px (`p-2`), matching the base right padding; when the sidebar is collapsed, space for the window control buttons is still reserved per platform.

## Behavior

- An existing task shows the icon entry; a new task draft keeps hiding the workspace context.
- On hover, keyboard focus or tap, the workspace name, the existing remote host identifier and the branch are shown below; a non-Git workspace omits the branch, and Detached HEAD reuses the existing localized text.
- The hint is a card overlay, fixed `w-72` (288px), `rounded-xl`, `bg-popover`, `shadow-md`, 12px padding and 12px row spacing. Two left-aligned rows, "workspace icon + name" and "branch icon + branch", use `text-ui-base`; long text wraps and icons do not shrink. No task statistics, path or action items are added.
- Mobile remote control also shows the compact icon, which can be tapped to view without depending on hover.
- The text and icons of the workspace and branch rows uniformly use `text-popover-foreground`, and the branch has no reduced opacity.
- The Header no longer offers a branch-switch action; `GitBranchSwitcher` elsewhere, such as the chat input area, keeps its original list, create and uncommitted-change protection flow.

## Data source

- The hint reads the existing `gitSummary` directly, and the branch name reuses `resolveGitBranchTriggerLabel`. No new Git service call is added.
- Local/remote detection, workspaceIdentity and remoteSessionId follow the existing boundaries and do not change connection or task state.
