import { create } from "zustand";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";

export type ComposerAttachmentUploadStatus =
  | "waitingSession"
  | "queued"
  | "uploading"
  | "committing"
  | "ready"
  | "failed";

export interface ComposerAttachmentUploadItem extends ChatComposerAttachment {
  /**
   * composer-owned remains in the upload/staging lifecycle; session-owned is an existing ref withdrawn from the authoritative queue.
   * The latter has already been taken over by the session, so runtime restart, cleanup, and resend must not process reference ownership again.
   */
  referenceOwnership: "composer" | "session";
  uploadStatus: ComposerAttachmentUploadStatus;
  uploadProgress: number;
  uploadError?: string;
  uploadErrorKind?: "transient" | "permanent" | "runtimeRestarted";
  attachmentRef?: AttachmentRef;
  operationId: string;
  autoRetryCount: number;
  /**
   * Retransmissions triggered by a runtime generation change are counted separately from retries after upload failure.
   * A generation change is not an "upload failure"; sharing a counter would consume the user's visible retry allowance on the first generation change.
   */
  runtimeRebuildRetryCount: number;
  staged: boolean;
  adopted: boolean;
  showComplete: boolean;
  localZeroCopy: boolean;
}

interface ComposerAttachmentUploadStoreState {
  scopes: Record<string, ComposerAttachmentUploadItem[]>;
}

/**
 * Renderer in-memory state: File/object URLs are not persisted, but survive task/composer switches and partial unmounts.
 * The upload controller remains in the hook closure that started the operation; relay/main do not store business state.
 */
export const useComposerAttachmentUploadStore = create<ComposerAttachmentUploadStoreState>()(
  () => ({ scopes: {} }),
);

declare global {
  interface Window {
    __zcodeComposerAttachmentUploadStoreE2E?: typeof useComposerAttachmentUploadStore;
    __zcodeCurrentComposerAttachmentScopeKeyE2E?: string;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E exposes only the current attachment owner for scope-switch test setup; attachments are no longer put back into the legacy Session Store.
  window.__zcodeComposerAttachmentUploadStoreE2E = useComposerAttachmentUploadStore;
}

export function exposeComposerAttachmentScopeKeyForE2E(scopeKey: string): void {
  if (window.__zcodeComposerAttachmentUploadStoreE2E) {
    window.__zcodeCurrentComposerAttachmentScopeKeyE2E = scopeKey;
  }
}

export function readComposerAttachmentScope(scopeKey: string): ComposerAttachmentUploadItem[] {
  return useComposerAttachmentUploadStore.getState().scopes[scopeKey] ?? [];
}

/** One atomic ownership transfer; File/object URLs are moved, never copied or re-created. */
export function moveComposerAttachmentScopeItems(
  source: string,
  target: string,
  ids: readonly string[],
): void {
  if (source === target) return;
  const selected = new Set(ids);
  useComposerAttachmentUploadStore.setState((state) => {
    const owned = (state.scopes[source] ?? []).filter((item) => selected.has(item.id));
    const remaining = (state.scopes[source] ?? []).filter((item) => !selected.has(item.id));
    const scopes = {
      ...state.scopes,
      [target]: [
        ...(state.scopes[target] ?? []).filter((item) => !selected.has(item.id)),
        ...owned,
      ],
    };
    if (remaining.length) scopes[source] = remaining;
    else delete scopes[source];
    if (!scopes[target]?.length) delete scopes[target];
    return { scopes };
  });
}

export function updateComposerAttachmentScope(
  scopeKey: string,
  update: (current: ComposerAttachmentUploadItem[]) => ComposerAttachmentUploadItem[],
): void {
  useComposerAttachmentUploadStore.setState((state) => {
    const next = update(state.scopes[scopeKey] ?? []);
    if (next.length === 0) {
      const { [scopeKey]: _removed, ...remainingScopes } = state.scopes;
      return { scopes: remainingScopes };
    }
    return {
      scopes: {
        ...state.scopes,
        [scopeKey]: next,
      },
    };
  });
}
