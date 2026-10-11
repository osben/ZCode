import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { IRemoteBackend } from "@zcode/server/remote";
import type { BrowserRecordingArtifact } from "@zcode/shared";

function resolveWorkspaceRecordingPath(workspacePath: string, outputPath: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, outputPath);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || resolve(root, relation) !== target) {
    throw new Error("recording outputPath must stay inside the workspace");
  }
  if (!target.toLowerCase().endsWith(".webm")) {
    throw new Error("recording outputPath must end with .webm");
  }
  return target;
}

/**
 * Main returns only a short-lived WebM; Host writes it under the current workspace authority. Locally, use a same-directory rename; remotely,
 * reuse the existing backend.upload so the remote Agent does not depend on a Desktop temporary path.
 */
export async function materializeBrowserRecordingArtifact(input: {
  artifact: BrowserRecordingArtifact;
  localPath: string;
  outputPath: string;
  workspacePath: string;
  remoteSessionId?: string;
  remoteBackend?: Pick<IRemoteBackend, "upload">;
}): Promise<BrowserRecordingArtifact> {
  if (input.remoteSessionId) {
    if (!input.remoteBackend) {
      throw new Error("remote Browser recording materialization is unavailable for this session");
    }
    const normalizedWorkspace = posix.normalize(input.workspacePath.replace(/\\/gu, "/"));
    const rawOutputSegments = input.outputPath.split(/[\\/]+/u);
    const normalizedOutput = posix.normalize(input.outputPath.replace(/\\/gu, "/"));
    if (
      rawOutputSegments.some((segment) => segment === ".." || segment === "." || !segment) ||
      normalizedOutput === ".." ||
      normalizedOutput.startsWith("../") ||
      posix.isAbsolute(normalizedOutput)
    ) {
      throw new Error("recording outputPath must stay inside the remote workspace");
    }
    if (!normalizedOutput.toLowerCase().endsWith(".webm")) {
      throw new Error("recording outputPath must end with .webm");
    }
    const remoteTargetPath = posix.join(normalizedWorkspace, normalizedOutput);
    await input.remoteBackend.upload(input.localPath, remoteTargetPath);
    return { ...input.artifact, path: remoteTargetPath };
  }

  const targetPath = resolveWorkspaceRecordingPath(input.workspacePath, input.outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const stagingPath = `${targetPath}.zcode-recording-${randomUUID()}.tmp`;
  try {
    await copyFile(input.localPath, stagingPath);
    // Windows cannot atomically replace an existing file with rename; remove the explicit target WebM first, then commit the staging file.
    await rm(targetPath, { force: true });
    await rename(stagingPath, targetPath);
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
  return { ...input.artifact, path: targetPath };
}
