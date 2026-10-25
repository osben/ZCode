import { formatTaskDeletionResult } from "@/task-deletion/taskDeletion.js";
import { useCallback, useEffect, useState } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";

/**
 * Hidden sessions whose content still sits in the CLI store (specs/session-deletion-cascade.md §3).
 * `sessions` is null while unknown or when the host cannot answer (older CLI, remote-only setup); the
 * maintenance row stays hidden in that case. RPC proxies answer any property access with a function, so
 * support is only confirmed by a call that resolves.
 */
export function useHiddenSessionsMaintenance(
  formatMessage: (id: string, values?: Record<string, string | number>) => string,
  enabled = true,
) {
  const service = useBaseWorkspaceServices().zcodeTaskService;
  const [sessions, setSessions] = useState<number | null>(null);
  const [worktrees, setWorktrees] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setSessions(null);
      setWorktrees(0);
      return;
    }
    try {
      const result = await service.countHiddenTaskContent?.();
      setSessions(result ? result.sessions : null);
      setWorktrees(result?.worktrees ?? 0);
    } catch (error) {
      logger.warn("[SessionManager] hidden content count failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      setSessions(null);
    }
  }, [enabled, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const erase = useCallback(async () => {
    setBusy(true);
    try {
      const result = await service.eraseHiddenTaskContent?.();
      if (!result) {
        toast(formatMessage("sessionManager.erase.unsupported"));
        return;
      }
      if (
        result.worktreeCleanup.removedCount ||
        result.worktreeCleanup.retainedCount ||
        result.worktreeCleanup.failedCount
      ) {
        toast(
          formatTaskDeletionResult(
            {
              tombstoned: 0,
              erased: result.erasedTaskIds.length,
              skipped: result.skippedTaskIds.length,
              running: result.blockedRunningTaskIds.length,
              unsupported: 0,
              failed: result.failedTaskIds.length,
              sessionFileFailures: result.fileFailureCount,
              filesRetained: result.filesRetainedCount,
              worktreeCleanup: result.worktreeCleanup,
            },
            formatMessage,
          ),
        );
      }
      const kept =
        result.skippedTaskIds.length +
        result.blockedRunningTaskIds.length +
        result.failedTaskIds.length;
      if (result.fileFailureCount > 0) {
        toast(formatMessage("sessionManager.erase.filesFailed"));
      }
      if (kept > 0) {
        toast(
          formatMessage("sessionManager.erase.result", {
            erased: String(result.erasedTaskIds.length),
            kept: String(kept),
          }),
        );
      }
    } catch (error) {
      logger.error("[SessionManager] hidden content erase failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      toast(formatMessage("sessionManager.mutationFailed"));
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [formatMessage, refresh, service]);

  return { sessions, worktrees, busy, refresh, erase };
}
