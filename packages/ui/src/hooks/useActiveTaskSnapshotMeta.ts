import { useEffect, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { zcodeSessionSnapshotToTaskMeta } from "@/lib/zcodeSessionProjection.js";

function resolveImmediateActiveTaskSnapshotMeta(
  previousSnapshotMeta: ZCodeTaskMeta | null,
  taskId: string | null,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  if (!taskId || taskMetaFromLists) {
    return null;
  }

  // When switching to a pinned/archived task that is not initially in the list source, do not keep using the previous
  // task's snapshot metadata while the new snapshot is pending. Otherwise Header briefly shows the old title before the
  // async result corrects it, making the name feel delayed. Reuse an old snapshot only for the same taskId; clear it immediately across tasks.
  return previousSnapshotMeta?.taskId === taskId ? previousSnapshotMeta : null;
}

/**
 * Provide fallback snapshot metadata for the currently active task.
 *
 * Archived tasks are not in the regular taskListCache/pinnedTasks sources, so opening one directly leaves App without
 * title/provider/traceId fields if it relies on list metadata alone. When the current task is absent from the list, read
 * snapshot.meta once as a display fallback. This serves only the active task and does not add archived tasks to the regular list.
 */
export function useActiveTaskSnapshotMeta(
  workspacePath: string,
  taskId: string | null,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  const zcodeSessionService = useZCodeSessionService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [snapshotMeta, setSnapshotMeta] = useState<ZCodeTaskMeta | null>(null);

  useEffect(() => {
    let cancelled = false;

    setSnapshotMeta((currentSnapshotMeta) =>
      resolveImmediateActiveTaskSnapshotMeta(currentSnapshotMeta, taskId, taskMetaFromLists),
    );

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    if (taskMetaFromLists) {
      return () => {
        cancelled = true;
      };
    }

    void zcodeSessionService
      // The active header needs only session metadata/title fallback, so use the lightweight ZCode Protocol read instead
      // of loading the full task message through the legacy snapshot.
      .readSession({
        workspacePath,
        workspaceIdentity,
        sessionId: taskId,
        messageLimit: 1,
      })
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(zcodeSessionSnapshotToTaskMeta(snapshot));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(null);
      });

    return () => {
      cancelled = true;
    };
  }, [zcodeSessionService, taskId, taskMetaFromLists, workspaceIdentity, workspacePath]);

  return snapshotMeta;
}
