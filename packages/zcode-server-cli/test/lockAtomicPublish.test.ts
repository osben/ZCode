import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataRootLock } from "../src/runtime/lock.js";

// A value beyond common platform pid limits: process.kill(pid, 0) always yields ESRCH, simulating a dead lock holder.
const DEAD_PID = 2 ** 30;

// Holds the first record write after `armed` is set, so a test can let a second contender run while
// the first owner is in the middle of publishing its lock or recovery-gate record.
const pause = vi.hoisted(() => ({
  armed: false,
  onReached: undefined as (() => void) | undefined,
  gate: Promise.resolve(),
  linkErrorCode: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const holdIfArmed = async (): Promise<void> => {
    if (!pause.armed) return;
    pause.armed = false;
    pause.onReached?.();
    await pause.gate;
  };
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const writeHandleFile = handle.writeFile.bind(handle);
    const writeHandle = handle.write.bind(handle) as (...writeArgs: unknown[]) => Promise<unknown>;
    handle.writeFile = async (...writeArgs) => {
      await holdIfArmed();
      return writeHandleFile(...writeArgs);
    };
    (handle as { write: (...writeArgs: unknown[]) => Promise<unknown> }).write = async (
      ...writeArgs
    ) => {
      await holdIfArmed();
      return writeHandle(...writeArgs);
    };
    return handle;
  };
  const writeFileHeld: typeof actual.writeFile = async (...args) => {
    await holdIfArmed();
    return actual.writeFile(...args);
  };
  const link: typeof actual.link = async (...args) => {
    if (pause.linkErrorCode) {
      throw Object.assign(new Error(`link unsupported: ${pause.linkErrorCode}`), {
        code: pause.linkErrorCode,
      });
    }
    return actual.link(...args);
  };
  return { ...actual, link, open, writeFile: writeFileHeld };
});

function pauseNextRecordWrite(): { reached: Promise<void>; resume: () => void } {
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    pause.onReached = resolve;
  });
  pause.gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  pause.armed = true;
  return { reached, resume };
}

async function readRecord(path: string): Promise<"missing" | "complete" | "incomplete"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; ownerToken?: unknown };
    return typeof parsed.pid === "number" && typeof parsed.ownerToken === "string"
      ? "complete"
      : "incomplete";
  } catch {
    return "incomplete";
  }
}

describe("DataRootLock record publication", () => {
  afterEach(() => {
    pause.armed = false;
    pause.onReached = undefined;
    pause.linkErrorCode = undefined;
  });

  it("does not let a contender take over a lock whose owner is still writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-publish-"));
    const lockFile = join(root, "run", "server.lock");
    const first = new DataRootLock(lockFile);
    const second = new DataRootLock(lockFile);

    const { reached, resume } = pauseNextRecordWrite();
    const firstAttempt = first.acquire().then(
      () => "acquired" as const,
      (error: unknown) => error,
    );
    await reached;
    const secondResult = await second.acquire().then(
      () => "acquired" as const,
      (error: unknown) => error,
    );
    resume();
    const firstResult = await firstAttempt;

    const winners = [firstResult, secondResult].filter((result) => result === "acquired");
    expect(winners).toHaveLength(1);
    const loser = firstResult === "acquired" ? secondResult : firstResult;
    expect(loser).toBeInstanceOf(Error);
    expect((loser as Error).message).toMatch(/already running/);
    await (firstResult === "acquired" ? first : second).release();
  });

  it("does not expose an incomplete recovery gate while recovering a stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-publish-gate-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`, "utf8");
    const lock = new DataRootLock(lockFile);

    const { reached, resume } = pauseNextRecordWrite();
    const attempt = lock.acquire();
    await reached;
    // The first write of a stale-lock recovery publishes the recovery gate record.
    expect(await readRecord(`${lockFile}.recovery`)).not.toBe("incomplete");
    resume();
    await attempt;
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("falls back to exclusive create when the filesystem has no hard links", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-publish-nolink-"));
    const lockFile = join(root, "run", "server.lock");
    pause.linkErrorCode = "ENOTSUP";
    const lock = new DataRootLock(lockFile);

    await lock.acquire();
    expect(await readRecord(lockFile)).toBe("complete");
    await expect(new DataRootLock(lockFile).acquire()).rejects.toThrow(/already running/);
    await lock.release();
    await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, "run"))).toEqual([]);
  });

  it("propagates link failures that do not mean hard links are unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-publish-linkerr-"));
    const lockFile = join(root, "run", "server.lock");
    pause.linkErrorCode = "EACCES";

    await expect(new DataRootLock(lockFile).acquire()).rejects.toMatchObject({ code: "EACCES" });
    expect(await readdir(join(root, "run"))).toEqual([]);
  });
});
