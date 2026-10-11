// Native v4 command executor.
//
// Incremental command-native migration: the handlers/ registry lists native commands. The binder
// uses this executor only when supports matches; otherwise it falls back to the legacy bridge (the
// binder owns the fallback, which disappears command by command as each is migrated).
// Completion criteria: native handler + L2 closed loop + L3 e2e, with writes bypassing legacy protocol code.
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import { NATIVE_HANDLERS } from "./handlers/index.js";
import type { V4CommandCoreHost } from "./types.js";

const SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS = new Set<CommandEnvelope["type"]>([
  "sendGoalCommand",
  "pauseGoal",
  "resumeGoal",
  "editUserQuery",
  "retryTurn",
  "forkAssistant",
  "discardSharedContext",
]);

export class V4SelectionSideChatRestrictedCommandError extends Error {
  readonly reasonCode = "guard.selectionSideChatRestrictedCommand";

  constructor(command: CommandEnvelope["type"]) {
    super(`selection_side_chat 不允许执行 ${command}`);
    this.name = "V4SelectionSideChatRestrictedCommandError";
  }
}

export { V4SessionNotFoundError } from "./record-access.js";

export class V4CommandExecutor {
  constructor(private readonly host: V4CommandCoreHost) {}

  /** Commands already handled natively; the binder routes these, and the legacy bridge is removed once all commands are covered. */
  supports(type: CommandEnvelope["type"]): boolean {
    return type in NATIVE_HANDLERS;
  }

  async execute(
    envelope: CommandEnvelope,
    admission?: V4CommandAdmission,
    executionContext?: V4CommandExecutionContext,
  ): Promise<CommandResult | undefined> {
    if (
      envelope.sessionId &&
      SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS.has(envelope.type) &&
      this.host.getRecord(envelope.sessionId)?.taskType === "selection_side_chat"
    ) {
      throw new V4SelectionSideChatRestrictedCommandError(envelope.type);
    }
    const handler = NATIVE_HANDLERS[envelope.type as keyof typeof NATIVE_HANDLERS];
    if (!handler) {
      throw new Error(`v4 native executor does not support: ${envelope.type}`);
    }
    return handler(this.host, {
      ...envelope,
      ...(admission ? { __v4Admission: admission } : {}),
      ...(executionContext ? { __v4ExecutionContext: executionContext } : {}),
    });
  }
}

export interface V4CommandAdmission {
  admissionSeq: number;
  admittedAt: number;
  queueItemId: string;
}

export interface V4CommandExecutionContext {
  /** Internal auto-drain must have the handler atomically verify that Core is idle before reserve. */
  autoDrainPromotion?: true;
}

export type V4AdmittedCommandEnvelope = CommandEnvelope & {
  __v4Admission?: V4CommandAdmission;
  __v4ExecutionContext?: V4CommandExecutionContext;
};

export function commandAdmissionOf(envelope: CommandEnvelope): V4CommandAdmission {
  return (
    (envelope as V4AdmittedCommandEnvelope).__v4Admission ?? {
      admissionSeq: 0,
      admittedAt: Date.now(),
      queueItemId: `queue_${envelope.commandId}`,
    }
  );
}

export function commandExecutionContextOf(
  envelope: CommandEnvelope,
): V4CommandExecutionContext | undefined {
  return (envelope as V4AdmittedCommandEnvelope).__v4ExecutionContext;
}
