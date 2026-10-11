import type { DatabaseMigrationFacts } from "@zcode/shared";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// Match the existing Repo: prevent the bundler from rewriting node:sqlite to a nonexistent npm sqlite package.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { OffPeakTaskRepo } from "#src/session/offPeakTaskRepo.js";
import {
  runTasksDatabaseMigrations,
  inspectTasksMigrationKind,
} from "#src/session/tasksDatabase/migrations.js";
import {
  markTasksStorageMigrated,
  markTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";

export type TasksStoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";
const LOCK_WAIT_MS = 60 * 60_000;

/** Called by the Host Worker. Shares SQL and post-migration repairs with the old Repo; only acquiring the write lock waits asynchronously. */
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
): Promise<void> {
  // The callback receives a snapshot of the current facts, not the internal object that subsequent operations continue to update.
  const report = (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) =>
    onProgress(phase, migration ? { ...migration } : undefined);
  report("checking");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let failure: unknown;
  let migration: DatabaseMigrationFacts | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 25");
    db.exec("PRAGMA foreign_keys = ON");
    const deadline = Date.now() + LOCK_WAIT_MS;
    const acquire = async (operation: string | (() => void)) => {
      // A lock may be encountered before or after preflight; waiting after migration is confirmed requires republishing the visible state.
      let waiting = false;
      for (;;) {
        try {
          if (typeof operation === "string") db.exec(operation);
          else operation();
          return;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
          if (Date.now() >= deadline)
            throw Object.assign(new Error("Task storage lock wait expired", { cause: error }), {
              kind: "lock_timeout",
            });
          if (!waiting) {
            waiting = true;
            report("waiting_for_lock", migration);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    await acquire("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    await acquire(() => {
      migration = { kind: inspectTasksMigrationKind(db), executedCount: 0, committedCount: 0 };
    });
    report("checking", migration);
    await acquire("BEGIN IMMEDIATE");
    runTasksDatabaseMigrations(db, { transactionOpen: true, migration, onProgress: report });
    // COMMIT succeeded, so publish that fact first; a later close failure must not make a committed migration appear uncommitted.
    report("maintaining", migration);
  } catch (error) {
    failure = error;
    // Pass the failure and original exception to the Worker; do not regress to checking/migrating or replace the initial cause.
    if (migration && error && typeof error === "object") {
      try {
        Object.assign(error, { startupMigration: { ...migration } });
      } catch {
        /* Preserve the original error for exceptions that cannot be extended. */
      }
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
  markTasksStorageMigrated(path);
  const repos = [
    new TaskIndexRepo(path, LOCK_WAIT_MS),
    new AutomationRepo(path, LOCK_WAIT_MS),
    new OffPeakTaskRepo(path, LOCK_WAIT_MS),
  ];
  let preparationFailure: unknown;
  try {
    // These repairs already ran during initialization; they do not add a migration or change existing transaction boundaries.
    for (const repo of repos) await repo.ensureReady();
  } catch (error) {
    preparationFailure = error;
    throw error;
  } finally {
    let closeFailure: unknown;
    for (const repo of repos) {
      try {
        repo.close({ throwOnError: true });
      } catch (error) {
        closeFailure ??= error;
      }
    }
    if (!preparationFailure && closeFailure) throw closeFailure;
  }
  markTasksStoragePrepared(path);
  report("ready", migration);
}
