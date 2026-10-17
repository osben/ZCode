import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";

const LOCK_FILE = ".consolidate-lock";
const SUCCESS_FILE = ".consolidated-at";
const MANUAL_COOLDOWN_MS = 60 * 60 * 1000;

interface Marker {
  pid?: number;
  token?: string;
  status?: "running" | "succeeded";
}
interface StoredMarker {
  raw: string;
  mtimeMs: number;
  marker: Marker;
}
export interface DreamLockLease {
  token: string;
  prior: StoredMarker | null;
}

async function readMarker(path: string): Promise<StoredMarker | null> {
  try {
    const raw = await readFile(path, "utf8");
    const info = await stat(path);
    let marker: Marker;
    try {
      marker = JSON.parse(raw) as Marker;
    } catch {
      marker = { pid: Number(raw.trim()) };
    }
    if (!marker || typeof marker !== "object") marker = { pid: Number(raw.trim()) };
    return { raw, mtimeMs: info.mtimeMs, marker };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isLive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid! <= 1) return false;
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function readDreamLastConsolidatedAt(memoryRoot: string): Promise<number> {
  return (await readMarker(join(memoryRoot, LOCK_FILE)))?.mtimeMs ?? 0;
}

export async function acquireDreamLock(input: {
  memoryRoot: string;
  nowMs?: number;
  pid?: number;
}): Promise<DreamLockLease | null> {
  const path = join(input.memoryRoot, LOCK_FILE);
  const now = input.nowMs ?? Date.now();
  return withFileLock(path, async () => {
    const prior = await readMarker(path);
    if (prior) {
      const fresh = now - prior.mtimeMs < MANUAL_COOLDOWN_MS;
      if (prior.marker.status === "succeeded" ? fresh : isLive(prior.marker.pid)) return null;
      // A legacy writer may have created the file but not published its PID yet.
      if (!prior.marker.pid && prior.raw.trim() !== "0" && fresh) return null;
    }
    const token = randomUUID();
    await atomicWritePrivateTextFile(
      path,
      JSON.stringify({ pid: input.pid ?? process.pid, token, status: "running" }),
    );
    await utimes(path, now / 1000, now / 1000);
    return { token, prior };
  });
}

export async function restoreDreamLockAfterFailure(input: {
  memoryRoot: string;
  lease: DreamLockLease;
}): Promise<void> {
  const path = join(input.memoryRoot, LOCK_FILE);
  await withFileLock(path, async () => {
    if ((await readMarker(path))?.marker.token !== input.lease.token) return;
    if (!input.lease.prior) {
      await unlink(path);
      return;
    }
    // Restore the prior cursor as abandoned, never as a live owner of a failed attempt.
    await atomicWritePrivateTextFile(path, "0");
    await utimes(path, input.lease.prior.mtimeMs / 1000, input.lease.prior.mtimeMs / 1000);
  });
}

export async function writeDreamConsolidatedAt(
  memoryRoot: string,
  lease?: DreamLockLease,
): Promise<void> {
  await mkdir(memoryRoot, { recursive: true });
  const path = join(memoryRoot, LOCK_FILE);
  if (!lease) {
    await writeFile(join(memoryRoot, SUCCESS_FILE), "", "utf8");
    return;
  }
  await withFileLock(path, async () => {
    const current = await readMarker(path);
    if (current?.marker.token !== lease.token)
      throw new Error("Dream lock owner changed before completion");
    await atomicWritePrivateTextFile(
      path,
      JSON.stringify({ ...current.marker, status: "succeeded" }),
    );
    await utimes(path, current.mtimeMs / 1000, current.mtimeMs / 1000);
    await writeFile(join(memoryRoot, SUCCESS_FILE), "", "utf8");
  });
}
