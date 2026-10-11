// Resolves the binaries compared by the stage-1 spike: pinned tgrep 1.1.0 and the
// repository-bundled rg/ugrep sidecars. Binaries are cached outside the repository and never
// committed; the tgrep archive digest is pinned here and verified before extraction.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm, access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const TGREP_VERSION = "1.1.0";
export const TGREP_RELEASE_TAG = "v1.1.0";

// Digests cross-checked against the GitHub release API and the release `checksums.txt`.
export const TGREP_ARCHIVE_SHA256_BY_TARGET = Object.freeze({
  "aarch64-apple-darwin": "22a750a5d30a11d4e3a2503f2bc40e2ed694b01f011d6dc0cb4c674031503737",
  "x86_64-apple-darwin": "f745ab68456534e76fc67c67a4abf503b962de60f1e844f7ac45b010dac105af",
  "aarch64-unknown-linux-musl": "ae73fa72c182a55a1176ed64e8ee46a24dc469f23259c9179204001bb87bb205",
  "x86_64-unknown-linux-musl": "c6dbb89581453b41eee94ff291de859d37ce7972c4208bf9eab53e67bf6e3f9d",
  "aarch64-pc-windows-msvc": "b1a201f5a561289468d4122b05e47d0af810b16364cb29e564f8a55450b72c72",
  "x86_64-pc-windows-msvc": "8a47a00964b4f2a8213693b76807b96c956bbd1ba5eede5eb5a06df992ab3a65",
});

export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "zcode-tgrep-stage1");

export function resolveHostTgrepTarget() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch) throw new Error(`unsupported host arch ${process.arch}`);
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "linux") return `${arch}-unknown-linux-musl`;
  throw new Error(`stage-1 spike supports darwin/linux hosts, got ${process.platform}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(url, target, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`download failed ${response.status} ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(target, buffer);
  } finally {
    clearTimeout(timer);
  }
}

async function extractTar(archive, dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
}

// Node hashing keeps the spike portable: Linux hosts may ship sha256sum but not shasum.
async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * Ensures the pinned tgrep binary plus the repository-bundled rg/ugrep are ready.
 * Returns absolute binary paths and evidence metadata for the results file.
 */
export async function resolveSpikeTools({ repoRoot, cacheDir = DEFAULT_CACHE_DIR }) {
  const target = resolveHostTgrepTarget();
  const nativeSearchDir = resolve(repoRoot, "apps/zcode-cli/dependencies/native-search");
  const archiveName = `tgrep-${TGREP_RELEASE_TAG}-${target}.tar.gz`;
  const pinnedSha = TGREP_ARCHIVE_SHA256_BY_TARGET[target];
  const archivesDir = join(cacheDir, "archives");
  const tgrepDir = join(cacheDir, `tgrep-${TGREP_RELEASE_TAG}-${target}`);
  await mkdir(archivesDir, { recursive: true });

  const archivePath = join(archivesDir, archiveName);
  if (!(await exists(join(tgrepDir, "tgrep")))) {
    if (!(await exists(archivePath))) {
      await downloadToFile(
        `https://github.com/microsoft/tgrep/releases/download/${TGREP_RELEASE_TAG}/${archiveName}`,
        archivePath,
      );
    }
    const actual = await sha256File(archivePath);
    if (actual !== pinnedSha) {
      // Drop the bad bytes so the next run re-downloads instead of failing on the same file.
      await rm(archivePath, { force: true });
      throw new Error(
        `tgrep archive digest mismatch for ${archiveName}: ${actual} != ${pinnedSha}`,
      );
    }
    await extractTar(archivePath, tgrepDir);
  }

  // rg/ugrep come from the repository archives so the comparison target is exactly the
  // shipped native-search release, not whatever is on the host PATH.
  const bundledArchiveByTarget = {
    "aarch64-apple-darwin": {
      rg: "ripgrep-v14.1.1-1/ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz",
      ugrep: "ugrep-v7.8.4-1/ugrep-v7.8.4-1-aarch64-apple-darwin.tar.gz",
    },
    "x86_64-apple-darwin": {
      rg: "ripgrep-v14.1.1-1/ripgrep-v14.1.1-1-x86_64-apple-darwin.tar.gz",
      ugrep: "ugrep-v7.8.4-1/ugrep-v7.8.4-1-x86_64-apple-darwin.tar.gz",
    },
    "aarch64-unknown-linux-musl": {
      rg: "ripgrep-v14.1.1-1/ripgrep-v14.1.1-1-aarch64-unknown-linux-musl.tar.gz",
      ugrep: "ugrep-v7.8.4-1/ugrep-v7.8.4-1-aarch64-unknown-linux-gnu.tar.gz",
    },
    "x86_64-unknown-linux-musl": {
      rg: "ripgrep-v14.1.1-1/ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz",
      ugrep: "ugrep-v7.8.4-1/ugrep-v7.8.4-1-x86_64-unknown-linux-gnu.tar.gz",
    },
  };
  const bundled = bundledArchiveByTarget[target];
  if (!bundled) throw new Error(`no repository-bundled rg/ugrep archive for ${target}`);
  const rgArchive = resolve(nativeSearchDir, bundled.rg);
  const ugrepArchive = resolve(nativeSearchDir, bundled.ugrep);
  const rgDir = join(cacheDir, "rg-v14.1.1-1");
  const ugrepDir = join(cacheDir, "ugrep-v7.8.4-1");
  if (!(await exists(join(rgDir, "rg")))) await extractTar(rgArchive, rgDir);
  if (!(await exists(join(ugrepDir, "ugrep")))) await extractTar(ugrepArchive, ugrepDir);

  const tgrepPath = join(tgrepDir, "tgrep");
  const rgPath = join(rgDir, "rg");
  const ugrepPath = join(ugrepDir, "ugrep");
  const versionOf = (bin, args = ["--version"]) =>
    execFileSync(bin, args, { encoding: "utf8" }).trim();

  return {
    target,
    binaries: { tgrep: tgrepPath, rg: rgPath, ugrep: ugrepPath },
    evidence: {
      tgrep: { version: versionOf(tgrepPath), archive: archiveName, archiveSha256: pinnedSha },
      rg: { version: versionOf(rgPath).split("\n")[0] },
      ugrep: { version: versionOf(ugrepPath).split("\n")[0] },
    },
  };
}
