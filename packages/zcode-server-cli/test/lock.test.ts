import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataRootLock } from "../src/runtime/lock.js";

// A value beyond common platform pid limits: process.kill(pid, 0) always yields ESRCH, simulating a dead lock holder.
const DEAD_PID = 2 ** 30;

describe("DataRootLock", () => {
  it("recovers a stale lock left behind by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-stale-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`, "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("recovers a corrupted lock file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-corrupt-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, "not-json", "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    await lock.release();
  });

  it("recovers an empty lock file, which a live owner never exposes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-empty-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, "", "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("is not blocked by temp records left behind by a crashed contender", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-temp-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(`${lockFile}.tmp-${DEAD_PID}-leftover`, "", "utf8");
    await writeFile(`${lockFile}.recovery.tmp-${DEAD_PID}-leftover`, "", "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    await lock.release();
    // Only the crashed contender's leftovers remain; this owner's own temp records were removed.
    expect((await readdir(join(root, "run"))).sort()).toEqual([
      `server.lock.recovery.tmp-${DEAD_PID}-leftover`,
      `server.lock.tmp-${DEAD_PID}-leftover`,
    ]);
  });

  it("refuses to steal the lock from a live process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-live-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`,
      "utf8",
    );

    const lock = new DataRootLock(lockFile);
    await expect(lock.acquire()).rejects.toThrow(/already running/);
  });

  it("reports missing, stale, active and malformed lock owners without mutating the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-inspect-"));
    const lockFile = join(root, "run", "server.lock");
    const lock = new DataRootLock(lockFile);

    await expect(lock.inspect()).resolves.toMatchObject({ state: "missing" });
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID })}\n`, "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: DEAD_PID });
    await writeFile(lockFile, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "active", pid: process.pid });
    await writeFile(lockFile, "not-json", "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "invalid" });
    await expect(readFile(lockFile, "utf8")).resolves.toBe("not-json");
  });

  it("keeps locks under different data roots isolated (R2-CLI-13)", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "zcode-r2-lock-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "zcode-r2-lock-b-"));
    const lockA = new DataRootLock(join(rootA, "run", "server.lock"));
    const lockB = new DataRootLock(join(rootB, "run", "server.lock"));
    await lockA.acquire();
    await lockB.acquire();
    await lockA.release();
    await lockB.release();
    // Can be re-acquired after release.
    await lockA.acquire();
    await lockA.release();
  });

  it.skipIf(process.platform === "win32")(
    "does not delete a replacement lock owned by another token during release",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-owner-"));
      const lockFile = join(root, "run", "server.lock");
      const replacement = join(root, "run", "replacement.lock");
      const lock = new DataRootLock(lockFile);
      await lock.acquire();
      await writeFile(
        replacement,
        `${JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          ownerToken: "replacement-owner",
        })}\n`,
        "utf8",
      );
      await rename(replacement, lockFile);

      await lock.release();

      expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({
        ownerToken: "replacement-owner",
      });
    },
  );

  it("allows only one real process to claim the same stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-race-"));
    const lockFile = join(root, "server.lock");
    const barrierFile = join(root, "go");
    const resultsFile = join(root, "results");
    const readyDir = join(root, "ready");
    const contenderCount = 8;
    await mkdir(readyDir);
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`, "utf8");
    // Root-level Vitest and the package script run with different cwd values; the source path cannot be derived from cwd, or children would import a nonexistent root/src/runtime/lock.ts.
    const moduleUrl = new URL("../src/runtime/lock.ts", import.meta.url).href;
    const childProgram = `
      import { access, appendFile, readFile, writeFile } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      const { DataRootLock } = await import(process.env.ZCODE_TEST_LOCK_MODULE);
      await writeFile(process.env.ZCODE_TEST_LOCK_READY, "ready\\n");
      while (true) { try { await access(process.env.ZCODE_TEST_LOCK_BARRIER); break; } catch { await delay(5); } }
      const lock = new DataRootLock(process.env.ZCODE_TEST_LOCK_FILE);
      let acquired = false;
      try {
        await lock.acquire();
        acquired = true;
      } catch {
        await appendFile(process.env.ZCODE_TEST_LOCK_RESULTS, "locked " + process.env.ZCODE_TEST_LOCK_CHILD + "\\n");
      }
      if (acquired) {
        try {
          await appendFile(process.env.ZCODE_TEST_LOCK_RESULTS, "success " + process.env.ZCODE_TEST_LOCK_CHILD + "\\n");
          const resultDeadline = Date.now() + 20_000;
          while (Date.now() < resultDeadline) {
            const results = await readFile(process.env.ZCODE_TEST_LOCK_RESULTS, "utf8").catch(() => "");
            const resultCount = results.trim().split(String.fromCharCode(10)).filter(Boolean).length;
            if (resultCount === ${contenderCount}) break;
            await delay(5);
          }
          const results = await readFile(process.env.ZCODE_TEST_LOCK_RESULTS, "utf8");
          const resultCount = results.trim().split(String.fromCharCode(10)).filter(Boolean).length;
          if (resultCount !== ${contenderCount}) {
            throw new Error("Timed out waiting for every lock contender to finish");
          }
        } finally {
          await lock.release();
        }
      }
    `;
    const children = Array.from(
      { length: contenderCount },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "--eval", childProgram],
            {
              env: {
                ...process.env,
                ZCODE_TEST_LOCK_MODULE: moduleUrl,
                ZCODE_TEST_LOCK_BARRIER: barrierFile,
                ZCODE_TEST_LOCK_FILE: lockFile,
                ZCODE_TEST_LOCK_READY: join(readyDir, String(index)),
                ZCODE_TEST_LOCK_RESULTS: resultsFile,
                ZCODE_TEST_LOCK_CHILD: String(index),
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let childError = "";
          child.stderr.on("data", (chunk) => {
            childError += String(chunk);
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(childError || `lock child exited ${code}`)),
          );
        }),
    );
    // Wait for all children to reach the barrier first. Releasing after a fixed delay would let a
    // slow-starting child acquire the lock again after the first owner releases, making the
    // "exactly one success" assertion intermittently see multiple successes.
    const readyDeadline = Date.now() + 20_000;
    let allChildrenReady = false;
    while (Date.now() < readyDeadline) {
      if ((await readdir(readyDir)).length === children.length) {
        allChildrenReady = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(barrierFile, "go", "utf8");
    await Promise.all(children);
    const results = (await readFile(resultsFile, "utf8")).trim().split("\n");
    expect(allChildrenReady).toBe(true);
    expect(results.filter((result) => result.startsWith("success "))).toHaveLength(1);
    expect(results.filter((result) => result.startsWith("locked "))).toHaveLength(
      contenderCount - 1,
    );
  }, 30_000);
});
