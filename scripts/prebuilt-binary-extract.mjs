import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import process from "node:process";
import { runCommand } from "./spawn-command.mjs";

// Bug fix: Windows GNU tar (Git Bash) treats the drive-letter colon (C:) in the -f archive path as a remote host,
// and MSYS argument conversion can corrupt backslash paths. A cwd-relative archive path is not enough: across
// drives path.win32.relative() returns the absolute target, colon included (fork release run 41171314864).
// Run tar from the archive's directory and pass only its file name; -C is never parsed as a remote spec.
function toTarPosixPath(pathValue) {
  return pathValue.replaceAll("\\", "/");
}

export function resolveTarExtractInvocation({
  archivePath,
  extractDir,
  cwd,
  platform = process.platform,
}) {
  if (platform === "win32") {
    const absoluteArchivePath = win32.resolve(cwd, archivePath);
    return {
      args: [
        "-xzf",
        win32.basename(absoluteArchivePath),
        "-C",
        toTarPosixPath(win32.resolve(cwd, extractDir)),
      ],
      cwd: win32.dirname(absoluteArchivePath),
    };
  }

  return { args: ["-xzf", archivePath, "-C", extractDir], cwd };
}

export function extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd }) {
  mkdirSync(extractDir, { recursive: true });
  if (archiveExt === "zip") {
    if (process.platform === "win32") {
      runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
      ]);
      return;
    }

    runCommand("unzip", ["-q", archivePath, "-d", extractDir], { cwd });
    return;
  }

  const tarInvocation = resolveTarExtractInvocation({
    archivePath,
    extractDir,
    cwd: cwd ?? process.cwd(),
  });
  runCommand("tar", tarInvocation.args, { cwd: tarInvocation.cwd });
}

export function findPrebuiltBinary(rootDir, binaryName) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findPrebuiltBinary(fullPath, binaryName);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && entry.name === binaryName) return fullPath;
  }

  return undefined;
}

export function assertPrebuiltArchiveSha256(expectedSha256) {
  const normalizedExpectedSha256 = String(expectedSha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpectedSha256)) {
    throw new Error("missing prebuilt archive SHA-256");
  }
  return normalizedExpectedSha256;
}

export function verifyPrebuiltArchiveSha256(archivePath, expectedSha256) {
  const normalizedExpectedSha256 = assertPrebuiltArchiveSha256(expectedSha256);
  const actualSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actualSha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Archive SHA-256 mismatch: expected ${normalizedExpectedSha256}, received ${actualSha256}`,
    );
  }
}

export async function extractPrebuiltBinary({
  archiveExt,
  archivePath,
  archiveSha256,
  binaryName,
  binaryPath,
  cwd,
  targetPlatform,
  validateBinary,
}) {
  verifyPrebuiltArchiveSha256(archivePath, archiveSha256);
  mkdirSync(dirname(binaryPath), { recursive: true });
  mkdirSync(tmpdir(), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-prebuilt-binary-"));
  const extractDir = join(tempDir, "extract");

  try {
    extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd });
    const extractedBinaryPath = findPrebuiltBinary(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Failed to locate ${binaryName} in extracted archive`);
    }

    // A foreign target cannot be validated by executing the target file; validate the temporary artifact before replacing the final path.
    await validateBinary?.(extractedBinaryPath);
    copyFileSync(extractedBinaryPath, binaryPath);
    if (targetPlatform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    // Bug fix: on Windows, antivirus/indexing or a still-running extraction child process may briefly hold a handle to extracted files.
    // An immediate rmSync can fail with EPERM, and an exception from finally would hide the original extraction error.
    // Retry deletion and warn on failure so the original error can propagate.
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[warn] 清理临时目录失败（可忽略）: ${tempDir}`);
      console.warn(`[warn] ${String(error)}`);
    }
  }
}
