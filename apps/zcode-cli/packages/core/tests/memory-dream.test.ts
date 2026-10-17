import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  restoreDreamLockAfterFailure,
} from "../src/memory/dream.js";
import { parseDreamCommand } from "../src/runtime/helpers/commands.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Memory Dream prompt", () => {
  it("matches the frozen provider-visible fixture", () => {
    const fixture = readFileSync(
      new URL("./fixtures/memory/dream-prompt.md", import.meta.url),
      "utf8",
    ).trimEnd();

    expect(
      buildMemoryDreamPrompt({
        memoryRoot: "<MEMORY_ROOT>",
        sessionIds: Array.from({ length: 7 }, () => "<SESSION_ID>"),
        transcriptRoot: "<SESSION_TRANSCRIPT_ROOT>",
      }),
    ).toBe(fixture);
  });
});

describe("auto Dream timing gate", () => {
  const day = 24 * 60 * 60 * 1000;
  const tenMinutes = 10 * 60 * 1000;
  const now = Date.parse("2026-07-16T12:00:00.000Z");

  it("checks the 24 hour gate before scan throttling", () => {
    expect(
      evaluateAutoDreamTiming({
        lastConsolidatedAtMs: now - day + 1,
        lastScanAtMs: now - tenMinutes - 1,
        nowMs: now,
      }),
    ).toEqual({ decision: "skip", reason: "minimum-interval" });
  });

  it("throttles scans only after the 24 hour gate passes", () => {
    expect(
      evaluateAutoDreamTiming({
        lastConsolidatedAtMs: now - day,
        lastScanAtMs: now - tenMinutes + 1,
        nowMs: now,
      }),
    ).toEqual({ decision: "skip", reason: "scan-throttled" });
    expect(
      evaluateAutoDreamTiming({
        lastConsolidatedAtMs: now - day,
        lastScanAtMs: now - tenMinutes,
        nowMs: now,
      }),
    ).toEqual({ decision: "scan" });
  });
});

