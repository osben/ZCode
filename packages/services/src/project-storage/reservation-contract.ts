/**
 * Abandoned-create cleanup for reservation placeholders written by ProjectRepositoryContract.reserveCreatedTask. Kept as its own narrow
 * contract so contract.ts stays within the architecture public-method budget; ProjectRepositoryContract extends it.
 */
export interface ProjectReservationCleanupContract {
  /** Deletes a placeholder that has no CLI facts (create abandoned or rejected); rows with facts or other writers are untouched. Returns whether a row was removed. */
  discardCreatedTaskReservation(input: {
    task: { workspacePath: string; workspaceIdentity?: string; taskId: string };
  }): boolean;
}
