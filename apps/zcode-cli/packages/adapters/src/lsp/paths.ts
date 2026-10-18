import { posix, win32 } from "node:path";
import { LspError } from "@zcode/contracts";

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):(\/.*)?$/u;

export function pathApiFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * Builds a `file:` URI for an absolute path. Windows drive letters are lowercased and the colon is kept
 * literal, matching what LSP clients such as VS Code send, so one folder never gets two URIs.
 */
export function filePathToFileUri(absolutePath: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return `file://${encodePathSegments(absolutePath)}`;
  }
  const forwardSlashed = absolutePath.replace(/\\/gu, "/");
  const drive = WINDOWS_DRIVE_PATH.exec(forwardSlashed);
  if (drive) {
    const [, letter = "", rest = ""] = drive;
    return `file:///${letter.toLowerCase()}:${encodePathSegments(rest)}`;
  }
  // UNC paths: `//server/share/x` becomes `file://server/share/x`.
  return `file:${encodePathSegments(forwardSlashed)}`;
}

function encodePathSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** True when `candidate` is `root` or lies below it. Uses the platform's own path rules. */
export function isPathInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const pathApi = pathApiFor(platform);
  const relative = pathApi.relative(root, candidate);
  if (relative === "") return true;
  if (pathApi.isAbsolute(relative)) return false;
  const [firstSegment = ""] = relative.split(/[\\/]/u);
  return firstSegment !== "..";
}

/**
 * Resolves `server.workspaceFolder` below the workspace. A folder that escapes the workspace is a
 * configuration error: the server must not be rooted outside what the user trusted.
 */
export function resolveWorkspaceFolder(
  workspacePath: string,
  workspaceFolder: string,
  platform: NodeJS.Platform,
): string {
  const pathApi = pathApiFor(platform);
  const resolved = pathApi.resolve(workspacePath, workspaceFolder);
  if (!isPathInside(workspacePath, resolved, platform)) {
    throw new LspError(
      "lsp_server_start_failed",
      `workspaceFolder ${JSON.stringify(workspaceFolder)} resolves outside the workspace`,
    );
  }
  return resolved;
}
