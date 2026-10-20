import { parentPort, workerData } from "node:worker_threads";
import { tasksStorageWorkerDataSchema } from "./contract.js";
import { prepareTasksIndexStorage } from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@zcode/shared";

// DEFERRED (desktop PR 1): upstream passes the legacy settings snapshot as a third argument so
// project migration runs before Host start. The fork services startup API is still 2-arg until the
// services startup-entry sync lands; see specs/desktop-upstream-sync.md.
const data = tasksStorageWorkerDataSchema.parse(workerData);
try {
  await prepareTasksIndexStorage(data.path, (phase, migration) =>
    parentPort?.postMessage({ type: "progress", phase, migration }),
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
