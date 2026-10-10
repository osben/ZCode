import type { RemoteTarget } from "@zcode/shared";
import type { UserInstructionsReadResult } from "@zcode/services";

export type UserInstructionsLoadedFile = Extract<UserInstructionsReadResult, { kind: "ok" }>;

/** 指令编辑器的目标主机描述；与 useWorkspaceServicesResolution 的入参一一对应。 */
export interface UserInstructionsHostTarget {
  workspacePath: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
}

export const LOCAL_USER_INSTRUCTIONS_HOST_KEY = "local";

export function isRemoteUserInstructionsTarget(target: UserInstructionsHostTarget): boolean {
  return Boolean(
    target.workspacePath &&
    (target.workspaceIdentity?.trim() || target.remoteSessionId?.trim() || target.remoteTarget),
  );
}

/**
 * 目标主机 key：`local` 或 `remote:<identity || path>`。
 * remoteSessionId 只表示一次连接，同一远端重连不能被当成切换主机。
 */
export function getUserInstructionsHostKey(target: UserInstructionsHostTarget): string {
  if (!target.workspacePath || !isRemoteUserInstructionsTarget(target)) {
    return LOCAL_USER_INSTRUCTIONS_HOST_KEY;
  }
  return `remote:${target.workspaceIdentity?.trim() || target.workspacePath}`;
}

/**
 * 计算编辑器实际绑定的目标主机。
 * 有未保存草稿时，活动 workspace 切到另一台主机不能把草稿"带"过去写错文件，
 * 因此保持绑定旧主机，直到用户保存或明确放弃；同一主机只更新连接元数据。
 */
export function resolvePinnedUserInstructionsTarget(params: {
  pinned: UserInstructionsHostTarget;
  active: UserInstructionsHostTarget;
  dirty: boolean;
}): UserInstructionsHostTarget {
  const { pinned, active, dirty } = params;
  if (getUserInstructionsHostKey(pinned) === getUserInstructionsHostKey(active)) {
    return active;
  }
  return dirty ? pinned : active;
}

export function isUserInstructionsDraftDirty(
  loaded: UserInstructionsLoadedFile | null,
  draft: string,
): boolean {
  return loaded !== null && draft !== loaded.content;
}

export function canSaveUserInstructions(params: {
  loaded: UserInstructionsLoadedFile | null;
  draft: string;
  saving: boolean;
}): boolean {
  const { loaded, draft, saving } = params;
  if (!loaded || saving) return false;
  return isUserInstructionsDraftDirty(loaded, draft) || loaded.state === "missing";
}

export function countUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 估算草稿保存后的磁盘字节数：Agent 按原始字节截断 100 KiB，
 * 因此需要计入服务端还原的 CRLF（每个换行 +1）与 BOM（+3）。
 */
export function estimateUserInstructionsDiskBytes(params: {
  draft: string;
  eol: UserInstructionsLoadedFile["eol"];
  hasBom: boolean;
}): number {
  const { draft, eol, hasBom } = params;
  let bytes = countUtf8Bytes(draft);
  if (eol === "crlf") {
    for (let index = 0; index < draft.length; index += 1) {
      if (draft.charCodeAt(index) === 0x0a) bytes += 1;
    }
  }
  return hasBom ? bytes + 3 : bytes;
}

/** Claude 的 `@path` 导入行；ZCode 不展开它们。 */
export function hasClaudeAtImports(content: string): boolean {
  return /^[ \t]*@[^\s@]/m.test(content);
}

/** 旧版远端主机未注册该服务时，RPC 以 `Unknown channel` 超时失败。 */
export function isUnknownChannelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return (
    record.name === "Unknown channel" ||
    (typeof record.message === "string" && record.message.startsWith("Unknown channel"))
  );
}

export function formatUserInstructionsBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * 「在文件管理器中显示」传文件所在目录：非 macOS 上 openInFileManager 走 shell.openPath，
 * 传文件路径会直接用默认程序打开文件而不是定位它。链接时定位链接目标所在目录。
 */
export function getUserInstructionsRevealDirectory(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (index <= 0) return filePath.slice(0, index + 1) || filePath;
  // Windows 盘符根目录（C:\AGENTS.md）保留末尾分隔符。
  if (/^[A-Za-z]:$/.test(filePath.slice(0, index))) return filePath.slice(0, index + 1);
  return filePath.slice(0, index);
}
