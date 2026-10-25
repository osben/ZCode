// React binding for sessions-index: one read-only SessionsIndexStore plus a transport
// connection per consumer. The sidebar/task list consume this hook for session summaries,
// replacing the zustand task state (08-phasing M5 step 2); when multiple list consumers share
// one workspace subscription they go through sessionsIndexRegistry (reference-counted store
// reuse).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { createAgentSessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore, type SessionsIndexStoreStatus } from "@/v4/sessionsIndexStore.js";

export interface UseSessionsIndexResult {
  sessions: SessionSummary[];
  status: SessionsIndexStoreStatus;
}

/**
 * Subscribes to a workspace's sessions-index and returns the session summary list (sorted by
 * lastActivityAt descending by default). Lifecycle: the store is rebuilt and reconnected when
 * the workspace changes; closed (unsubscribed + listeners removed) on unmount.
 */
export function useSessionsIndex(
  workspacePath: string,
  workspaceIdentity?: string,
): UseSessionsIndexResult {
  const { zcodeAgentService } = useServices();

  const store = useMemo(
    () => new SessionsIndexStore(),
    // One store instance per workspace (dependency change → cold start with a fresh store).
    [workspacePath, workspaceIdentity, zcodeAgentService],
  );

  useEffect(() => {
    const transport = createAgentSessionsIndexTransport(zcodeAgentService, {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    void store.connect(transport, { forceSnapshot: true });
    return () => store.close();
  }, [store, workspacePath, workspaceIdentity, zcodeAgentService]);

  // useSyncExternalStore: store.subscribe/getState are class-field arrow functions with stable references.
  const state = useSyncExternalStore(store.subscribe, store.getState);
  // A state change means the list may have changed; getSessions caches a stable reference internally.
  const sessions = useMemo(() => store.getSessions(), [store, state]);

  return { sessions, status: store.getStatus() };
}
