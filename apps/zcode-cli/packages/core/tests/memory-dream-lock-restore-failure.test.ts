import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const writeFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("@zcode/shared/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/shared/node")>();
  return {
    ...actual,
    atomicWritePrivateTextFile: async (...args: Parameters<typeof actual.atomicWritePrivateTextFile>) => {
      if (writeFailure.enabled) throw new Error("simulated restore write failure");
      return actual.atomicWritePrivateTextFile(...args);
    },
  };
});

import {
  acquireDreamLock,
  restoreDreamLockAfterFailure,
} from "../src/memory/dream-lock.js";

const roots: string[] = [];

afterEach(async () => {
  writeFailure.enabled = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Dream lock failed restoration", () => {
  it("allows the same process to retry when restoring a failed lease cannot write", async () => {
    const root = await mkdtemp(join(tmpdir(), "dream-lock-restore-failure-"));
    roots.push(root);
    const nowMs = Date.parse("2026-07-14T01:02:03.000Z");
    const lockPath = join(root, ".consolidate-lock");
    await writeFile(lockPath, "99999999", "utf8");
    await utimes(lockPath, (nowMs - 8 * 24 * 60 * 60 * 1000) / 1000, (nowMs - 8 * 24 * 60 * 60 * 1000) / 1000);
    const lease = await acquireDreamLock({ memoryRoot: root, nowMs });
    expect(lease).not.toBeNull();

    writeFailure.enabled = true;
    await expect(restoreDreamLockAfterFailure({ memoryRoot: root, lease: lease! })).rejects.toThrow(
      "simulated restore write failure",
    );

    writeFailure.enabled = false;
    const retry = await acquireDreamLock({ memoryRoot: root, nowMs });
    expect(retry).not.toBeNull();
    await restoreDreamLockAfterFailure({ memoryRoot: root, lease: retry! });
  });
});
