import { useEffect, useRef } from "react";
import type { IGitService } from "@zcode/services";
import { logger } from "@/logger.js";
import { useBranchMergeStatusStore } from "@/store/branchMergeStatusStore.js";

/** Sidebar refresh cadence for merge observations (server cache has the same TTL). */
const BRANCH_MERGE_STATUS_REFRESH_MS = 60_000;

export interface BranchMergeStatusTarget {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  gitService: IGitService;
}

/**
 * Probes branch merge status for the sidebar's workspaces on mount (sidebar
 * open) and on window focus. The runtime git service is the single owner of
 * the observation (TTL cache, branch-switch invalidation); this hook only
 * mirrors results into the store for task rows.
 *
 * Callers must memoize `targets`: the effect re-runs when a remote reconnect
 * rebuilds the service lookup. An old host without the method rejects the
 * call; the row then keeps no badge (new UI + old CLI degrades silently).
 */
export function useBranchMergeStatuses(targets: readonly BranchMergeStatusTarget[]): void {
  const setBranchMergeStatus = useBranchMergeStatusStore((state) => state.setBranchMergeStatus);
  const dropWorkspace = useBranchMergeStatusStore((state) => state.dropWorkspace);

  const lastFetchAtByKey = useRef(new Map<string, number>());
  const writeSequenceByKey = useRef(new Map<string, number>());
  const warnedKeys = useRef(new Set<string>());

  const targetKeys = targets.map((target) => target.workspaceKey).join("\u0000");
  const previousKeysRef = useRef<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function probeAll(): Promise<void> {
      const now = Date.now();
      const dueTargets = targets.filter((target) => {
        const lastFetchAt = lastFetchAtByKey.current.get(target.workspaceKey);
        return lastFetchAt === undefined || now - lastFetchAt >= BRANCH_MERGE_STATUS_REFRESH_MS;
      });
      if (dueTargets.length === 0) {
        return;
      }
      for (const target of dueTargets) {
        lastFetchAtByKey.current.set(target.workspaceKey, now);
      }

      await Promise.allSettled(
        dueTargets.map(async (target) => {
          // Stale-result rule: only the newest probe per workspace may write.
          const sequence = (writeSequenceByKey.current.get(target.workspaceKey) ?? 0) + 1;
          writeSequenceByKey.current.set(target.workspaceKey, sequence);
          try {
            const status = await target.gitService.getBranchMergeStatus({
              workspacePath: target.workspacePath,
              ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            });
            if (cancelled || writeSequenceByKey.current.get(target.workspaceKey) !== sequence) {
              return;
            }
            warnedKeys.current.delete(target.workspaceKey);
            setBranchMergeStatus(target.workspaceKey, status);
          } catch (error) {
            if (cancelled || writeSequenceByKey.current.get(target.workspaceKey) !== sequence) {
              return;
            }
            // Repeat failures (e.g. an old host without the method) warn once
            // per workspace instead of on every focus refresh.
            if (!warnedKeys.current.has(target.workspaceKey)) {
              warnedKeys.current.add(target.workspaceKey);
              logger.warn(
                `branch merge status unavailable for ${target.workspaceKey}`,
                error instanceof Error ? error.message : error,
              );
            }
            // Allow the next focus to retry instead of holding the 60s gate.
            lastFetchAtByKey.current.delete(target.workspaceKey);
          }
        }),
      );
    }

    void probeAll();

    const onFocus = () => {
      void probeAll();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [targets, setBranchMergeStatus]);

  // Drop store entries for workspaces that left the sidebar.
  useEffect(() => {
    const targetKeyList = targetKeys ? targetKeys.split("\u0000") : [];
    const previousKeys = previousKeysRef.current;
    if (previousKeys) {
      for (const key of previousKeys) {
        if (!targetKeyList.includes(key)) {
          dropWorkspace(key);
          lastFetchAtByKey.current.delete(key);
          writeSequenceByKey.current.delete(key);
          warnedKeys.current.delete(key);
        }
      }
    }
    previousKeysRef.current = targetKeyList;
  }, [targetKeys, dropWorkspace]);
}
