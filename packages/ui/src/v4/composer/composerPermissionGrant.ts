import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/** Consume only explicit approval facts; a repeated snapshot must not overwrite a permission the user later changed back to yolo. */
export function applyComposerPermissionGrant(
  draft: V4ComposerDraft,
  grant: SessionConfigState["permissionGrant"],
): V4ComposerDraft {
  if (!grant || draft.lastPermissionGrantId === grant.interactionId) return draft;
  return { ...draft, mode: "yolo", lastPermissionGrantId: grant.interactionId };
}
