import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { serverRuntimeManifestSchema, type ServerTarget } from "./manifest.js";

export interface ReleaseIdentity {
  archiveSha256: string;
  target: ServerTarget;
  version: string;
}

interface ReleaseIntegrity extends ReleaseIdentity {
  contentSha256: string;
}

export const RELEASE_INTEGRITY_FILE = ".release-integrity.json";

async function hashReleaseTree(root: string, relativeRoot = ""): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (relativePath === RELEASE_INTEGRITY_FILE) continue;
      const normalizedPath = relativePath.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        hash.update(`directory\0${normalizedPath}\0`);
        await visit(relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported release entry: ${normalizedPath}`);
      const fileStat = await stat(join(root, relativePath));
      hash.update(`file\0${normalizedPath}\0${fileStat.mode & 0o777}\0`);
      for await (const chunk of createReadStream(join(root, relativePath))) hash.update(chunk);
    }
  };
  await visit(relativeRoot);
  return hash.digest("hex");
}

function immutableReleaseConflict(releaseDir: string, error: unknown): Error {
  return new Error(
    `Existing immutable release conflict at ${releaseDir}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * An existing same-id release has exactly two legal outcomes: it matches this archive and can be
 * reused, or it is a damaged copy of this archive. The old implementation also reported a conflict
 * when the integrity record matched this archive but the on-disk content had drifted from the
 * record, so force-reinstalling the same archive failed forever and the only way out was manually
 * deleting releases/<id>. A missing record, or one pointing at a different identity, still cannot
 * be proven to be a copy of this release and fails as a conflict.
 */
async function inspectExistingRelease(
  releaseDir: string,
  expected: ReleaseIntegrity,
): Promise<"match" | "damaged"> {
  let integrity: Partial<ReleaseIntegrity>;
  try {
    integrity = JSON.parse(
      await readFile(join(releaseDir, RELEASE_INTEGRITY_FILE), "utf8"),
    ) as Partial<ReleaseIntegrity>;
  } catch (error) {
    throw immutableReleaseConflict(releaseDir, error);
  }
  if (
    integrity.archiveSha256 !== expected.archiveSha256 ||
    integrity.contentSha256 !== expected.contentSha256 ||
    integrity.target !== expected.target ||
    integrity.version !== expected.version
  ) {
    throw immutableReleaseConflict(releaseDir, "identity mismatch");
  }
  try {
    const runtimeManifest = serverRuntimeManifestSchema.parse(
      JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")),
    );
    if (
      runtimeManifest.target !== expected.target ||
      runtimeManifest.appVersion !== expected.version
    ) {
      return "damaged";
    }
    return (await hashReleaseTree(releaseDir)) === expected.contentSha256 ? "match" : "damaged";
  } catch {
    return "damaged";
  }
}

async function assertExistingReleaseMatches(
  releaseDir: string,
  expected: ReleaseIntegrity,
): Promise<void> {
  if ((await inspectExistingRelease(releaseDir, expected)) !== "match") {
    throw immutableReleaseConflict(releaseDir, "content does not match its integrity record");
  }
}

async function replaceDamagedRelease(incomingDir: string, targetDir: string): Promise<void> {
  // The caller holds the update lock. Move the damaged copy aside to a hidden sibling name first,
  // then rename the verified incoming directory into place; both steps are same-filesystem
  // renames. If the second step fails, move the damaged copy back to preserve the pre-repair
  // on-disk state.
  const damagedDir = join(
    dirname(targetDir),
    `.damaged-${basename(targetDir)}-${process.pid}-${randomUUID()}`,
  );
  await rename(targetDir, damagedDir);
  try {
    await rename(incomingDir, targetDir);
  } catch (error) {
    try {
      await rename(damagedDir, targetDir);
    } catch (rollbackError) {
      // A failed rollback used to be swallowed, reporting only the second error while releases/<id>
      // was already missing and current.json still pointed at it: the user saw neither the missing
      // directory nor where the damaged copy ended up. There is no atomic exchange between the two
      // steps, so the old directory is not guaranteed to return to its place — report honestly. A
      // later reinstall finds no target and recovers through the normal promote path.
      throw new AggregateError(
        [error, rollbackError],
        `Failed to replace damaged release ${targetDir}: ${error instanceof Error ? error.message : String(error)}; ` +
          `restoring it also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. ` +
          `The damaged copy is kept at ${damagedDir}; reinstall to recover.`,
      );
    }
    throw error;
  }
  await rm(damagedDir, { recursive: true, force: true }).catch(() => undefined);
}

async function existingPathKind(path: string): Promise<"directory" | "other" | null> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function promoteImmutableReleaseDirectory(options: {
  incomingDir: string;
  targetDir: string;
  identity: ReleaseIdentity;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/iu.test(options.identity.archiveSha256)) {
    throw new Error(`Invalid release archive SHA-256: ${options.identity.archiveSha256}`);
  }
  const integrity: ReleaseIntegrity = {
    ...options.identity,
    archiveSha256: options.identity.archiveSha256.toLowerCase(),
    contentSha256: await hashReleaseTree(options.incomingDir),
  };
  await writeFile(
    join(options.incomingDir, RELEASE_INTEGRITY_FILE),
    `${JSON.stringify(integrity, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  let promoted = false;
  try {
    const existingKind = await existingPathKind(options.targetDir);
    if (existingKind !== null) {
      if (existingKind !== "directory") {
        throw new Error(
          `Existing immutable release conflict at ${options.targetDir}: target is not a directory`,
        );
      }
      if ((await inspectExistingRelease(options.targetDir, integrity)) === "match") return;
      await replaceDamagedRelease(options.incomingDir, options.targetDir);
      promoted = true;
      return;
    }
    try {
      await rename(options.incomingDir, options.targetDir);
      promoted = true;
    } catch (error) {
      // Concurrent publishers may all see the target as missing first. After rename fails, validate and reuse only if another publisher actually created the target;
      // a generic Windows EPERM must not be mistaken for a hit.
      const racedKind = await existingPathKind(options.targetDir);
      if (racedKind !== "directory") throw error;
      await assertExistingReleaseMatches(options.targetDir, integrity);
    }
  } finally {
    // Reuse and failure both leave incoming untouched, so always clean it up to avoid leaving a full release after every retry.
    if (!promoted) await rm(options.incomingDir, { recursive: true, force: true });
  }
}
