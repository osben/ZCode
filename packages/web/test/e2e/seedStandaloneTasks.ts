// Seed only an explicitly isolated temporary dev:web profile; see the spec for usage.
import { realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TaskIndexRepo } from "../../../services/src/session/taskIndexRepo.js";

const requestedBase = process.env.ZCODE_DATA_BASE_DIR;
if (!requestedBase) throw new Error("Set ZCODE_DATA_BASE_DIR to a fresh temporary profile first");
const base = await realpath(requestedBase);
const temporaryRoots = [await realpath(tmpdir())];
if (process.platform !== "win32") temporaryRoots.push(await realpath("/tmp"));
if (
  !basename(base).startsWith("zcode-standalone") ||
  !temporaryRoots.some((root) => base.startsWith(`${root}${sep}`))
) {
  throw new Error("Fixture seeding requires a temporary zcode-standalone* directory");
}

const workspacePath = resolve(fileURLToPath(new URL("../../../server", import.meta.url)));
const repo = new TaskIndexRepo(join(base, ".zcode/v2/tasks-index.sqlite"));
try {
  const now = Date.now();
  for (const [taskId, title, pinned, archived, createdOffset, updatedOffset] of [
    ["web-history", "Web fixture older task", false, false, 3000, 100],
    ["web-recent", "Web fixture recent task", false, false, 1000, 1000],
    ["web-pin", "Web fixture pinned task", true, false, 2000, 2000],
    ["web-archive", "Web fixture archived task", false, true, 4000, 4000],
  ] as const) {
    await repo.syncTaskMeta({
      meta: {
        taskId,
        title,
        workspacePath,
        traceId: taskId,
        provider: "glm",
        mode: "default",
        createdAt: now - createdOffset,
        updatedAt: now - updatedOffset,
        status: "completed",
      },
      pinned,
      archived,
      searchableText: taskId === "web-history" ? "uniqueWebBodyNeedle" : "",
    });
  }
  console.log(`Seeded four standalone Web tasks in ${base}`);
} finally {
  repo.close();
}
