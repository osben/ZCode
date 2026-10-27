import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exampleDreamJournal } from "../src/memory/dream-journal/contract.example.js";
import {
  DREAM_JOURNAL_DIRECTORY_NAME,
  dreamJournal,
  DREAM_JOURNAL_RUN_LIMIT,
  DREAM_JOURNAL_SKIPPED_RUN_LIMIT,
  beginDreamJournalRun,
  listDreamJournalRuns,
  readDreamJournalRun,
  recordDreamJournalSkip,
} from "../src/memory/dream-journal/index.js";
import { containsSensitiveMemoryPathSegment } from "../src/memory/memory-file-path.js";
import { scanMemoryManifest } from "../src/memory/recall/manifest.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const NOW = Date.parse("2026-10-27T03:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function memoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-dream-journal-"));
  temporaryDirectories.push(root);
  return root;
}

function at(offsetMs: number): Date {
  return new Date(NOW + offsetMs);
}

describe("Dream run journal", () => {
  it("records created, updated and deleted files with before and after bodies", async () => {
    const root = await memoryRoot();
    await writeFile(join(root, "kept.md"), "old body", "utf8");
    await writeFile(join(root, "gone.md"), "doomed", "utf8");
    const run = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(0) });

    await run.snapshotBeforeFirstTouch(join(root, "kept.md"));
    await run.snapshotBeforeFirstTouch(join(root, "gone.md"));
    await run.snapshotBeforeFirstTouch(join(root, "fresh.md"));
    await writeFile(join(root, "kept.md"), "new body", "utf8");
    await rm(join(root, "gone.md"));
    await writeFile(join(root, "fresh.md"), "born", "utf8");
    const finished = await run.finalize({ status: "succeeded", now: at(1000) });

    expect(finished.outcome).toBe("learned");
    expect(finished.finishedAt).toBe(at(1000).toISOString());
    const byFile = Object.fromEntries(finished.items.map((item) => [item.file, item]));
    expect(byFile["kept.md"]).toMatchObject({
      action: "updated",
      before: { content: "old body" },
      after: { content: "new body" },
    });
    expect(byFile["gone.md"]).toMatchObject({
      action: "deleted",
      before: { content: "doomed" },
      after: null,
    });
    expect(byFile["fresh.md"]).toMatchObject({
      action: "created",
      before: null,
      after: { content: "born" },
    });

    const persisted = await readDreamJournalRun({ memoryRoot: root, runId: run.id });
    expect(persisted).toEqual(finished);
  });

  it("keeps the first snapshot per run and path even after later edits", async () => {
    const root = await memoryRoot();
    await writeFile(join(root, "note.md"), "original", "utf8");
    const run = await beginDreamJournalRun({ memoryRoot: root, trigger: "scheduled", now: at(0) });

    await run.snapshotBeforeFirstTouch(join(root, "note.md"));
    await writeFile(join(root, "note.md"), "first edit", "utf8");
    await run.snapshotBeforeFirstTouch(join(root, "note.md"));
    await writeFile(join(root, "note.md"), "second edit", "utf8");
    const finished = await run.finalize({ status: "succeeded", now: at(1) });

    expect(finished.items).toHaveLength(1);
    expect(finished.items[0]).toMatchObject({
      action: "updated",
      before: { content: "original" },
      after: { content: "second edit" },
    });
  });

  it("drops touches that end with no change instead of recording empty updates", async () => {
    const root = await memoryRoot();
    await writeFile(join(root, "same.md"), "unchanged", "utf8");
    const run = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(0) });

    await run.snapshotBeforeFirstTouch(join(root, "same.md"));
    await run.snapshotBeforeFirstTouch(join(root, "ephemeral.md"));
    await writeFile(join(root, "ephemeral.md"), "tmp", "utf8");
    await rm(join(root, "ephemeral.md"));
    const finished = await run.finalize({ status: "succeeded", now: at(1) });

    expect(finished.items).toEqual([]);
    expect(finished.outcome).toBe("nothing");
  });

  it("records a skip row with a reason code and no items", async () => {
    const root = await memoryRoot();

    await recordDreamJournalSkip({
      memoryRoot: root,
      trigger: "scheduled",
      reasonCode: "no_new_turns",
      now: at(0),
    });
    const [skip] = await listDreamJournalRuns({ memoryRoot: root });

    expect(skip).toMatchObject({
      outcome: "skipped",
      reasonCode: "no_new_turns",
      trigger: "scheduled",
      items: [],
      startedAt: at(0).toISOString(),
      finishedAt: at(0).toISOString(),
    });
  });

  it("settles a run interrupted mid-way from disk so applied changes stay recorded", async () => {
    const root = await memoryRoot();
    await writeFile(join(root, "existing.md"), "before crash", "utf8");
    const crashed = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(0) });
    await crashed.snapshotBeforeFirstTouch(join(root, "existing.md"));
    await writeFile(join(root, "existing.md"), "after crash", "utf8");
    await crashed.snapshotBeforeFirstTouch(join(root, "created.md"));
    await writeFile(join(root, "created.md"), "applied before crash", "utf8");
    // No finalize: the process dies here. The next run starts after the lock is free.

    const next = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(5000) });

    const settled = await readDreamJournalRun({ memoryRoot: root, runId: crashed.id });
    expect(settled).toMatchObject({ outcome: "failed", reasonCode: "interrupted" });
    expect(settled?.items).toEqual([
      expect.objectContaining({
        action: "updated",
        file: "existing.md",
        before: { content: "before crash" },
        after: { content: "after crash" },
      }),
      expect.objectContaining({
        action: "created",
        file: "created.md",
        before: null,
        after: { content: "applied before crash" },
      }),
    ]);
    expect((await readDreamJournalRun({ memoryRoot: root, runId: next.id }))?.outcome).toBe(
      "running",
    );
  });

  it("prunes the oldest non-skipped runs beyond the total cap", async () => {
    const root = await memoryRoot();
    const total = DREAM_JOURNAL_RUN_LIMIT + 1;
    const ids: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const run = await beginDreamJournalRun({
        memoryRoot: root,
        trigger: "manual",
        now: at(index * 1000),
      });
      await run.finalize({ status: "succeeded", now: at(index * 1000 + 1) });
      ids.push(run.id);
    }

    const runs = await listDreamJournalRuns({ memoryRoot: root });
    const files = await readdir(join(root, DREAM_JOURNAL_DIRECTORY_NAME));

    expect(runs).toHaveLength(DREAM_JOURNAL_RUN_LIMIT);
    expect(runs[0]?.id).toBe(ids[total - 1]);
    expect(files).toHaveLength(DREAM_JOURNAL_RUN_LIMIT);
    expect(await readDreamJournalRun({ memoryRoot: root, runId: ids[0]! })).toBeUndefined();
    expect(files).not.toContain(`${ids[0]}.json`);
  });

  it("caps skip rows separately and never lets skip rows evict a learned run", async () => {
    const root = await memoryRoot();
    const learned = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(0) });
    await learned.snapshotBeforeFirstTouch(join(root, "learned.md"));
    await writeFile(join(root, "learned.md"), "kept", "utf8");
    await learned.finalize({ status: "succeeded", now: at(1) });

    for (let index = 0; index < DREAM_JOURNAL_RUN_LIMIT; index += 1) {
      await recordDreamJournalSkip({
        memoryRoot: root,
        trigger: "scheduled",
        reasonCode: "no_new_turns",
        now: at(10_000 + index * 1000),
      });
    }

    const runs = await listDreamJournalRuns({ memoryRoot: root });
    const skipped = runs.filter((run) => run.outcome === "skipped");

    expect(await readDreamJournalRun({ memoryRoot: root, runId: learned.id })).toMatchObject({
      outcome: "learned",
    });
    expect(skipped).toHaveLength(DREAM_JOURNAL_SKIPPED_RUN_LIMIT);
    expect(runs.length).toBeLessThanOrEqual(DREAM_JOURNAL_RUN_LIMIT);
  });

  it("evicts skipped rows before any non-skipped row once the total cap is reached", async () => {
    const root = await memoryRoot();
    const oldLearned = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(0) });
    await oldLearned.finalize({ status: "succeeded", now: at(1) });
    for (let index = 0; index < DREAM_JOURNAL_RUN_LIMIT - 1; index += 1) {
      const run = await beginDreamJournalRun({
        memoryRoot: root,
        trigger: "manual",
        now: at(2000 + index * 1000),
      });
      await run.finalize({ status: "failed", reasonCode: "error", now: at(2001 + index * 1000) });
    }
    // The total is now at the cap; further skips must displace skipped rows, not the old run.
    for (let index = 0; index < DREAM_JOURNAL_SKIPPED_RUN_LIMIT + 1; index += 1) {
      await recordDreamJournalSkip({
        memoryRoot: root,
        trigger: "manual",
        reasonCode: "lock_held",
        now: at(100_000 + index * 1000),
      });
    }

    const runs = await listDreamJournalRuns({ memoryRoot: root });

    // Every non-skipped run survives; the displaced rows are the skip rows only.
    expect(runs).toHaveLength(DREAM_JOURNAL_RUN_LIMIT);
    expect(runs.some((run) => run.id === oldLearned.id)).toBe(true);
    expect(runs.filter((run) => run.outcome !== "skipped")).toHaveLength(DREAM_JOURNAL_RUN_LIMIT);
  });

  it("lets a failed finalize replace an earlier succeeded finalize with commit_failed", async () => {
    const root = await memoryRoot();
    const run = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(0) });
    await run.snapshotBeforeFirstTouch(join(root, "committed.md"));
    await writeFile(join(root, "committed.md"), "body", "utf8");
    await run.finalize({ status: "succeeded", now: at(1) });

    const replaced = await run.finalize({
      status: "failed",
      reasonCode: "commit_failed",
      now: at(2),
    });

    expect(replaced).toMatchObject({ outcome: "failed", reasonCode: "commit_failed" });
    expect(await readDreamJournalRun({ memoryRoot: root, runId: run.id })).toMatchObject({
      outcome: "failed",
      reasonCode: "commit_failed",
      items: [expect.objectContaining({ action: "created", file: "committed.md" })],
    });
  });

  it("renames a corrupt run file aside without overwriting it and leaves it out of listings", async () => {
    const root = await memoryRoot();
    const runId = "corrupt-run-1";
    const journalDirectory = join(root, DREAM_JOURNAL_DIRECTORY_NAME);
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(join(journalDirectory, `${runId}.json`), "{not json", "utf8");

    expect(await readDreamJournalRun({ memoryRoot: root, runId })).toBeUndefined();
    expect(await listDreamJournalRuns({ memoryRoot: root })).toEqual([]);

    const files = await readdir(journalDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^${runId}\\.json\\.corrupt-[0-9a-f]{8}$`));
    expect(await readFile(join(journalDirectory, files[0]!), "utf8")).toBe("{not json");
  });

  it("refuses run ids outside the id pattern and snapshots outside the memory root", async () => {
    const root = await memoryRoot();
    const run = await beginDreamJournalRun({ memoryRoot: root, trigger: "manual", now: at(0) });

    expect(await readDreamJournalRun({ memoryRoot: root, runId: "../escape" })).toBeUndefined();
    expect(await readDreamJournalRun({ memoryRoot: root, runId: "a".repeat(81) })).toBeUndefined();
    await expect(run.snapshotBeforeFirstTouch(join(root, "..", "outside.md"))).rejects.toThrow(
      "outside the memory root",
    );
    await expect(
      run.snapshotBeforeFirstTouch(join(root, DREAM_JOURNAL_DIRECTORY_NAME, "x.md")),
    ).rejects.toThrow("inside the journal directory");
    await expect(
      run.snapshotBeforeFirstTouch(join(root, ".FORK_DREAM-JOURNAL", "x.md")),
    ).rejects.toThrow("inside the journal directory");
  });

  it("reads snapshot bodies through an injected reader instead of node:fs", async () => {
    const root = await memoryRoot();
    const reads: string[] = [];
    const run = await beginDreamJournalRun({
      memoryRoot: root,
      readMemoryFile: async (path) => {
        reads.push(path);
        return path.endsWith("port.md") ? "from port" : null;
      },
      trigger: "manual",
      now: at(0),
    });

    await run.snapshotBeforeFirstTouch(join(root, "port.md"));
    const finished = await run.finalize({ status: "succeeded", now: at(1) });

    expect(reads).toEqual([join(root, "port.md"), join(root, "port.md")]);
    expect(finished.items).toEqual([]);
  });

  it("keeps the memory manifest independent of the journal directory", async () => {
    const root = "/memory-root";
    const fileSystem = new MemoryFileSystem({
      [join(root, "fact.md")]: "---\nname: fact\n---\nbody",
      [join(root, DREAM_JOURNAL_DIRECTORY_NAME, "stale-snapshot.md")]: "old body",
      [join(root, DREAM_JOURNAL_DIRECTORY_NAME, "run.json")]: "{}",
    });

    const manifest = await scanMemoryManifest({ fileSystem, rootDir: root });

    expect(manifest.map((entry) => entry.filename)).toEqual(["fact.md"]);
  });

  it("runs the documented call sequence through the bound contract", async () => {
    const root = await memoryRoot();
    const filePath = join(root, "note.md");
    await writeFile(filePath, "before", "utf8");

    await exampleDreamJournal(dreamJournal, root, filePath);
    const [run] = await dreamJournal.listRuns({ memoryRoot: root });

    expect(run).toMatchObject({ outcome: "nothing", trigger: "manual", items: [] });
    expect(await dreamJournal.readRun({ memoryRoot: root, runId: run!.id })).toEqual(run);
  });
  it("matches the journal directory case-insensitively in the manifest", async () => {
    const root = "/memory-root";
    const fileSystem = new MemoryFileSystem({
      [join(root, "fact.md")]: "---\nname: fact\n---\nbody",
      [join(root, ".FORK_DREAM-JOURNAL", "upper-snapshot.md")]: "old body",
    });

    const manifest = await scanMemoryManifest({ fileSystem, rootDir: root });

    expect(manifest.map((entry) => entry.filename)).toEqual(["fact.md"]);
  });

  it("refuses the journal directory in the memory path guard, pinned to the directory name", () => {
    expect(containsSensitiveMemoryPathSegment(DREAM_JOURNAL_DIRECTORY_NAME)).toBe(true);
    expect(containsSensitiveMemoryPathSegment(".FORK_DREAM-JOURNAL/run.md")).toBe(true);
    expect(containsSensitiveMemoryPathSegment("fork_dream-journal-notes/run.md")).toBe(false);
  });
});