describe("Dream consolidation lock", () => {
  it("serializes abandoned-lock takeover across two live processes", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".consolidate-lock"), "0");
    const children: ChildProcess[] = [];
    const exits: Promise<void>[] = [];
    const contender = () =>
      new Promise<boolean>((resolve, reject) => {
        const code = `import { acquireDreamLock } from ${JSON.stringify(new URL("../src/memory/dream-lock.ts", import.meta.url).href)};
        const lease = await acquireDreamLock({ memoryRoot: ${JSON.stringify(root)} });
        process.stdout.write(JSON.stringify(Boolean(lease))+'\\n');
        await new Promise(r=>{ process.stdin.once('end',r); process.stdin.resume(); });`;
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        children.push(child);
        exits.push(new Promise<void>((done) => child.once("exit", () => done())));
        let output = "";
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("\n")) resolve(JSON.parse(output.trim()) as boolean);
        });
        child.once("error", reject);
        child.once("exit", (status) => {
          if (!output) reject(new Error(`Dream contender exited before acquiring: ${status}`));
        });
      });
    try {
      expect((await Promise.all([contender(), contender()])).filter(Boolean)).toHaveLength(1);
    } finally {
      for (const child of children) child.stdin?.end();
      const timer = setTimeout(() => {
        for (const child of children) child.kill("SIGKILL");
      }, 2000);
      await Promise.all(exits);
      clearTimeout(timer);
    }
  }, 10000);
  it("grants an abandoned lock to only one concurrent caller of the same process", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, ".consolidate-lock"), "0");
    const owners = await Promise.all([
      acquireDreamLock({ memoryRoot: root }),
      acquireDreamLock({ memoryRoot: root }),
    ]);
    expect(owners.filter(Boolean)).toHaveLength(1);
  });

  it("keeps a fresh live owner but reclaims an expired lease despite PID reuse", async () => {
    const root = await temporaryDirectory();
    const nowMs = Date.parse("2026-07-14T01:02:03.000Z");
    const lease = (await acquireDreamLock({ memoryRoot: root, nowMs, pid: process.pid }))!;
    const path = join(root, ".consolidate-lock");
    await utimes(path, (nowMs - 24 * 60 * 60 * 1000) / 1000, (nowMs - 24 * 60 * 60 * 1000) / 1000);
    expect(await acquireDreamLock({ memoryRoot: root, nowMs })).toBeNull();
    const expiredMtime = nowMs - 8 * 24 * 60 * 60 * 1000;
    await utimes(path, expiredMtime / 1000, expiredMtime / 1000);
    const replacementLease = await acquireDreamLock({ memoryRoot: root, nowMs });
    expect(replacementLease).not.toBeNull();
    const replacement = { pid: process.pid, token: "another-run-same-pid", status: "running" };
    await writeFile(path, JSON.stringify(replacement));
    await restoreDreamLockAfterFailure({ memoryRoot: root, lease });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
  });
  it("acquires a missing lock and removes it when the run fails", async () => {
    const root = await temporaryDirectory();

    const priorMtime = await acquireDreamLock({ memoryRoot: root, pid: process.pid });

    expect(priorMtime?.prior).toBeNull();
    expect(JSON.parse(await readFile(join(root, ".consolidate-lock"), "utf8")).pid).toBe(
      process.pid,
    );

    await restoreDreamLockAfterFailure({ memoryRoot: root, lease: priorMtime! });
    await expect(stat(join(root, ".consolidate-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not take a fresh lock held by a live PID", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, ".consolidate-lock");
    await writeFile(lockPath, String(process.pid), "utf8");

    await expect(acquireDreamLock({ memoryRoot: root, pid: process.pid })).resolves.toBeNull();
    expect((await readFile(lockPath, "utf8")).trim()).toBe(String(process.pid));
  });

  it("grants the lock to exactly one of two concurrent callers", async () => {
    const root = await temporaryDirectory();

    const results = await Promise.all([
      acquireDreamLock({ memoryRoot: root, pid: process.pid }),
      acquireDreamLock({ memoryRoot: root, pid: process.pid }),
    ]);

    expect(results.filter((value) => value !== null)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, ".consolidate-lock"), "utf8")).pid).toBe(
      process.pid,
    );
  });

  it("leaves a lock that another run took over before the failed restore", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, ".consolidate-lock");
    const priorMtime = await acquireDreamLock({ memoryRoot: root, pid: process.pid });
    // Another run takes over the abandoned lock between the failure and the restore.
    await writeFile(lockPath, "424242", "utf8");

    await restoreDreamLockAfterFailure({ memoryRoot: root, lease: priorMtime! });

    expect((await readFile(lockPath, "utf8")).trim()).toBe("424242");
  });

  it("takes a stale lock and restores dead-pid content with its original mtime after failure", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, ".consolidate-lock");
    const oldMtime = Date.parse("2026-07-14T01:02:03.000Z");
    await writeFile(lockPath, "99999999", "utf8");
    await utimes(lockPath, oldMtime / 1000, oldMtime / 1000);

    const priorMtime = await acquireDreamLock({ memoryRoot: root, pid: process.pid });
    expect(priorMtime?.prior?.mtimeMs).toBe(oldMtime);

    await restoreDreamLockAfterFailure({ memoryRoot: root, lease: priorMtime! });
    // PID 0 reads as a dead owner, so the restored lock is take-over-able instead of held.
    expect(await readFile(lockPath, "utf8")).toBe("0");
    expect((await stat(lockPath)).mtimeMs).toBeCloseTo(oldMtime, -1);
    expect(
      (await acquireDreamLock({ memoryRoot: root, nowMs: oldMtime + 1000, pid: 11111 }))?.prior
        ?.mtimeMs,
    ).toBeCloseTo(oldMtime, -1);
  });
});

describe("Dream command parsing", () => {
  it("accepts the exact command and rejects arguments as a usage error", () => {
    expect(parseDreamCommand("/dream")).toEqual({ ok: true });
    expect(parseDreamCommand("  /dream  ")).toEqual({ ok: true });
    expect(parseDreamCommand("/dream now")).toEqual({ ok: false, reason: "usage" });
    expect(parseDreamCommand("/dream\t now")).toEqual({ ok: false, reason: "usage" });
    expect(parseDreamCommand("/dream\nnow")).toEqual({ ok: false, reason: "usage" });
    expect(parseDreamCommand("/dreamer")).toBeNull();
    expect(parseDreamCommand("/compact")).toBeNull();
    expect(parseDreamCommand("dream")).toBeNull();
    expect(parseDreamCommand("")).toBeNull();
  });
});

describe("Dream touched paths", () => {
  const root = "/storage/memory";

  it("records canonical allowed Write/Edit and narrow rm targets in first-seen order", () => {
    const paths = new Set<string>();
    collectDreamTouchedPaths(paths, {
      rootDir: root,
      toolCall: {
        id: "write",
        name: "Write",
        input: { file_path: `${root}/fact.md` },
      },
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });
    collectDreamTouchedPaths(paths, {
      rootDir: root,
      toolCall: {
        id: "remove",
        name: "Bash",
        input: { command: `rm -f ${root}/old.md ${root}/fact.md` },
      },
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect([...paths]).toEqual([`${root}/fact.md`, `${root}/old.md`]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zcode-memory-dream-"));
  temporaryDirectories.push(path);
  return path;
}
