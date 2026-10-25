import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFERRED_ROWS_PROJECT_COUNT = 12;
export const DEFERRED_ROWS_TASKS_PER_PROJECT = 8;

export function deferredRowsProjectPath(home: string, index: number): string {
  return join(home, "ZCodeProject", ".zcode-e2e", "project-deferred-rows", `deferred-${index}`);
}

/** Project index encoded in a seeded project name (`deferred-<index>`). */
export function deferredRowsProjectIndex(name: string): number {
  return Number(name.replace("deferred-", ""));
}

export function deferredRowsTaskId(project: number, task: number): string {
  return `e2e-deferred-${project}-${task}`;
}

/**
 * Inserts legacy-shaped task rows (host_id NULL) for each seeded project root. Call it while the
 * app is stopped: on the next start the Host's legacy reconcile assigns each row to the project
 * with that unique root (project-storage/legacy-tasks.ts), the same path old task rows take.
 * Within a project, task 0 is newest so the sidebar comparator lists tasks 0..4 first.
 */
export function insertDeferredRowsTasks(home: string): void {
  const db = new DatabaseSync(join(home, ".zcode", "v2", "tasks-index.sqlite"));
  try {
    const insert = db.prepare(`INSERT INTO tasks
      (workspace_key,workspace_path,task_id,title,task_status,provider,created_at,updated_at,title_overridden)
      VALUES(?,?,?,?,'completed','glm',?,?,1)`);
    const base = Date.now() - 60_000;
    db.exec("begin immediate");
    try {
      for (let project = 0; project < DEFERRED_ROWS_PROJECT_COUNT; project += 1) {
        const path = deferredRowsProjectPath(home, project);
        for (let task = 0; task < DEFERRED_ROWS_TASKS_PER_PROJECT; task += 1) {
          const at = base - (project * DEFERRED_ROWS_TASKS_PER_PROJECT + task) * 1_000;
          insert.run(
            path,
            path,
            deferredRowsTaskId(project, task),
            `E2E_DEFERRED_${project}_${task}`,
            at,
            at,
          );
        }
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } finally {
    db.close();
  }
}
