import type { RemoteTarget } from "@zcode/shared";
import type { UserInstructionsReadResult } from "@zcode/services";

export type UserInstructionsLoadedFile = Extract<UserInstructionsReadResult, { kind: "ok" }>;

/** Target-host description for the instructions editor; corresponds one-to-one with useWorkspaceServicesResolution inputs. */
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
 * Target-host key: `local` or `remote:<identity || path>`.
 * remoteSessionId represents one connection only; reconnecting to the same remote must not count as switching hosts.
 */
export function getUserInstructionsHostKey(target: UserInstructionsHostTarget): string {
  if (!target.workspacePath || !isRemoteUserInstructionsTarget(target)) {
    return LOCAL_USER_INSTRUCTIONS_HOST_KEY;
  }
  return `remote:${target.workspaceIdentity?.trim() || target.workspacePath}`;
}

/**
 * Resolve the Host the editor is actually bound to.
 * If there is an unsaved draft, switching the active workspace to another Host must not “carry” the draft over and write the wrong file,
 * so keep it bound to the old Host until the user saves or explicitly discards it; on the same Host, update only connection metadata.
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

// Show waiting when a remote connection disconnects even if the file was already loaded: the draft remains in hook state,
// and reconnecting restores ready without reloading. This prevents saving/importing through an invalid proxy while disconnected.
export function resolveUserInstructionsEditorStatus<TStatus extends string>(params: {
  status: TStatus;
  rpcReady: boolean;
}): TStatus | "waiting" {
  return params.rpcReady ? params.status : "waiting";
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
 * Estimate bytes on disk after saving the draft: Agent truncates at 100 KiB of original bytes,
 * so include server-restored CRLF (+1 per newline) and BOM (+3).
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

/** Claude `@path` import lines; ZCode does not expand them. */
export function hasClaudeAtImports(content: string): boolean {
  return /^[ \t]*@[^\s@]/m.test(content);
}

/** When an older remote Host has not registered this service, the RPC times out with `Unknown channel`. */
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
 * “Show in file manager” for the directory containing the file: on non-macOS, openInFileManager uses shell.openPath,
 * and passing a file path opens it with the default app instead of revealing it. For links, reveal the directory containing the link target.
 */
export function getUserInstructionsRevealDirectory(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (index <= 0) return filePath.slice(0, index + 1) || filePath;
  // Preserve the trailing separator for Windows drive roots (C:\AGENTS.md).
  if (/^[A-Za-z]:$/.test(filePath.slice(0, index))) return filePath.slice(0, index + 1);
  return filePath.slice(0, index);
}
