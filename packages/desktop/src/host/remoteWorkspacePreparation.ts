import type { IFileService } from "@zcode/services";
import {
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
} from "@zcode/shared";

interface RemoteWorkspaceIdentityInput {
  workspacePath: string;
  stableWorkspaceIdentity: string;
  legacyRouteHint?: string;
  signal?: AbortSignal;
}

export interface RemoteWorkspacePreparationOptions {
  /** Budget for the remote directory check. The default is the 3.16.3 30 second budget; tests shorten it. */
  timeoutMs?: number;
}

const DEFAULT_WORKSPACE_PREPARATION_TIMEOUT_MS = 30_000;

/**
 * Verifies the remote project folder and binds its identity, within a bounded budget.
 * A folder that does not answer in time is reported as unresponsive (retryable), which is distinct from a folder that
 * is missing or unreadable (not retryable), so the UI can tell a slow or disconnected mount from a deleted project.
 */
export async function prepareRemoteWorkspaceIdentity(
  fileService: Pick<IFileService, "readdir">,
  input: RemoteWorkspaceIdentityInput,
  bindWorkspaceIdentity?: (input: RemoteWorkspaceIdentityInput) => Promise<void>,
  options: RemoteWorkspacePreparationOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKSPACE_PREPARATION_TIMEOUT_MS;
  const budget = new AbortController();
  // The inner check sees the budget signal, so a late readdir result cannot bind a workspace after the timeout.
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
  // 叶目录收回权限后 stat 仍会成功，身份映射也保存在目录之外，不能据此放行。
  // 复用远端 readdir 验证读取权限；保留末尾 /. 让远端同时检查目标目录的遍历权限。
  // 不用 path.join 归一化掉 /.，也不使用控制端的平台路径规则或本地文件系统。
  try {
    await fileService.readdir({ path: `${input.workspacePath}/.` });
  } catch (error) {
    input.signal?.throwIfAborted();
    // 符号链接循环也属于目录不可用；透传 ELOOP 会跳过 Renderer 的 Host ready 通知，
    // 导致同一 Source 的其他项目无法继续恢复。
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    ) {
      throw unavailable();
    }
    // 网络/协议错误保持原语义，不能据此判断远端目录已被删除。
    throw error;
  }
  input.signal?.throwIfAborted();
  await bindWorkspaceIdentity?.(input);
  input.signal?.throwIfAborted();
}
