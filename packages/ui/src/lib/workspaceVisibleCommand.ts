export function runWorkspaceVisibleCommand({
  isWorkspaceVisible,
  onReturnToWorkspace,
  run,
}: {
  isWorkspaceVisible: boolean;
  onReturnToWorkspace?: () => void;
  run: () => void;
}) {
  if (!isWorkspaceVisible) {
    // The settings page only overlays the workspace; the underlying App still responds to quickpick/keyboard shortcuts.
    // Running workspace commands such as sidebar, terminal, or file search directly changes the covered workspace, making them appear ineffective.
    // Switch back to the workspace before running the command so the result is immediately visible.
    onReturnToWorkspace?.();
  }

  run();
}
