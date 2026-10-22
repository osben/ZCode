import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ProjectDirectories,
  ProjectTaskRef,
  VirtualProject,
} from "#src/project-storage/contract.js";
import { OWNERSHIP_DECIDED } from "#src/project-storage/legacy-tasks.js";
import { assertRemoteTaskDirectories } from "#src/project-storage/remote-policy.js";

// Row and project readers shared by ProjectRepository and the fork claim module, so neither imports the other.
export const executionDirectoriesSchema = z.array(z.string().min(1)).max(256);

export function insertReservationRow(
  db: DatabaseSync,
  input: {
    key: string;
    task: ProjectTaskRef;
    host: string;
    projectId: string | null;
    executionDirectories: string | null;
  },
): void {
  // 创建归属必须先于 CLI 首发；空事实不是假会话，列表只读取已有 CLI 事实的行。
  db.prepare(`INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories)
          VALUES(?,?,?,?,0,0,?,?,?,?,?)`).run(
    input.key,
    input.task.workspacePath,
    input.task.workspaceIdentity ?? null,
    input.task.taskId,
    input.host,
    input.task.workspacePath,
    input.projectId,
    OWNERSHIP_DECIDED,
    input.executionDirectories,
  );
}

export function readProjects(db: DatabaseSync, includeDeleted = true): VirtualProject[] {
  const roots = db
    .prepare(
      "SELECT project_id,root_path,position,is_primary FROM project_roots ORDER BY position,root_path",
    )
    .all();
  return db
    .prepare(
      `SELECT * FROM projects ${includeDeleted ? "" : "WHERE deleted=0"} ORDER BY position,project_id`,
    )
    .all()
    .map((row) => ({
      id: String(row.project_id),
      hostId: String(row.host_id),
      name: String(row.name),
      nameOverridden: row.name_overridden === 1,
      position: Number(row.position),
      pinned: row.pinned === 1,
      deleted: row.deleted === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      roots: roots
        .filter((root) => root.project_id === row.project_id)
        .map((root) => ({
          rootPath: String(root.root_path),
          position: Number(root.position),
          isPrimary: root.is_primary === 1,
        })),
    }));
}

export function requireProject(db: DatabaseSync, id: string): VirtualProject {
  const project = readProjects(db).find((entry) => entry.id === id);
  if (!project) throw new Error("project.not-found");
  return project;
}

export function readTask(db: DatabaseSync, task: ProjectTaskRef) {
  return db
    .prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(resolveWorkspaceKey(task), task.taskId);
}

export function resolveDirectories(
  db: DatabaseSync,
  task: ProjectTaskRef,
  ownerHostId = "local",
): ProjectDirectories {
  const row = readTask(db, task);
  // 旧远端影子行仍可能保留；行与项目一致不代表当前 Host 有权加载其目录。
  if (row && row.host_id !== ownerHostId) throw new Error("project.host-mismatch");
  const workspacePath = row ? String(row.root_path) : task.workspacePath;
  const project = row?.project_id ? requireProject(db, String(row.project_id)) : null;
  if (project && row?.host_id !== project.hostId) throw new Error("project.host-mismatch");
  assertRemoteTaskDirectories(
    ownerHostId,
    project,
    workspacePath,
    typeof row?.execution_directories === "string"
      ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
      : [],
  );
  return {
    workspacePath,
    projectId: project?.id ?? null,
    additionalDirectories:
      typeof row?.execution_directories === "string"
        ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
        : (project?.roots.map((root) => root.rootPath).filter((path) => path !== workspacePath) ??
          []),
  };
}
