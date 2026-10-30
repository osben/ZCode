import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// link(2) reports these when the filesystem cannot create hard links (for example FAT/exFAT volumes or some network mounts).
const HARD_LINK_UNSUPPORTED_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

interface LockOwnerRecord {
  ownerToken?: string;
  pid?: number;
  processIdentity?: string;
}

// Locks and recovery-gate tokens currently held by this process. When the PID is our own, only a token
// in this set proves the lock was written by this process.
const heldOwnerTokens = new Set<string>();
let ownProcessIdentity: Promise<string | null | undefined> | undefined;

export type DataRootLockInspection =
  | { state: "missing" }
  | { state: "active"; pid: number }
  | { state: "stale"; pid: number }
  | { state: "invalid" }
  | { state: "unreadable"; error: unknown };

export class DataRootLock {
  private ownerToken: string | undefined;
  public constructor(private readonly path: string) {}

  public async inspect(): Promise<DataRootLockInspection> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { state: "missing" };
      }
      return { state: "unreadable", error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "invalid" };
    }
    const record = toOwnerRecord(parsed);
    const pid = record.pid;
    if (pid === undefined) return { state: "invalid" };
    return (await isHolderAlive(record)) ? { state: "active", pid } : { state: "stale", pid };
  }

  public async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (await this.tryAcquireOnce()) return;
    const recoveryPath = `${this.path}.recovery`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await this.readOwner(this.path);
      if (observed && (await isHolderAlive(observed.record))) {
        throw new Error("Another ZCode Server instance is already running");
      }
      const recoveryToken = await this.tryAcquireRecoveryGate(recoveryPath);
      if (!recoveryToken) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        const current = await this.readOwner(this.path);
        if (current && (await isHolderAlive(current.record))) {
          throw new Error("Another ZCode Server instance is already running");
        }
        if (current) {
          await this.claimStalePath(this.path, current.raw);
        }
        if (await this.tryAcquireOnce()) return;
      } finally {
        await this.releaseOwnedPath(recoveryPath, recoveryToken);
        heldOwnerTokens.delete(recoveryToken);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Another ZCode Server instance is already running");
  }

  public async release(): Promise<void> {
    const token = this.ownerToken;
    this.ownerToken = undefined;
    if (token) {
      await this.releaseOwnedPath(this.path, token);
      heldOwnerTokens.delete(token);
    }
  }

  private async tryAcquireOnce(): Promise<boolean> {
    const ownerToken = await this.publishRecord(this.path);
    if (!ownerToken) return false;
    this.ownerToken = ownerToken;
    return true;
  }

  /**
   * Exclusively creates `path` holding a complete owner record and returns its token, or null when
   * `path` already exists.
   */
  private async publishRecord(path: string): Promise<string | null> {
    const ownerToken = randomUUID();
    const record = await createOwnerRecord(ownerToken);
    const content = `${JSON.stringify(record)}\n`;
    // Creating `path` first and writing afterwards would expose an empty record that contenders read
    // as stale and take over while this owner still believes it holds the path. Publishing a fully
    // written temp file via link() makes the record appear complete or not at all.
    const temp = `${path}.tmp-${process.pid}-${ownerToken}`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temp, path);
        heldOwnerTokens.add(ownerToken);
        return ownerToken;
      } catch (error: unknown) {
        if (errorCode(error) === "EEXIST") return null;
        if (!HARD_LINK_UNSUPPORTED_CODES.has(String(errorCode(error)))) throw error;
      }
      if (await this.publishRecordWithoutLink(path, content, ownerToken)) {
        heldOwnerTokens.add(ownerToken);
        return ownerToken;
      }
      return null;
    } finally {
      // A leftover temp file never blocks acquisition, so cleanup failures must not fail the caller.
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async publishRecordWithoutLink(
    path: string,
    content: string,
    ownerToken: string,
  ): Promise<boolean> {
    // Without hard links the record is created empty and then written, so a contender can still
    // observe it mid-write and treat it as stale; this only applies to filesystems that lack link().
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      return true;
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      if (errorCode(error) === "EEXIST") return false;
      const observed = await this.readOwner(path);
      if (observed?.record.ownerToken === ownerToken) {
        await this.releaseOwnedPath(path, ownerToken);
      }
      throw error;
    }
  }

  private async readOwner(path: string): Promise<{
    raw: string;
    record: LockOwnerRecord;
  } | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      return { raw, record: toOwnerRecord(JSON.parse(raw)) };
    } catch {
      return { raw, record: {} };
    }
  }

  private async tryAcquireRecoveryGate(path: string): Promise<string | null> {
    const ownerToken = await this.publishRecord(path);
    if (ownerToken) return ownerToken;
    const observed = await this.readOwner(path);
    if (observed && !(await isHolderAlive(observed.record))) {
      await this.claimStalePath(path, observed.raw);
    }
    return null;
  }

  private async claimStalePath(path: string, expectedRaw: string): Promise<void> {
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const claimedRaw = await readFile(quarantine, "utf8").catch(() => null);
    if (claimedRaw === expectedRaw) {
      await rm(quarantine, { force: true });
      return;
    }
    // If a stale observation accidentally claims a newer owner, restore it; do not delete the new owner's lock.
    await rename(quarantine, path).catch(() => undefined);
  }

  private async releaseOwnedPath(path: string, ownerToken: string): Promise<void> {
    const observed = await this.readOwner(path);
    if (observed?.record.ownerToken !== ownerToken) return;
    const quarantine = `${path}.release-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch {
      return;
    }
    const claimed = await this.readOwner(quarantine);
    if (claimed?.record.ownerToken === ownerToken) {
      await rm(quarantine, { force: true });
      return;
    }
    await rename(quarantine, path).catch(() => undefined);
  }
}

function toOwnerRecord(parsed: unknown): LockOwnerRecord {
  if (typeof parsed !== "object" || parsed === null) return {};
  const value = parsed as { ownerToken?: unknown; pid?: unknown; processIdentity?: unknown };
  return {
    ownerToken: typeof value.ownerToken === "string" ? value.ownerToken : undefined,
    pid:
      typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
        ? value.pid
        : undefined,
    processIdentity: typeof value.processIdentity === "string" ? value.processIdentity : undefined,
  };
}

async function createOwnerRecord(ownerToken: string): Promise<Record<string, unknown>> {
  ownProcessIdentity ??= readProcessIdentity(process.pid);
  const processIdentity = await ownProcessIdentity;
  return {
    pid: process.pid,
    acquiredAt: Date.now(),
    ownerToken,
    ...(processIdentity ? { processIdentity } : {}),
  };
}

// Liveness used to be decided by PID alone (own PID, kill(pid,0) success, or EPERM all counted as
// alive). After a container or WSL distribution restart every process is gone while the lock file
// survives, and the same boot sequence can hand the stale PID from the lock — or a recycled PID that
// now belongs to an unrelated process — back to the new Supervisor, which then reports "already
// running" and exits 1 on every start. Liveness now verifies the process identity: alive only when
// the identity matches the process that wrote the lock.
async function isHolderAlive(record: LockOwnerRecord): Promise<boolean> {
  const pid = record.pid;
  if (pid === undefined) return false;
  if (pid === process.pid) {
    return record.ownerToken !== undefined && heldOwnerTokens.has(record.ownerToken);
  }
  if (record.processIdentity !== undefined) {
    const current = await readProcessIdentity(pid);
    if (current !== undefined) return current === record.processIdentity;
  }
  // Locks written by older versions carry no identity field, and some platforms cannot read one;
  // fall back to the PID check for those.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: the process does not exist. EPERM: the PID belongs to another user; the lock file is
    // 0600 and only the current user can read it, so its writer cannot have been another user's
    // process — the PID must have been reused.
    return false;
  }
}

/**
 * Read the identity of a process. PIDs get reused; the process start time does not.
 * - Linux: boot_id plus the starttime field of /proc/<pid>/stat. A container restart keeps the
 *   kernel (and boot_id) but changes starttime; a full host restart changes boot_id, ruling out a
 *   coincidentally equal starttime.
 * - macOS: the launch time reported by ps, formatted with a fixed timezone.
 * Returns null when the process does not exist and undefined when the identity cannot be read.
 */
async function readProcessIdentity(pid: number): Promise<string | null | undefined> {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error: unknown) {
      return error instanceof Error && "code" in error && error.code === "ENOENT"
        ? null
        : undefined;
    }
    // The comm field may contain spaces and parentheses; count from after the last ")". There state
    // is field 3 and starttime is field 22, i.e. index 19 after the split.
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!startTime) return undefined;
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "");
    return `${bootId.trim()}:${startTime}`;
  }
  if (process.platform === "darwin") {
    try {
      // ps formats lstart in the calling process's timezone. When the lock writer and the lock
      // checker run with different TZ values (an SSH session with TZ set in the shell versus a
      // Supervisor launched by launchd, or a system timezone change in between), the same living
      // process would get different identities, be declared stale and taken over. Pin UTC so the
      // identity depends only on the process start time.
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      });
      return stdout.trim() || null;
    } catch (error: unknown) {
      // ps exits with code 1 when it cannot find the PID; when ps itself is unavailable the code
      // is a string.
      return error instanceof Error && "code" in error && typeof error.code === "number"
        ? null
        : undefined;
    }
  }
  return undefined;
}
