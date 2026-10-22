import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { ProjectDirectories, ProjectTaskRef } from "#src/project-storage/contract.js";
import { OWNERSHIP_DECIDED } from "#src/project-storage/legacy-tasks.js";
import {
  executionDirectoriesSchema,
  insertReservationRow,
  readTask,
  resolveDirectories,
} from "#src/project-storage/project-repository-rows.js";

/**
 * A fork is born from a parent that already has an owner, so the child inherits the parent's project, cwd and
 * resolved additional directories as frozen execution facts (session-management I2/I16). The CLI does not know the
 * project, so the Host claims the child here; a row that already has a host is never re-claimed.
 */
export function claimForkedTask(
  db: DatabaseSync,
  ownerHostId: string | undefined,
  task: ProjectTaskRef,
  parentTask: ProjectTaskRef,
  key: string,
  host: string,
): ProjectDirectories | null {
  if (resolveWorkspaceKey(parentTask) !== key) throw new Error("project.fork-workspace-mismatch");
  const parentRow = readTask(db, parentTask);
  if (!parentRow) throw new Error("project.fork-parent-missing");
  // An unowned parent (host_id NULL) has nothing to inherit yet: no claim, no child write. The ACK still succeeds,
  // and admitForkSummary claims the child once the parent is owned. Owned parents still go through the host check below.
  if (parentRow.host_id === null) return null;
  // Reads the parent through the owner-host check, so a foreign parent row is rejected before any claim is written.
  const parent = resolveDirectories(db, parentTask, ownerHostId);
  const row = readTask(db, task);
  if (row && row.host_id !== null) return resolveDirectories(db, task, ownerHostId);
  const executionDirectories = JSON.stringify(
    executionDirectoriesSchema.parse(parent.additionalDirectories),
  );
  if (row) {
    db.prepare(
      "UPDATE tasks SET host_id=?,root_path=?,project_id=?,handoff_pending=handoff_pending | ?,execution_directories=? WHERE workspace_key=? AND task_id=? AND host_id IS NULL",
    ).run(
      host,
      parent.workspacePath,
      parent.projectId,
      OWNERSHIP_DECIDED,
      executionDirectories,
      key,
      task.taskId,
    );
  } else {
    insertReservationRow(db, {
      key,
      task: { ...task, workspacePath: parent.workspacePath },
      host,
      projectId: parent.projectId,
      executionDirectories,
    });
  }
  return resolveDirectories(db, task, ownerHostId);
}
