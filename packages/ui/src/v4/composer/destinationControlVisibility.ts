interface ComposerDestinationGitState {
  workspaceKey: string;
  loading: boolean;
  summary: {
    isGitAvailable: boolean;
    isRepository: boolean;
  };
}

export function shouldRenderComposerDestinationControl(input: {
  activeWorkspaceKey: string;
  gitState: ComposerDestinationGitState;
}): boolean {
  const { activeWorkspaceKey, gitState } = input;
  return (
    gitState.workspaceKey === activeWorkspaceKey &&
    gitState.summary.isGitAvailable &&
    gitState.summary.isRepository
  );
}
