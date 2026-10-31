import type { IFileService } from "@zcode/services";
import {
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS,
} from "@zcode/shared";

interface RemoteWorkspaceIdentityInput {
  workspacePath: string;
  stableWorkspaceIdentity: string;
  legacyRouteHint?: string;
  signal?: AbortSignal;
}

export interface RemoteWorkspacePreparationOptions {
  /** Budget for the remote directory check. Defaults to REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS (30 seconds); tests shorten it. */
  timeoutMs?: number;
}

// Bug cause (ZCT-2113660144497782784): the deadline only ended Desktop's wait, while the remote readdir still held one
// libuv thread on Core. Each user retry sent another one; after 4 retries Core's thread pool was full and every file
// operation on the same device stopped returning.
// Fix: while a read for the same connection and path has not returned, reuse it instead of sending a new remote call.
// Entries are removed as soon as the read settles; results are never cached.
// The remote File Service is unique per physical connection, so connections are keyed by that instance.
const inFlightDirectoryReads = new WeakMap<object, Map<string, Promise<unknown>>>();

function readWorkspaceDirectory(
  fileService: Pick<IFileService, "readdir">,
  workspacePath: string,
): Promise<unknown> {
  const byPath = inFlightDirectoryReads.get(fileService) ?? new Map<string, Promise<unknown>>();
  inFlightDirectoryReads.set(fileService, byPath);
  const pending = byPath.get(workspacePath);
  if (pending) return pending;
  const read = fileService.readdir({ path: `${workspacePath}/.` });
  byPath.set(workspacePath, read);
  const clear = () => {
    if (byPath.get(workspacePath) === read) byPath.delete(workspacePath);
  };
  read.then(clear, clear);
  return read;
}

/**
 * Verifies the remote project folder and binds its identity, within a bounded budget.
 * A folder that does not answer in time is reported as unresponsive (retryable), which is distinct from a folder that
 * is missing or unreadable (not retryable), so the UI can tell a slow or disconnected mount from a deleted project.
 * Bug cause (R8): the remote filesystem call on the project directory may never return (for example, macOS waiting for
 * folder access authorization, or an unresponsive network drive). The RPC wait used to have no deadline, so the connection
 * stayed at "Starting and checking compatibility". After the deadline only this wait ends and the stuck step is reported;
 * the remote call itself is not ended, and the Source connection stays online.
 */
export async function prepareRemoteWorkspaceIdentity(
  fileService: Pick<IFileService, "readdir">,
  input: RemoteWorkspaceIdentityInput,
  bindWorkspaceIdentity?: (input: RemoteWorkspaceIdentityInput) => Promise<void>,
  options: RemoteWorkspacePreparationOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS;
  const budget = new AbortController();
  // The inner check sees the budget signal, so a late readdir result cannot bind a workspace after the timeout.
  // The deadline must abort this admission, not only fail the wait: the Host bind path does not abort the caller's signal on failure.
  const signal = input.signal ? AbortSignal.any([input.signal, budget.signal]) : budget.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(
        new Error(
          `Remote workspace directory did not respond within ${Math.round(timeoutMs / 1000)} seconds: ${input.workspacePath}`,
        ),
        { code: REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE, retryable: true },
      );
      budget.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([
      prepareWorkspace(fileService, { ...input, signal }, bindWorkspaceIdentity),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function prepareWorkspace(
  fileService: Pick<IFileService, "readdir">,
  input: RemoteWorkspaceIdentityInput,
  bindWorkspaceIdentity?: (input: RemoteWorkspaceIdentityInput) => Promise<void>,
): Promise<void> {
  input.signal?.throwIfAborted();
  const unavailable = () =>
    Object.assign(
      new Error(
        `Remote workspace directory is missing, is not a directory, or cannot be accessed: ${input.workspacePath}`,
      ),
      { code: REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE, retryable: false },
    );
  // A leaf directory whose permission was revoked still passes stat, and the identity mapping is stored outside the directory,
  // so that result cannot be trusted to allow access.
  // Reuse the remote readdir to verify read permission; keep the trailing /. so the remote also checks traversal permission on the target directory.
  // Do not normalize away /. with path.join, and do not use the controller's platform path rules or the local filesystem.
  try {
    await readWorkspaceDirectory(fileService, input.workspacePath);
  } catch (error) {
    input.signal?.throwIfAborted();
    // Symlink loops also count as an unavailable directory. Passing ELOOP through would skip the Renderer's Host ready notification,
    // so other projects of the same Source could not continue recovering.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    ) {
      throw unavailable();
    }
    // Network/protocol errors keep their original meaning and cannot be used to conclude that the remote directory was deleted.
    throw error;
  }
  input.signal?.throwIfAborted();
  await bindWorkspaceIdentity?.(input);
  input.signal?.throwIfAborted();
}
