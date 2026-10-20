export interface TaskDeleteDialogRow {
  id: string;
  title: string;
  archived: boolean;
  pinned: boolean;
  taskId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  executionWorktree?: { path: string; branchName?: string };
}

export interface TaskDeleteWorktreeFile {
  path: string;
  status: string;
}

export interface TaskDeleteWorktreePreview {
  path: string;
  branchName?: string;
  files: TaskDeleteWorktreeFile[];
}
