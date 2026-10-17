export interface ComposerSubmissionOwner {
  workspaceKey: string;
  scopeId: string;
  revision: number;
  epoch?: number;
}

/** A reused Composer must never apply an old submission's callbacks to its new owner. */
export function isComposerSubmissionOwnerCurrent(
  submitted: ComposerSubmissionOwner,
  current: ComposerSubmissionOwner,
): boolean {
  return (
    submitted.workspaceKey === current.workspaceKey &&
    submitted.scopeId === current.scopeId &&
    submitted.epoch === current.epoch &&
    submitted.revision === current.revision
  );
}
