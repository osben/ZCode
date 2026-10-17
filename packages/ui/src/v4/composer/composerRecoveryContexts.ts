/**
 * Re-establish the frozen submission's contexts on Restore (specs/composer-worktree-setup-steps.md
 * "recovery record is a typed snapshot of the entire frozen submission"). Seeding goes through the
 * same add paths the picker UIs use (window events / scope stores), so the composer hooks pick the
 * contexts up exactly like a fresh attach. The caller clears the current contexts first: restored
 * contexts replace, never merge with, a newer draft's contexts.
 */
import { dispatchConversationSelectionAdd } from "@/lib/conversationSelectionReference.js";
import { dispatchCodeCommentAddToChat } from "@/lib/codeCommentContext.js";
import { dispatchWebElementContextAddToChat } from "@/lib/webElementContext.js";
import { dispatchPptxElementReferenceAddToChat } from "@/lib/pptxElementReference.js";
import { dispatchPluginUiModelContextAdd } from "@/plugin-ui/adapters/pluginUiModelContextEvents.js";
import type { V4ComposerRecoveryContexts } from "@/v4/composer/composerDraftStore.js";

export function restoreComposerRecoveryContexts(
  contexts: V4ComposerRecoveryContexts | undefined,
  options: {
    /** Raw composer session id (null in the draft); quote scopes key on it directly. */
    sessionId: string | null;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
  },
): void {
  if (!contexts || typeof window === "undefined") return;
  for (const reference of contexts.conversationQuotes ?? []) {
    dispatchConversationSelectionAdd({
      targetSessionId: options.sessionId,
      workspaceKey: options.workspaceKey,
      reference,
    });
  }
  // The stored attachment types extend the dispatch payload types, so the frozen items pass the
  // add-path guards unchanged (including their original ids).
  for (const payload of contexts.codeComments ?? []) {
    dispatchCodeCommentAddToChat(payload);
  }
  for (const payload of contexts.webElements ?? []) {
    dispatchWebElementContextAddToChat(payload);
  }
  for (const reference of contexts.pptxElements ?? []) {
    dispatchPptxElementReferenceAddToChat(reference);
  }
  // Plugin contexts restore only while their plugin session receiver is live; a gone plugin
  // session is an ephemeral resource that requires explicit re-attachment.
  for (const context of contexts.pluginUiContexts ?? []) {
    dispatchPluginUiModelContextAdd(
      {
        workspacePath: options.workspacePath,
        ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
        sessionId: context.sessionId,
      },
      context,
    );
  }
}
