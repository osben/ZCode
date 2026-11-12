import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { mutateProjectTask } from "@/project-sidebar/task-mutation.js";
import { archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useTaskDeleteDialog } from "@/hooks/useTaskDeleteDialog.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { TaskDeleteTarget } from "@/task-deletion/taskDeletion.js";
import { logger } from "@/logger.js";

export type ArchiveOperation = "unarchive" | "delete";

/**
 * Owner of Settings → Archives selection and actions. Restore runs through the task mutation lane.
 * Delete is permanent and is handed to the single permanent-delete owner (useTaskDeleteDialog)
 * after the Web-remote gate and the remote-row exclusion; it never uses the soft delete mutation.
 */
export function useArchiveManagement({
  allowPermanentDelete = false,
}: { allowPermanentDelete?: boolean } = {}) {
  const directory = useProjectDirectory();
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const { intl, locale } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    succeeded: number;
    failed: number;
    skipped: number;
    details: string[];
  } | null>(null);
  const activeOperation = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeOperation.current?.abort();
      activeOperation.current = null;
    },
    [],
  );
  const latest = useRef(directory);
  latest.current = directory;
  const refreshDirectory = useCallback(() => latest.current.refresh(), []);
  const permanentDelete = useTaskDeleteDialog(refreshDirectory);

  const requestPermanentDelete = (tasks: ProjectTask[]) => {
    if (
      !allowPermanentDelete ||
      activeOperation.current ||
      permanentDelete.busy ||
      permanentDelete.pending
    )
      return;
    // Freeze the confirmed identity set: search changes, new archives and repeated clicks must not expand a confirmed batch.
    const candidates = archivedCandidates(tasks);
    if (!candidates.length) return;
    const local = candidates.filter((task) => !isRemoteArchiveTask(task));
    const remote = candidates.filter(isRemoteArchiveTask);
    const remoteNotice = remote.length
      ? intl.formatMessage(
          { id: "taskList.deleteAllArchivedUnavailable" },
          {
            projects: new Intl.ListFormat(locale, { type: "conjunction" }).format([
              ...new Set(remote.map((task) => getPathLeaf(task.workspacePath))),
            ]),
          },
        )
      : undefined;
    if (local.length === 0) {
      permanentDelete.reportResult(remoteNotice ?? null);
      return;
    }
    permanentDelete.openRows(local.map(toPermanentDeleteTarget), { notice: remoteNotice });
  };

  const run = async (tasks: ProjectTask[], operation: ArchiveOperation) => {
    if (operation === "delete") {
      requestPermanentDelete(tasks);
      return;
    }
    if (activeOperation.current || !tasks.length) return;
    const candidates = archivedCandidates(tasks);
    if (!candidates.length) return;
    const operationLifetime = new AbortController();
    activeOperation.current = operationLifetime;
    setBusy(true);
    setResult(null);
    const counts = { succeeded: 0, failed: 0, skipped: 0, details: [] as string[] };
    const msg = (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id: `archives.${id}` }, values);
    const reason = (value?: string) =>
      msg(
        `reason.${value && ["running", "in-use", "not-found", "not-archived", "changed"].includes(value) ? value : "unavailable"}`,
      );
    const label = (task: ProjectTask) => {
      const project =
        latest.current.tree.projects.find((project) => project.id === task.projectId)?.name ??
        msg("unclassified");
      const host = latest.current.directory.hosts.find((host) => host.id === task.hostId);
      return `${task.title} · ${project} · ${host ? remoteHostLabel(host) : msg("localDevice")} · ${task.workspacePath}`;
    };
    try {
      for (const task of candidates) {
        if (
          !latest.current.tree.tasks.some(
            (t) => archiveTaskKey(t) === archiveTaskKey(task) && t.archived,
          )
        ) {
          counts.skipped++;
          counts.details.push(`${label(task)} — ${reason("not-archived")}`);
          continue;
        }
        try {
          const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
            ...task,
            state: useRemoteWorkspaceSessionStore.getState(),
          });
          await mutateProjectTask(
            { service, controller },
            task,
            { kind: "archive", archived: false },
            remoteSessionId,
          );
          counts.succeeded++;
        } catch (error) {
          counts.failed++;
          counts.details.push(`${label(task)} — ${msg("incomplete")}`);
          logger.error("[archive-management] 任务操作失败", {
            taskId: task.taskId,
            workspaceIdentity: task.workspaceIdentity,
            operation,
            error,
          });
        }
      }
      await latest.current
        .refresh()
        .catch((error) => logger.warn("[archive-management] 刷新失败", { error }));
      setResult(counts);
    } finally {
      if (activeOperation.current === operationLifetime) {
        activeOperation.current = null;
        setBusy(false);
      }
    }
  };

  return {
    ...directory,
    busy: busy || permanentDelete.busy,
    pending: permanentDelete.pending,
    result,
    deletionResult: permanentDelete.result,
    deletionFailed: permanentDelete.resultFailed,
    deletionDialog: permanentDelete.dialog,
    run,
    cancelDelete: permanentDelete.cancel,
  };
}

function archivedCandidates(tasks: ProjectTask[]) {
  return [...new Map(tasks.filter((t) => t.archived).map((t) => [archiveTaskKey(t), t])).values()];
}

function isRemoteArchiveTask(task: ProjectTask) {
  return Boolean(task.workspaceIdentity?.trim());
}

function toPermanentDeleteTarget(task: ProjectTask): TaskDeleteTarget {
  return {
    id: `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`,
    taskId: task.taskId,
    title: task.title,
    workspacePath: task.workspacePath,
    archived: true,
    // Archiving does not clear pinned, so the real state is passed; the dialog excludes pinned rows until the user opts in.
    pinned: task.pinned,
    ...(task.executionWorktree ? { executionWorktree: task.executionWorktree } : {}),
  };
}
