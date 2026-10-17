// Local persistence for pane ↔ session binding (pane binding is local UI state in the Layout layer).
// Motivation: the old path used useTaskRestore (removed)
// to restore the selected task. Under v4, renderer refresh resets Zustand selection; without persistence, refresh sends the user
// back to a draft pane and makes the session that is streaming appear to disappear. The CLI/host process keeps running during renderer refresh,
// and after selection is restored the pane can resubscribe for snapshot + stream continuation.
// Restore only for the first workspace in the same renderer reload; app cold start and workspace-only
// entry points remain drafts and do not consume session bindings from the previous run.
import { useEffect, useRef } from "react";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";

const STORAGE_PREFIX = "zcode-v4-last-session:v1:";

function storageKey(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

export interface PersistedPaneSession {
  sessionId: string;
  readOnly?: boolean;
  selectionSideChat?: boolean;
}

export function readPersistedPaneSession(workspaceKey: string): PersistedPaneSession | null {
  try {
    const value = localStorage.getItem(storageKey(workspaceKey));
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "sessionId" in parsed &&
        typeof parsed.sessionId === "string" &&
        parsed.sessionId.length > 0
      ) {
        return {
          sessionId: parsed.sessionId,
          ...("readOnly" in parsed && parsed.readOnly === true ? { readOnly: true } : {}),
          ...("selectionSideChat" in parsed && parsed.selectionSideChat === true
            ? { selectionSideChat: true }
            : {}),
        };
      }
    } catch {
      // Previous versions stored the session ID as a plain string.
    }
    return { sessionId: value };
  } catch {
    return null;
  }
}

export function persistPaneSession(
  workspaceKey: string,
  sessionId: string | null,
  capabilities: { readOnly?: boolean; selectionSideChat?: boolean } = {},
): void {
  try {
    if (sessionId) {
      localStorage.setItem(
        storageKey(workspaceKey),
        JSON.stringify({
          sessionId,
          ...(capabilities.readOnly ? { readOnly: true } : {}),
          ...(capabilities.selectionSideChat ? { selectionSideChat: true } : {}),
        }),
      );
    } else {
      localStorage.removeItem(storageKey(workspaceKey));
    }
  } catch {
    // Degrade silently when storage is unavailable (tests/private browsing): refresh recovery is unavailable, but normal sessions still work.
  }
}

export interface UsePaneSessionPersistenceParams {
  workspaceKey: string;
  activeSessionId: string | null;
  /** Explicit user-intent generation for startDraft; when > 0, null means draft, not pending recovery. */
  draftFocusVersion: number;
  /** Mobile /remote does not consume local recovery state for desktop panes. */
  enabled?: boolean;
  /** Recovery entry point: use the same selection path as a task-list click so side effects (such as unread cleanup) remain consistent. */
  selectSession: (
    sessionId: string,
    capabilities?: Pick<PersistedPaneSession, "readOnly" | "selectionSideChat">,
  ) => void;
  activeReadOnly?: boolean;
  activeSelectionSideChat?: boolean;
}

export function shouldRestorePersistedPaneSession(params: {
  activeSessionId: string | null;
  draftFocusVersion: number;
  enabled: boolean;
  rendererReload: boolean;
}): boolean {
  return (
    params.enabled &&
    params.rendererReload &&
    params.activeSessionId === null &&
    params.draftFocusVersion === 0
  );
}

/**
 * Restores the previously bound session on mount; afterward, writes/clears persistence as selection changes.
 * Restore only once on the first mount for each workspaceKey—when the user explicitly returns to draft (new task),
 * that selection change clears the persisted key and the old session is not repeatedly restored.
 */
export function usePaneSessionPersistence({
  workspaceKey,
  activeSessionId,
  draftFocusVersion,
  enabled = true,
  selectSession,
  activeReadOnly = false,
  activeSelectionSideChat = false,
}: UsePaneSessionPersistenceParams): void {
  const restoredKeysRef = useRef<Set<string>>(new Set());
  // Only the first workspace after reload may consume a pane binding from before refresh; opening other
  // workspaces remains a workspace-only entry and must open drafts instead of restoring old sessions one by one.
  const rendererReloadRestoreAvailableRef = useRef(isRendererReloadNavigation());
  const pendingRestoreRef = useRef<{
    workspaceKey: string;
    binding: PersistedPaneSession;
  } | null>(null);
  const selectSessionRef = useRef(selectSession);
  selectSessionRef.current = selectSession;

  useEffect(() => {
    if (!enabled) return;
    if (restoredKeysRef.current.has(workspaceKey)) return;
    restoredKeysRef.current.add(workspaceKey);
    const rendererReload = rendererReloadRestoreAvailableRef.current;
    rendererReloadRestoreAvailableRef.current = false;
    if (
      !shouldRestorePersistedPaneSession({
        activeSessionId,
        draftFocusVersion,
        enabled,
        rendererReload,
      })
    ) {
      // Cold start and workspace-only entry points must remain drafts. Even an old last-session
      // from the previous app run must not write activeTaskId during this mount.
      if (activeSessionId === null) {
        persistPaneSession(workspaceKey, null);
      }
      return;
    }
    const stored = readPersistedPaneSession(workspaceKey);
    if (stored) {
      pendingRestoreRef.current = { workspaceKey, binding: stored };
      selectSessionRef.current(stored.sessionId, stored);
    }
    // Deliberately omit activeSessionId/draftFocusVersion from dependencies: recovery uses only the first-mount moment for the workspace;
    // explicit creation and selection changes afterward use the persistence effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    // Do not write the initial null before recovery completes; that would overwrite the pending value.
    if (!restoredKeysRef.current.has(workspaceKey)) return;
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore?.workspaceKey === workspaceKey) {
      if (activeSessionId === null) {
        return;
      }
      // Recovery and persistence effects belong to the same commit, so the latter's closure may still
      // read null from before recovery. Wait until selection is actually restored before writing, avoiding deletion of the reload recovery key.
      pendingRestoreRef.current = null;
    }
    persistPaneSession(workspaceKey, activeSessionId, {
      readOnly: activeReadOnly,
      selectionSideChat: activeSelectionSideChat,
    });
  }, [activeReadOnly, activeSelectionSideChat, activeSessionId, enabled, workspaceKey]);
}
