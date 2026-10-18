import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

// link(2) reports these when the filesystem cannot create hard links (for example FAT/exFAT volumes or some network mounts).
const HARD_LINK_UNSUPPORTED_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

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
    const pid =
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
        ? parsed.pid
        : undefined;
    if (pid === undefined) return { state: "invalid" };
    return this.isHolderAlive(pid) ? { state: "active", pid } : { state: "stale", pid };
  }

  public async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (await this.tryAcquireOnce()) return;
    const recoveryPath = `${this.path}.recovery`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await this.readOwner(this.path);
      if (observed && this.isHolderAlive(observed.record.pid)) {
        throw new Error("Another ZCode Server instance is already running");
      }
      const recoveryToken = await this.tryAcquireRecoveryGate(recoveryPath);
      if (!recoveryToken) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        const current = await this.readOwner(this.path);
        if (current && this.isHolderAlive(current.record.pid)) {
          throw new Error("Another ZCode Server instance is already running");
        }
        if (current) {
          await this.claimStalePath(this.path, current.raw);
        }
        if (await this.tryAcquireOnce()) return;
      } finally {
        await this.releaseOwnedPath(recoveryPath, recoveryToken);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Another ZCode Server instance is already running");
  }

  public async release(): Promise<void> {
    const token = this.ownerToken;
    this.ownerToken = undefined;
    if (token) await this.releaseOwnedPath(this.path, token);
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
    const content = `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), ownerToken })}\n`;
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
        return ownerToken;
      } catch (error: unknown) {
        if (errorCode(error) === "EEXIST") return null;
        if (!HARD_LINK_UNSUPPORTED_CODES.has(String(errorCode(error)))) throw error;
      }
      return (await this.publishRecordWithoutLink(path, content, ownerToken)) ? ownerToken : null;
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
    record: { ownerToken?: string; pid?: number };
  } | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { ownerToken?: unknown; pid?: unknown };
      return {
        raw,
        record: {
          ownerToken: typeof parsed.ownerToken === "string" ? parsed.ownerToken : undefined,
          pid:
            typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
              ? parsed.pid
              : undefined,
        },
      };
    } catch {
      return { raw, record: {} };
    }
  }

  public isHolderAlive(pid: number | undefined): boolean {
    if (pid === undefined) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      // ESRCH means the process does not exist (stale); EPERM means it exists but access is denied, so conservatively treat it as alive.
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  }

  private async tryAcquireRecoveryGate(path: string): Promise<string | null> {
    const ownerToken = await this.publishRecord(path);
    if (ownerToken) return ownerToken;
    const observed = await this.readOwner(path);
    if (observed && !this.isHolderAlive(observed.record.pid)) {
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
