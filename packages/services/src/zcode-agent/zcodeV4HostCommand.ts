// Shared utilities on the host (services layer) for building v4 command envelopes and handling ACK outcomes (send/interaction receipt convergence).
//
// Mirrors the renderer's packages/ui/src/v4/commandFactory.ts: the renderer persists clientId in browser
// localStorage; the host process uses a stable in-process clientId (a host restart is a new submitter,
// while the idempotency table remains keyed by commandId). They are not combined because services must not depend on the UI package.
import { randomBytes } from "node:crypto";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** UUID v7 (RFC 9562): 48-bit Unix millisecond timestamp + 74 random bits; matches the renderer factory. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable clientId for the host services process; pendingCommands display and the idempotency table use it to distinguish submitters. */
const hostV4ClientId = `host-services-${uuidv7()}`;

interface CreateHostCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** Null when calling createSession. */
  sessionId: string | null;
  /**
   * Idempotency key. Mobile replayable send_prompt uses inputId (=traceId) as commandId:
   * on the CLI side, sendText starts a turn with commandId as inputId, allowing the terminal event's inputId to be reconciled
   * with the host command queue's traceId (inputId→commandId alignment).
   * Defaults to a generated UUID v7 for one-shot commands such as stop/resolveInteraction.
   */
  commandId?: string;
  /** Mobile replayable preserves the original submitter clientId; defaults to the stable host process ID. */
  clientId?: string;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** Build a host-side command envelope; immediately throw if a CAS command lacks baseRevision. */
export function createHostCommandEnvelope<T extends CommandType>(
  input: CreateHostCommandEnvelopeInput<T>,
): CommandEnvelope {
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(`command ${input.type} 是 CAS 命令，必须携带 baseRevision`);
  }
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(`command ${input.type} 是 row target 命令，必须携带 baseLogEpoch`);
  }
  return {
    commandId: input.commandId ?? uuidv7(),
    clientId: input.clientId ?? hostV4ClientId,
    sessionId: input.sessionId,
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload: input.payload,
    issuedAt: Date.now(),
  };
}

/** A v4 command rejected by the server (rejected/stale/failed). Callers branch on code, not error text. */
class ZCodeV4CommandRejectedError extends Error {
  readonly code = "ZCODE_V4_COMMAND_REJECTED";

  constructor(
    readonly commandType: CommandType,
    readonly ack: CommandAck,
    contextMessage: string,
  ) {
    super(
      `v4 command ${commandType} ${ack.status}` +
        `${ack.reasonCode ? ` (${ack.reasonCode})` : ""}` +
        `${ack.message ? `: ${ack.message}` : ""} — ${contextMessage}`,
    );
    this.name = "ZCodeV4CommandRejectedError";
  }
}

/**
 * ACK error mapping (legacy op throw semantics → six v4 states):
 * - accepted: normal completion; duplicate: replay of a retry with the same commandId, treated as idempotent success;
 * - noop: late response/already completed, treated as idempotent success (resolveInteraction is first-wins);
 * - rejected/stale/failed: throw a structured error and pass reasonCode to the caller unchanged.
 */
export function assertV4CommandAckOk(
  commandType: CommandType,
  ack: CommandAck,
  contextMessage: string,
): CommandAck {
  if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
    return ack;
  }
  throw new ZCodeV4CommandRejectedError(commandType, ack, contextMessage);
}

/**
 * Host-side submission for CAS commands (configuration writes delegated): host services has no local v4 projection
 * and cannot read the current conversation revision. A stale ACK must include revisionAtDecision,
 * which is used to retry with the latest revision reported by the server, matching the renderer's dispatchConfigCas
 * (packages/ui/src/v4/SessionPane.tsx). Probe with baseRevision=0 on the first attempt; the typical path succeeds after one
 * stale response. Use a new commandId for each attempt (stale decisions are not entered in the idempotency table, so this preserves equivalent semantics without ambiguity).
 * The old facade never supplied expectedRevision (no CAS), so stale here means concurrent progress rather than conflict;
 * retrying preserves the no-CAS submission semantics. Exhausting retries occurs only under pathological concurrency and is thrown as a rejection.
 */
export async function sendHostCasCommandV4<T extends CommandType>(input: {
  send: (envelope: CommandEnvelope) => Promise<CommandAck>;
  type: T;
  payload: CommandPayloadMap[T];
  sessionId: string;
  contextMessage: string;
  maxAttempts?: number;
}): Promise<CommandAck> {
  const maxAttempts = input.maxAttempts ?? 4;
  let baseRevision = 0;
  let lastAck: CommandAck | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ack = await input.send(
      createHostCommandEnvelope({
        type: input.type,
        payload: input.payload,
        sessionId: input.sessionId,
        baseRevision,
      }),
    );
    if (ack.status === "stale") {
      lastAck = ack;
      baseRevision = ack.revisionAtDecision;
      continue;
    }
    return assertV4CommandAckOk(input.type, ack, input.contextMessage);
  }
  throw new ZCodeV4CommandRejectedError(
    input.type,
    lastAck ?? {
      commandId: "",
      status: "stale",
      revisionAtDecision: baseRevision,
    },
    `${input.contextMessage}（连续 stale，放弃重试）`,
  );
}
