import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN,
  CLI_MEMORY_DIAGNOSTIC_MAX_FILE_BYTES,
  CLI_MEMORY_DIAGNOSTIC_MAX_FILES,
  sanitizeCliMemoryDiagnostic,
} from "@zcode/shared";
import { acquireFileLock, atomicWritePrivateTextFile } from "@zcode/shared/node";

/** Files older than this are removed on the next write (7 days). */
export const CLI_MEMORY_DIAGNOSTIC_RETENTION_MS = 10_080 * 60 * 1000;
/** Files kept from the writing process's earlier runs (one older file plus the new one). */
const OWN_INSTANCE_KEEP_COUNT = 1;
const RECORDS_LOCK_NAME = "records";
const LOCK_OWNERLESS_GRACE_MS = 100;
const LOCK_MAX_WAIT_MS = 25;

/** Re-entrancy guard for this process: a write while another is in flight is dropped. */
let writeInFlight = false;

/**
 * Writes one sanitized profile record as `memory-<Date.now()>-<instanceId>.jsonl`, pruning the directory to at most
 * CLI_MEMORY_DIAGNOSTIC_MAX_FILES files. Every failure drops only this record.
 */
export async function writeMemoryDiagnostic(directory: string, payload: unknown): Promise<void> {
  if (writeInFlight) return;
  writeInFlight = true;
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const record = sanitizeCliMemoryDiagnostic(payload);
    if (!record || !record.instanceId) return;
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > CLI_MEMORY_DIAGNOSTIC_MAX_FILE_BYTES) return;

    await mkdir(directory, { recursive: true, mode: 0o700 });
    releaseLock = await acquireFileLock(
      join(directory, RECORDS_LOCK_NAME),
      [],
      LOCK_OWNERLESS_GRACE_MS,
      LOCK_MAX_WAIT_MS,
    );

    const candidates: Array<{ path: string; name: string; mtime: number }> = [];
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if (name.startsWith(".memory-") && name.endsWith(".tmp")) {
        await rm(path, { force: true });
      } else if (CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN.test(name)) {
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > CLI_MEMORY_DIAGNOSTIC_MAX_FILE_BYTES ||
          Date.now() - info.mtimeMs > CLI_MEMORY_DIAGNOSTIC_RETENTION_MS
        ) {
          await rm(path, { force: true });
        } else {
          candidates.push({ path, name, mtime: info.mtimeMs });
        }
      }
    }

    candidates.sort((left, right) => right.mtime - left.mtime);
    let ownCount = 0;
    const kept: typeof candidates = [];
    for (const candidate of candidates) {
      if (
        candidate.name.endsWith(`-${record.instanceId}.jsonl`) &&
        ++ownCount > OWN_INSTANCE_KEEP_COUNT
      ) {
        await rm(candidate.path, { force: true });
      } else {
        kept.push(candidate);
      }
    }
    for (const candidate of kept.slice(CLI_MEMORY_DIAGNOSTIC_MAX_FILES - 1)) {
      await rm(candidate.path, { force: true });
    }

    const fileName = `memory-${Date.now()}-${record.instanceId}.jsonl`;
    await atomicWritePrivateTextFile(join(directory, fileName), line, []);
  } catch {
    // A failed write drops this record only; the profile recorder keeps running.
  } finally {
    try {
      await releaseLock?.();
    } catch {
      // A lock release failure must not affect later writes; the lock is reclaimed as ownerless.
    }
    writeInFlight = false;
  }
}
