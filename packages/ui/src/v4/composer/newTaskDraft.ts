import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/** Ordinary new tasks and first-time share imports share initialization; preserve the original Recent intent and let the common View resolve the valid selection. */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/** Call before activating the first imported Session; do not require an executable model or include the original new-task body in the share. */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
  // Import has already created a real Session; the old initialization treated an empty snapshot as a confirmed selection and skipped new-task rules.
  // Explicitly mark the first-import source instead of inferring from “session has no model”; preserve an explicit empty selection from Root too.
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          planEnabled: root.planEnabled ?? false,
          modelSelection: root.modelSelection,
        }
      : { text: "", initializeFromNewTask: true },
  );
}
