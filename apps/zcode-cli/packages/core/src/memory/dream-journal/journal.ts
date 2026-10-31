import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";

import { memoryFileRelativePath } from "../memory-file-path.js";
import type {
  BeginDreamJournalRunInput,
  DreamJournalAction,
  DreamJournalItem,
  DreamJournalMemoryFileReader,
  DreamJournalOutcome,
  DreamJournalRun,
  DreamJournalRunHandle,
  DreamJournalSnapshot,
  DreamJournalTrigger,
  FinalizeDreamJournalRunInput,
} from "./contract.js";

/**
 * Sidecar directory inside the memory root. The leading dot keeps it out of the top-level catalog
 * and MEMORY.md; the `fork_` prefix keeps the upstream build from ever claiming the name.
 */
export const DREAM_JOURNAL_DIRECTORY_NAME = ".fork_dream-journal";
export const DREAM_JOURNAL_RUN_LIMIT = 30;
export const DREAM_JOURNAL_SKIPPED_RUN_LIMIT = 10;

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/u;
const RUN_FILE_EXTENSION = ".json";
const CORRUPT_FILE_MARKER = ".corrupt-";
const CORRUPT_FILE_SUFFIX_LENGTH = 8;
const TRIGGERS = ["scheduled", "manual"] as const;
const OUTCOMES = ["running", "learned", "nothing", "skipped", "failed"] as const;
const ACTIONS = ["created", "updated", "deleted"] as const;

// Each memory root has one journal directory; every read-modify-write of its run files goes
// through this chain so a snapshot, a finalize and a prune never interleave on the same file.
const journalQueues = new Map<string, Promise<void>>();

export async function beginDreamJournalRun(
  input: BeginDreamJournalRunInput,
): Promise<DreamJournalRunHandle> {
  const reader = input.readMemoryFile ?? readMemoryFileFromDisk;
  return runQueued(input.memoryRoot, async () => {
    // A run still marked running with the lock now free was interrupted (crash, kill). Settle it
    // from disk so its applied changes stay recorded and undoable.
    await recoverInterruptedRunsLocked(input.memoryRoot, input.now, reader);
    const run: DreamJournalRun = {
      id: randomUUID(),
      startedAt: input.now.toISOString(),
      trigger: input.trigger,
      outcome: "running",
      items: [],
    };
    await persistRunLocked(input.memoryRoot, run);
    await pruneLocked(input.memoryRoot);
    return createRunHandle(input.memoryRoot, run, reader);
  });
}

export async function recordDreamJournalSkip(input: {
  memoryRoot: string;
  trigger: DreamJournalTrigger;
  reasonCode: string;
  now: Date;
}): Promise<DreamJournalRun> {
  return runQueued(input.memoryRoot, async () => {
    const timestamp = input.now.toISOString();
    const run: DreamJournalRun = {
      id: randomUUID(),
      startedAt: timestamp,
      finishedAt: timestamp,
      trigger: input.trigger,
      outcome: "skipped",
      reasonCode: input.reasonCode,
      items: [],
    };
    await persistRunLocked(input.memoryRoot, run);
    await pruneLocked(input.memoryRoot);
    return run;
  });
}

/** Newest first. Corrupt run files are renamed aside and left out of the result. */
export async function listDreamJournalRuns(input: {
  memoryRoot: string;
  limit?: number;
}): Promise<DreamJournalRun[]> {
  const limit = input.limit ?? DREAM_JOURNAL_RUN_LIMIT;
  return runQueued(input.memoryRoot, async () =>
    (await loadRunsLocked(input.memoryRoot)).slice(0, limit),
  );
}

export async function readDreamJournalRun(input: {
  memoryRoot: string;
  runId: string;
}): Promise<DreamJournalRun | undefined> {
  if (!RUN_ID_PATTERN.test(input.runId)) return undefined;
  const runId = input.runId;
  return runQueued(input.memoryRoot, () => readRunFileLocked(input.memoryRoot, runId));
}

