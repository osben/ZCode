import { useEffect, useState } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { pendingCommandRegistry, type PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { isPendingCommandForWorkspace } from "@/v4/pendingCommandWorkspace.js";
import type { SessionDataLayer } from "@/v4/sessionDataLayer.js";

export interface UsePendingCommandRecoveryOptions {
  layer: SessionDataLayer;
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  status: "connecting" | "live" | "error" | "closed";
  subscriptionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * React seam for pending registry: settle projection using queue/guided/transcript anchors; remote queries
 * run only when the subscription generation becomes live, not repeatedly on high-frequency streaming snapshots.
 */
export function usePendingCommandRecovery({
  layer,
  sessionId,
  snapshot,
  status,
  subscriptionId,
  workspacePath,
  workspaceIdentity,
}: UsePendingCommandRecoveryOptions): readonly PendingCommandEntry[] {
  const [version, setVersion] = useState(0);

  useEffect(() => pendingCommandRegistry.subscribe(() => setVersion((current) => current + 1)), []);

  useEffect(() => {
    if (snapshot) pendingCommandRegistry.reconcileSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (status !== "live" || subscriptionId === null) return;
    // Current-session and createSession (null bucket) queries can run in parallel; the registry handles single-flight for each.
    const targets: Array<string | null> = sessionId === null ? [null] : [sessionId, null];
    void Promise.all(
      targets.map((target) =>
        pendingCommandRegistry.reconcileSession(target, (params) => layer.queryCommands(params)),
      ),
    ).catch((error) => {
      logger.warn("[v4-pending-command] 重连对账失败，保留账本等待下次连接", error);
    });
  }, [layer, sessionId, status, subscriptionId]);

  // version is the registry's narrow subscription signal; do not copy the entire ledger into React state.
  void version;
  const scoped = pendingCommandRegistry.listRecoverable(sessionId);
  const recoverableCreates = pendingCommandRegistry
    .listRecoverable(null)
    .filter((entry) => isPendingCommandForWorkspace(entry, workspacePath, workspaceIdentity));
  // The null bucket means createSession has not been bound to a session yet; it does not mean there is no workspace.
  // Every pane subscribes to the same registry, so isolate by workspace identity before displaying/consuming it.
  return sessionId === null ? recoverableCreates : [...scoped, ...recoverableCreates];
}
