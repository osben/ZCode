import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServiceLogger } from "@zcode/services/node";
import { withFileLock } from "@zcode/shared/node";
import {
  releaseManifestSchema,
  SERVER_CREDENTIAL_FORMAT,
  type ReleaseManifest,
} from "../contracts.js";
import type { ServerLayout } from "./paths.js";
import { ensureServerInstallOwnership } from "./installationOwnership.js";

const PRUNING_PREFIX = ".pruning-";
const log = createServiceLogger("server-release-manager");

interface UpdateTransaction {
  previous: ReleaseManifest | null;
}

async function renameWithWindowsRetry(temporary: string, path: string): Promise<void> {
  // Concurrent writes use unique temporary files, but when replacing the same target on Windows,
  // the target file may be briefly locked and a later rename can fail with EPERM (POSIX atomic replacement has no such race).
  // Concurrent writes already allow "later write wins" semantically, so bounded retries for EPERM/EBUSY converge;
  // POSIX hosts do not retry and behavior is unchanged.
  const maxAttempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= maxAttempts || (code !== "EPERM" && code !== "EBUSY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Two lifecycle operations in the same process may write the same temporary file in the same millisecond; after one rename succeeds,
  // the other write fails with ENOENT. A random suffix gives every atomic write a unique temporary path.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithWindowsRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class ReleaseManager {
  public constructor(private readonly layout: ServerLayout) {}

  public async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.layout.serverRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.layout.releasesDir, { recursive: true, mode: 0o700 }),
      mkdir(this.layout.runDir, { recursive: true, mode: 0o700 }),
    ]);
    await ensureServerInstallOwnership(this.layout);
  }

  public async beginUpdate(previous: ReleaseManifest | null): Promise<void> {
    await atomicWriteJson(this.layout.updateTransactionFile, { previous });
  }

  public async completeUpdate(): Promise<void> {
    await rm(this.layout.updateTransactionFile, { force: true });
  }

  public async applyPendingWithTransaction(
    previous: ReleaseManifest | null,
  ): Promise<ReleaseManifest> {
    await this.beginUpdate(previous);
    return await this.applyPending();
  }

  public async recoverInterruptedUpdate(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.layout.updateTransactionFile, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    let transaction: UpdateTransaction;
    try {
      const parsed = JSON.parse(raw) as { previous?: unknown };
      transaction = {
        previous: parsed.previous === null ? null : releaseManifestSchema.parse(parsed.previous),
      };
    } catch (error: unknown) {
      throw new Error(`Update transaction is invalid: ${this.layout.updateTransactionFile}`, {
        cause: error,
      });
    }
    // applyPending switches current before deleting pending; if the process exits before Core is ready,
    // current may point to a release that did not start successfully.
    // On startup, restore the old pointer from the transaction first. If restoration fails, keep the marker so later startup remains fail-closed.
    await this.restoreCurrent(transaction.previous);
    await this.completeUpdate();
  }

  public async readCurrent(): Promise<ReleaseManifest | null> {
    return await this.readManifest(this.layout.currentFile);
  }

  public async readCurrentForExecution(): Promise<ReleaseManifest | null> {
    const manifest = await this.readCurrent();
    if (!manifest) return null;
    // All current.json write paths validate releaseDir, but local leftovers or external tampering may still
    // give startup an out-of-bounds pointer. Validate the boundary again before running Core so reading recovery/update metadata is not mistaken for execution authorization.
    await this.assertReleaseDir(manifest);
    return manifest;
  }

  public async readPending(): Promise<ReleaseManifest | null> {
    return await this.readManifest(this.layout.pendingFile);
  }

  public async removePending(): Promise<void> {
    await rm(this.layout.pendingFile, { force: true });
  }

  /**
   * The mark is valid only while releaseId equals current.json: a later upgrade, or a failed
   * upgrade rolling back to another release, invalidates it naturally, so readers need no extra cleanup ordering.
   */
  public async markDowngrade(target: ReleaseManifest, fromVersion: string): Promise<void> {
    await atomicWriteJson(this.layout.downgradeMarkerFile, {
      releaseId: target.releaseId,
      fromVersion,
    });
  }

  public async writePending(manifest: ReleaseManifest): Promise<void> {
    const parsed = releaseManifestSchema.parse({
      ...manifest,
      releaseDir: resolve(manifest.releaseDir),
    });
    await this.assertReleaseDir(parsed);
    await atomicWriteJson(this.layout.pendingFile, parsed);
  }

  public async applyPending(): Promise<ReleaseManifest> {
    const pending = await this.readPending();
    if (!pending) {
      throw new Error("No pending release is prepared");
    }
    await this.assertReleaseDir(pending);
    await this.assertCredentialCompatibility(pending);
    await atomicWriteJson(this.layout.currentFile, pending);
    await rm(this.layout.pendingFile, { force: true });
    return pending;
  }

  public async restoreCurrent(manifest: ReleaseManifest | null): Promise<void> {
    if (manifest) {
      await this.assertReleaseDir(manifest);
      await this.assertCredentialCompatibility(manifest);
      await atomicWriteJson(this.layout.currentFile, manifest);
      return;
    }
    await rm(this.layout.currentFile, { force: true });
  }

  private async assertCredentialCompatibility(manifest: ReleaseManifest): Promise<void> {
    const filePath = join(this.layout.dataBaseDir, ".zcode", "v2", "credentials.json");
    await withFileLock(filePath, async () => {
      const raw = await readFile(filePath, "utf8").catch((error) => {
        if ((error as { code?: string }).code === "ENOENT") return "";
        throw error;
      });
      if (!raw.includes("enc:v2:")) return;
      const metadata = await readFile(join(manifest.releaseDir, "runtime", "package.json"), "utf8")
        .then((value) => JSON.parse(value) as { zcodeCredentialFormat?: unknown })
        .catch(() => null);
      if (metadata?.zcodeCredentialFormat === SERVER_CREDENTIAL_FORMAT) return;
      // 旧版把未知密文当成 token，会在 401 后清掉账号。宁可保留现场并拒绝降级。
      throw Object.assign(
        new Error(
          "Cannot roll back to a release that cannot read current encrypted credentials. Credentials are preserved; use a compatible release to recover.",
        ),
        {
          code: "CREDENTIAL_ROLLBACK_INCOMPATIBLE",
        },
      );
    });
  }

  /**
   * 更新成功换代后回收旧 release，只保留 current、本次被替换的 previous 与 pending 引用的目录。
   * Bug 原因：每次版本更新都新增一个完整 release（解压后约 300MB 以上），过去从不回收，
   * 远端磁盘随版本线性增长。调用方必须持有 update.lock，且指针切换与 daemon 收敛均已完成；
   * 本方法以磁盘上的 current.json 为准判断是否换代，未换代（首装、重装同一 release）不回收。
   */
  public async pruneReleases(previous: ReleaseManifest | null): Promise<void> {
    const current = await this.readCurrent();
    if (!current || !previous) return;
    const pending = await this.readPending();
    const currentName = await this.releaseDirName(current);
    const previousName = await this.releaseDirName(previous);
    if (currentName === previousName) return;
    const retained = new Set([currentName, previousName]);
    if (pending) retained.add(await this.releaseDirName(pending));
    for (const entry of await readdir(this.layout.releasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(this.layout.releasesDir, entry.name);
      try {
        if (entry.name.startsWith(PRUNING_PREFIX)) {
          await rm(entryPath, { recursive: true, force: true });
          continue;
        }
        if (entry.name.startsWith(".") || retained.has(entry.name)) continue;
        // 先 rename 为隐藏名再删除：中断时只残留 .pruning-*，不会留下缺少完整性记录的
        // releases/<id> 半目录，否则之后重装同一 release 会被 promote 判为冲突。
        const pruningPath = join(
          this.layout.releasesDir,
          `${PRUNING_PREFIX}${entry.name}-${randomUUID()}`,
        );
        await rename(entryPath, pruningPath);
        await rm(pruningPath, { recursive: true, force: true });
        log.info("pruned inactive release", { releaseId: entry.name });
      } catch (error: unknown) {
        // 回收只是收尾：Windows 目录被占用等单项失败不能让已成功的更新变成失败。
        log.warn("failed to prune inactive release", { releaseId: entry.name, error });
      }
    }
  }

  /** 解析 manifest 指向的 releases/ 直接子目录名；无法证明边界时抛错，由调用方放弃整次回收。 */
  private async releaseDirName(manifest: ReleaseManifest): Promise<string> {
    const releaseDir = resolve(manifest.releaseDir);
    const canonicalReleaseDir = await realpath(releaseDir).catch(() => releaseDir);
    const canonicalReleasesDir = await realpath(this.layout.releasesDir).catch(() =>
      resolve(this.layout.releasesDir),
    );
    const name = relative(canonicalReleasesDir, canonicalReleaseDir);
    if (!name || name.startsWith(".") || name.includes(sep) || isAbsolute(name)) {
      throw new Error(`Release directory is not a direct child of releases: ${releaseDir}`);
    }
    return name;
  }

  private async readManifest(path: string): Promise<ReleaseManifest | null> {
    try {
      const raw = await readFile(path, "utf8");
      return releaseManifestSchema.parse(JSON.parse(raw));
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async assertReleaseDir(manifest: ReleaseManifest): Promise<void> {
    const releaseDir = resolve(manifest.releaseDir);
    // The canonical server root resolves symlinks such as /var to physical paths, but legacy manifests may still store alias paths.
    // Canonicalize during boundary checks too, so valid historical releases are not incorrectly treated as out of bounds.
    const canonicalReleaseDir = await realpath(releaseDir).catch(() => releaseDir);
    const canonicalReleasesDir = await realpath(this.layout.releasesDir).catch(() =>
      resolve(this.layout.releasesDir),
    );
    if (
      !canonicalReleaseDir.startsWith(
        `${canonicalReleasesDir}${process.platform === "win32" ? "\\" : "/"}`,
      )
    ) {
      throw new Error("Release directory must be inside the server releases directory");
    }
    const releaseStat = await stat(releaseDir).catch(() => null);
    if (!releaseStat?.isDirectory()) {
      throw new Error(`Release directory does not exist: ${releaseDir}`);
    }
  }
}
