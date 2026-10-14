import { useMemo, useRef } from "react";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { useActiveTaskSnapshotMeta } from "@/hooks/useActiveTaskSnapshotMeta.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import {
  getTaskMeta,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

interface UseWorkspaceActiveTaskStateParams {
  workspaceAbsPath: string;
  activeTaskId: string | null;
  workspaceRemoteSessionId?: string | null;
  workspaceIdentity?: string;
  selectedProvider: ZCodeProvider;
  intl: {
    formatMessage(descriptor: { id: string }): string;
  };
}

function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areResolvedTaskMetasEqual(left: ZCodeTaskMeta | null, right: ZCodeTaskMeta | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.title === right.title &&
    left.titleOverridden === right.titleOverridden &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.mode === right.mode &&
    left.model === right.model &&
    left.thoughtLevel === right.thoughtLevel &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.provider === right.provider &&
    left.migrationSource === right.migrationSource &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.unreadAt === right.unreadAt &&
    left.status === right.status &&
    areTaskMetaJsonFieldsEqual(left.lastError, right.lastError) &&
    areTaskMetaJsonFieldsEqual(left.repairState, right.repairState) &&
    areTaskMetaJsonFieldsEqual(left.changeSummary, right.changeSummary) &&
    areTaskMetaJsonFieldsEqual(left.executionWorktree, right.executionWorktree) &&
    areTaskMetaJsonFieldsEqual(left.target, right.target)
  );
}

export function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {
  const stableTaskMetaRef = useRef<ZCodeTaskMeta | null>(null);
  const stableTaskMeta = stableTaskMetaRef.current;
  // When a stream chunk updates only the message stream, active task metadata may be recomposed by
  // the list/optimistic layer with equal fields but a new reference. Header/Shell rely on memoized
  // props, so reuse the old reference for equivalent metadata to avoid rerendering the title bar
  // on every streaming update.
  if (!areResolvedTaskMetasEqual(stableTaskMeta, taskMeta)) {
    stableTaskMetaRef.current = taskMeta;
  }
  return stableTaskMetaRef.current;
}

export function useWorkspaceActiveTaskState({
  workspaceAbsPath,
  activeTaskId,
  workspaceRemoteSessionId,
  workspaceIdentity,
  selectedProvider,
  intl,
}: UseWorkspaceActiveTaskStateParams) {
  const workspaceState = useZCodeSessionStore((state) =>
    selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity),
  );
  const activeTaskQueryMeta = useTaskQueryCacheStore((state) => {
    if (!activeTaskId) {
      return null;
    }
    return (
      state.taskMetaByEntityKey[
        buildTaskEntityKey({
          taskId: activeTaskId,
          workspacePath: workspaceAbsPath,
          workspaceIdentity,
        })
      ] ?? null
    );
  });
  const activeTaskMeta = useMemo(() => {
    if (!activeTaskId) {
      return null;
    }

    // The App previously relied on zcodeTaskMetaMerge to fetch both the regular and pinned lists
    // just to find metadata for the active task. Any list refresh then rerendered the entire App.
    // Read the merged taskListCache and optimistic metadata directly from the workspace store instead.
    // Regular tasks are available synchronously; snapshot metadata remains the fallback for pinned
    // and archived tasks, so the App no longer needs to subscribe to the old list hook continuously.
    // After restart recovery, raw snapshot metadata may enter the workspace store before the SQLite/list
    // query cache, which may still contain a manually overridden title. The Header must merge both
    // using the same title authority; otherwise the current task can appear to revert to a generated
    // title or its first query.
    return (
      mergeTaskMetaCandidates(getTaskMeta(workspaceState, activeTaskId), activeTaskQueryMeta) ??
      null
    );
  }, [activeTaskId, activeTaskQueryMeta, workspaceState]);

  const activeTaskSnapshotMeta = useActiveTaskSnapshotMeta(
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    activeTaskMeta,
  );
  const resolvedActiveTaskMeta = useStableResolvedActiveTaskMeta(
    activeTaskMeta ?? activeTaskSnapshotMeta,
  );
  // Store cleanup: taskMessagesByTaskId has no writers now that the old ChatView and broadcast
  // message replay have been retired. The live change summary derived from the message stream is
  // always empty; display falls back to task meta.changeSummary from persistence.
  const activeTaskChangeSummary = null;
  const activeTraceId = resolvedActiveTaskMeta?.traceId ?? null;
  const activeSessionId = resolvedActiveTaskMeta?.taskId ?? null;
  const activeTaskProvider = resolvedActiveTaskMeta?.provider ?? null;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    selectedProvider,
  );
  const activeTaskBaseTitle = resolvedActiveTaskMeta?.title?.trim()
    ? resolvedActiveTaskMeta.title
    : intl.formatMessage({
        id: resolvedActiveTaskMeta?.forkedFromTaskId
          ? "taskList.forkedUntitled"
          : "taskList.newThread",
      });
  const activeTaskTitle = activeTaskBaseTitle;
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspaceAbsPath,
    activeTaskId,
    activeTaskProvider,
    workspaceIdentity,
  );
  const taskSessionFile = useTaskSessionFilePath(workspaceAbsPath, activeTaskId, workspaceIdentity);

  return {
    activeTaskMeta,
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  };
}
