import type { ZCodeProvider } from "@zcode/shared";

type DraftWorkspacePrepareReason = "mount" | "select-provider";
type WorkspacePrepareReason = DraftWorkspacePrepareReason | "retry" | "first-send";

interface ResolveDraftWorkspacePrepareReasonOptions {
  previousDraftProvider: ZCodeProvider | null;
  previousTaskProvider: ZCodeProvider | null;
  selectedProvider: ZCodeProvider;
  returningFromTask: boolean;
}

export function resolveDraftWorkspacePrepareReason({
  previousDraftProvider,
  previousTaskProvider,
  selectedProvider,
  returningFromTask,
}: ResolveDraftWorkspacePrepareReasonOptions): DraftWorkspacePrepareReason {
  // Bugfix: in the task -> draft scenario, if the user switched providers inside the task first,
  // this used to be uniformly judged as mount, so the draft kept the previous provider's
  // configOptions and the model dropdown briefly or persistently showed the old task's model.
  // Treat "provider changed" as select-provider first; only an unchanged provider takes the mount
  // path, balancing correctness with avoiding pointless loading.
  if (previousDraftProvider === null) {
    return "mount";
  }

  if (returningFromTask) {
    // Bugfix: the user may change the next draft's provider via the sidebar while still on the
    // old task detail. That overwrites workspace.selectedProvider early, making a
    // previousDraftProvider-only comparison misjudge "provider unchanged". Use the provider frozen
    // before leaving the task as the reference so task -> draft correctly detects cross-provider
    // switches and runs select-provider to clear stale config.
    const taskProviderBeforeDraft = previousTaskProvider ?? previousDraftProvider;
    return taskProviderBeforeDraft === selectedProvider ? "mount" : "select-provider";
  }

  return previousDraftProvider === selectedProvider ? "mount" : "select-provider";
}

interface ShouldShowDraftWorkspacePrepareLoadingOptions {
  taskId: string | null;
  reason: WorkspacePrepareReason;
  hasHydratedConfigOptions: boolean;
}

export function shouldShowDraftWorkspacePrepareLoading({
  taskId,
  reason,
  hasHydratedConfigOptions,
}: ShouldShowDraftWorkspacePrepareLoadingOptions): boolean {
  if (taskId) {
    return false;
  }

  if (reason === "select-provider") {
    return true;
  }

  // Bugfix: on a cold first screen, selectedProvider is restored from the last selection, but the
  // model config still waits for the async prepareWorkspace. The mount path previously never
  // entered loading, so the toolbar showed the default Agent with no "loading" hint. Add loading
  // only when no configOptions snapshot exists yet, fixing the silent first screen without
  // re-introducing flicker on task -> draft.
  return reason === "mount" && !hasHydratedConfigOptions;
}