function createRunHandle(
  memoryRoot: string,
  run: DreamJournalRun,
  reader: DreamJournalMemoryFileReader,
): DreamJournalRunHandle {
  const snapshots = new Map<string, Promise<void>>();
  // Set inside the queued finalize task, so snapshots queued before it still land. Once sealed,
  // later snapshots are no-ops. finalize itself may run again to replace the outcome (for example
  // a commit failure after a succeeded finalize); each pass re-reads `after` from disk.
  let sealed = false;

  return {
    id: run.id,
    async snapshotBeforeFirstTouch(filePath) {
      const file = memoryFileRelativePath(memoryRoot, filePath);
      if (file === undefined) {
        throw new Error("Dream journal snapshot target is outside the memory root");
      }
      // The journal must never snapshot itself; a write into it is refused rather than recorded.
      if (isJournalDirectoryPath(file)) {
        throw new Error("Dream journal snapshot target is inside the journal directory");
      }
      const existing = snapshots.get(file);
      if (existing) return existing;
      const pending = runQueued(memoryRoot, async () => {
        if (sealed) return;
        const before = await readSnapshot(reader, join(memoryRoot, file));
        run.items.push({ id: randomUUID(), file, before, after: null });
        await persistRunLocked(memoryRoot, run);
      });
      snapshots.set(file, pending);
      return pending;
    },
    finalize(input) {
      return runQueued(memoryRoot, async () => {
        sealed = true;
        return finalizeRunLocked(memoryRoot, run, input, reader);
      });
    },
  };
}

async function finalizeRunLocked(
  memoryRoot: string,
  run: DreamJournalRun,
  input: FinalizeDreamJournalRunInput,
  reader: DreamJournalMemoryFileReader,
): Promise<DreamJournalRun> {
  for (const item of run.items) {
    item.after = await readSnapshot(reader, join(memoryRoot, item.file));
  }
  // A file touched and restored to its prior content (or created and deleted again) is not a
  // change, so it is dropped rather than recorded as an empty update.
  run.items = run.items.flatMap((item) => {
    const action = deriveAction(item.before, item.after);
    return action ? [{ ...item, action }] : [];
  });
  run.finishedAt = input.now.toISOString();
  run.outcome =
    input.status === "failed" ? "failed" : run.items.length > 0 ? "learned" : "nothing";
  run.reasonCode = input.reasonCode;
  await persistRunLocked(memoryRoot, run);
  return run;
}

async function recoverInterruptedRunsLocked(
  memoryRoot: string,
  now: Date,
  reader: DreamJournalMemoryFileReader,
): Promise<void> {
  for (const run of await loadRunsLocked(memoryRoot)) {
    if (run.outcome !== "running") continue;
    try {
      await finalizeRunLocked(
        memoryRoot,
        run,
        { status: "failed", reasonCode: "interrupted", now },
        reader,
      );
    } catch {
      // One unreadable interrupted run must not stop journaling for the next run; it stays
      // "running" until the prune cap removes it.
    }
  }
}

function deriveAction(
  before: DreamJournalSnapshot | null,
  after: DreamJournalSnapshot | null,
): DreamJournalAction | undefined {
  if (before === null && after === null) return undefined;
  if (before === null) return "created";
  if (after === null) return "deleted";
  return before.content === after.content ? undefined : "updated";
}

async function readSnapshot(
  reader: DreamJournalMemoryFileReader,
  path: string,
): Promise<DreamJournalSnapshot | null> {
  const content = await reader(path);
  return content === null ? null : { content };
}

const readMemoryFileFromDisk: DreamJournalMemoryFileReader = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

