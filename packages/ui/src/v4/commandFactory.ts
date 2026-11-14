// Command envelope factory.
// commandId = uuid v7 (time-ordered, unchanged on retry); clientId is stable and persisted per client instance,
// and the server idempotency table and pendingCommands display both use it to distinguish submitters.
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";
import { uuidv7 } from "@zcode/shared";
export { uuidv7 } from "@zcode/shared";

const CLIENT_ID_STORAGE_KEY = "zcode-v4-client-id:v1";
let cachedClientId: string | null = null;

/**
 * Stable clientId for this client instance. Prefer localStorage persistence (unchanged after refresh,
 * so the idempotency table can still recognize retries across refreshes); without storage, fall back to process-local stability.
 */
export function getV4ClientId(): string {
  if (cachedClientId) return cachedClientId;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  } catch {
    // Incognito / Node test environments have no localStorage; fall back to an in-memory cache.
  }
  const clientId = stored ?? `client-${uuidv7()}`;
  if (!stored) {
    try {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    } catch {
      // Same as above; ignore.
    }
  }
  cachedClientId = clientId;
  return clientId;
}

const EDITOR_ID_STORAGE_KEY = "zcode-v4-editor-id:v1";
let cachedEditorId: string | null = null;

/**
 * 本窗口（Web 每个标签页）的编辑器实例 id，作为队列编辑锁的归属
 * （docs/ui/composer-edit-mode.md）。sessionStorage 让刷新后不变、不同窗口不同；
 * clientId 存在 localStorage，同设备多窗口共享，不能单独区分锁的持有者。
 */
export function getV4EditorId(): string {
  if (cachedEditorId) return cachedEditorId;
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(EDITOR_ID_STORAGE_KEY);
  } catch {
    // 无 sessionStorage 环境退化为进程内稳定
  }
  const editorId = stored ?? `editor-${uuidv7()}`;
  if (!stored) {
    try {
      sessionStorage.setItem(EDITOR_ID_STORAGE_KEY, editorId);
    } catch {
      // 同上，忽略
    }
  }
  cachedEditorId = editorId;
  return editorId;
}

/** 当前 id 已被另一个在线页面占用（复制标签页）时换新 id，并写回 sessionStorage 供刷新沿用。 */
export function regenerateV4EditorId(): string {
  const editorId = `editor-${uuidv7()}`;
  try {
    sessionStorage.setItem(EDITOR_ID_STORAGE_KEY, editorId);
  } catch {
    // 无 sessionStorage 环境只在进程内生效
  }
  cachedEditorId = editorId;
  return editorId;
}

export interface CreateCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** null when using createSession. */
  sessionId: string | null;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** Build a command envelope; throw if a CAS command lacks baseRevision (surface client programming errors immediately). */
export function createCommandEnvelope<T extends CommandType>(
  input: CreateCommandEnvelopeInput<T>,
): CommandEnvelope {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(
      `command ${input.type} 是 CAS 命令，必须携带 baseRevision（10-protocol-spec §6.4）`,
    );
  }
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(`command ${input.type} 是 row target 命令，必须携带 baseLogEpoch`);
  }
  // Session ID resumes as UUID v4; assign it when the envelope is first constructed so retries do not regenerate it and reserve another task.
  const payload =
    input.type === "createSession"
      ? {
          ...input.payload,
          sessionId:
            (input.payload as CommandPayloadMap["createSession"]).sessionId ??
            `sess_${crypto.randomUUID()}`,
        }
      : input.payload;
  return {
    commandId: uuidv7(),
    clientId: getV4ClientId(),
    sessionId: input.sessionId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload,
    issuedAt: Date.now(),
  };
}
