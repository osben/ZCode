import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/** A new tool result sets the marker directly; only deduplicate processed results, without protecting manual changes made in the meantime. */
export function applyComposerPlanTransition(
  draft: V4ComposerDraft,
  transition: SessionConfigState["planTransition"],
): V4ComposerDraft {
  if (!transition || draft.lastPlanTransitionId === transition.toolCallId) return draft;
  return {
    ...draft,
    lastPlanTransitionId: transition.toolCallId,
    planEnabled: transition.planEnabled,
  };
}