async function loadRunsLocked(memoryRoot: string): Promise<DreamJournalRun[]> {
  let names: string[];
  try {
    names = await readdir(journalDirectory(memoryRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs: DreamJournalRun[] = [];
  for (const name of names) {
    if (!name.endsWith(RUN_FILE_EXTENSION)) continue;
    const runId = name.slice(0, -RUN_FILE_EXTENSION.length);
    if (!RUN_ID_PATTERN.test(runId)) continue;
    const run = await readRunFileLocked(memoryRoot, runId);
    if (run) runs.push(run);
  }
  return runs.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

async function readRunFileLocked(
  memoryRoot: string,
  runId: string,
): Promise<DreamJournalRun | undefined> {
  const path = runFilePath(memoryRoot, runId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const run = parseRun(raw, runId);
  if (run) return run;
  // Keep the bytes for diagnosis; a fresh record for this id is never written over them.
  const suffix = randomUUID().slice(0, CORRUPT_FILE_SUFFIX_LENGTH);
  await rename(path, `${path}${CORRUPT_FILE_MARKER}${suffix}`);
  return undefined;
}

async function persistRunLocked(memoryRoot: string, run: DreamJournalRun): Promise<void> {
  await mkdir(journalDirectory(memoryRoot), { recursive: true });
  await atomicWritePrivateTextFile(runFilePath(memoryRoot, run.id), JSON.stringify(run));
}

/**
 * Skip rows are capped on their own so a run of "no new turns" slots cannot push out real results.
 * Total overflow then evicts skipped rows (oldest first) before any learned, nothing or failed run.
 */
async function pruneLocked(memoryRoot: string): Promise<void> {
  const runs = await loadRunsLocked(memoryRoot); // newest first
  const skipped = runs.filter((run) => run.outcome === "skipped");
  const overflowSkipped = skipped.slice(DREAM_JOURNAL_SKIPPED_RUN_LIMIT);
  const victims = new Set<DreamJournalRun>(overflowSkipped);
  const remaining = runs.filter((run) => !victims.has(run));
  const excess = remaining.length - DREAM_JOURNAL_RUN_LIMIT;
  if (excess > 0) {
    const oldestFirst = [...remaining].reverse();
    const priority = [
      ...oldestFirst.filter((run) => run.outcome === "skipped"),
      ...oldestFirst.filter((run) => run.outcome !== "skipped"),
    ];
    for (const run of priority.slice(0, excess)) victims.add(run);
  }
  for (const run of victims) {
    await rm(runFilePath(memoryRoot, run.id), { force: true });
  }
}

/** Case-insensitive: macOS and Windows file systems resolve `.FORK_DREAM-JOURNAL` to the same directory. */
function isJournalDirectoryPath(relativePath: string): boolean {
  return relativePath.split(sep)[0]?.toLowerCase() === DREAM_JOURNAL_DIRECTORY_NAME;
}

function runQueued<T>(memoryRoot: string, task: () => Promise<T>): Promise<T> {
  const key = journalDirectory(memoryRoot);
  const result = (journalQueues.get(key) ?? Promise.resolve()).then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  journalQueues.set(key, tail);
  void tail.then(() => {
    if (journalQueues.get(key) === tail) journalQueues.delete(key);
  });
  return result;
}

function journalDirectory(memoryRoot: string): string {
  return join(memoryRoot, DREAM_JOURNAL_DIRECTORY_NAME);
}

function runFilePath(memoryRoot: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid dream journal run id");
  return join(journalDirectory(memoryRoot), `${runId}${RUN_FILE_EXTENSION}`);
}

/** Runtime validation: a run file is untrusted disk input, so every field is checked. */
function parseRun(raw: string, expectedId: string): DreamJournalRun | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { id, startedAt, finishedAt, trigger, outcome, reasonCode, items } = value;
  if (id !== expectedId) return undefined;
  if (!isIsoTimestamp(startedAt)) return undefined;
  if (finishedAt !== undefined && !isIsoTimestamp(finishedAt)) return undefined;
  if (!isOneOf(TRIGGERS, trigger) || !isOneOf(OUTCOMES, outcome)) return undefined;
  if (reasonCode !== undefined && typeof reasonCode !== "string") return undefined;
  if (!Array.isArray(items)) return undefined;
  const parsedItems: DreamJournalItem[] = [];
  for (const item of items) {
    const parsed = parseItem(item);
    if (!parsed) return undefined;
    parsedItems.push(parsed);
  }
  return {
    id: expectedId,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    trigger,
    outcome,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    items: parsedItems,
  };
}

function parseItem(value: unknown): DreamJournalItem | undefined {
  if (!isRecord(value)) return undefined;
  const { id, action, file, before, after } = value;
  if (typeof id !== "string" || typeof file !== "string" || file.length === 0) return undefined;
  if (action !== undefined && !isOneOf(ACTIONS, action)) return undefined;
  const parsedBefore = parseSnapshot(before);
  const parsedAfter = parseSnapshot(after);
  if (parsedBefore === undefined || parsedAfter === undefined) return undefined;
  return {
    id,
    ...(action === undefined ? {} : { action }),
    file,
    before: parsedBefore,
    after: parsedAfter,
  };
}

/** Returns undefined for an invalid snapshot, null for "file absent", otherwise the snapshot. */
function parseSnapshot(value: unknown): DreamJournalSnapshot | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.content !== "string") return undefined;
  return { content: value.content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
