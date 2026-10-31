import { DatabaseSync } from "node:sqlite";
import { projectStorage } from "../../../../services/src/project-storage/index.js";
import type { ReserveCreatedTaskInput } from "../../../../services/src/project-storage/contract.js";

// Separate processes share the test database and are all admitted so they really contend for the SQLite write lock; no app account or real user directory is loaded.
const { databasePath, input } = JSON.parse(process.argv[2]!) as {
  databasePath: string;
  // Only plain creates race here; the fork variant may resolve null.
  input: Extract<ReserveCreatedTaskInput, { forkOf?: undefined }>;
};
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout=10000");
process.once("message", () => {
  try {
    const result = projectStorage.repository(db).reserveCreatedTask(input);
    process.send?.({ taskId: result.taskId });
  } catch (error) {
    process.send?.({ error: String(error) });
    process.exitCode = 1;
  } finally {
    db.close();
    process.disconnect?.();
  }
});
process.send?.({ ready: true });
