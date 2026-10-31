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
