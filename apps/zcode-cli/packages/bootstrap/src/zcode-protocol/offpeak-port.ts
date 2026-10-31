import type { OffPeakPort, OffPeakTaskSummary } from "@zcode/contracts";
import {
  zcodeOffPeakCreateResultSchema,
  zcodeOffPeakListResultSchema,
  zcodeProtocolMethods,
  type ZCodeOffPeakTaskProtocolSnapshot,
} from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export const OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR =
  "Cannot create an idle-time task while running an idle-time task.";
export const OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR =
  "This session already has a pending idle-time task. Wait for it to finish (or cancel it in Automations) before creating another one here.";
export const OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR =
  "Cannot verify whether this session already has a pending idle-time task; try again later.";

const OFF_PEAK_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Off-Peak protocol port. Differences from automation-port:
 * - Prevent only recursive creation within an off-peak cycle (`activeOffPeakTaskId`); do not check
 *   activeAutomationId, so cron cycles can use OffPeakCreate to schedule off-peak tasks.
 * - Creation within a session binds to the current session (matching CronCreate targetTaskId), and
 *   dispatch resumes execution in that session. The binding guard rejects only when that session
 *   already has a non-terminal off-peak task (two unattended prompts competing for one session).
 *   Another task can be created after termination, unlike cron's permanent one-task-per-session
 *   rejection. Reuse the minimal offPeak/list snapshot (sessionId/status) for this check and fail
 *   closed on query errors. The server's ticket quota (POST /ticket 3103) remains the authoritative
 *   amplification defense.
 * - Do not inject runtimeModel/mode/thoughtLevel: the host resolves defaults (yolo / last allowed_models
 *   entry / highest reasoning tier); session runtime state is unrelated to the off-peak allowlist.
 * - Do not freeze the session title: this is the user's work session, and tasks should not rewrite its title.
 */
export function createProtocolOffPeakPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession?: () => ZCodeProtocolSessionRecord | undefined,
): OffPeakPort {
  // Shared connections must not fall back to the first workspace; list requests with only an automationId or empty params included.
  const requestClient: typeof context.requestClient = (...args) => {
    if (!context.sessionWorkspaceRoutingEnabled) return context.requestClient(...args);
    const workspace = resolveOwnSession?.()?.workspace;
    if (!workspace) throw new Error("Session workspace is unavailable");
    const [method, params, schema, ...options] = args;
    return context.requestClient(method, { ...(params as object), workspace }, schema, ...options);
  };
  return {
    async create(input, createContext) {
      const activeSession =
        resolveOwnSession?.() ??
        (createContext?.sessionId ? context.sessions.get(createContext.sessionId) : undefined);
      if (activeSession?.activeOffPeakTaskId?.trim()) {
        // This turn was dispatched by an off-peak task; creating another off-peak task from within
        // that cycle is recursive self-generation, so reject it. This is a third defense in depth
        // alongside the turn denylist and handler offPeakTurn.
        throw new Error(OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR);
      }
      const boundSessionId = createContext?.sessionId ?? activeSession?.app.sessionId;
      if (boundSessionId) {
        let bound: boolean;
        try {
          const listed = await requestClient(
            zcodeProtocolMethods.offPeakList,
            {},
            zcodeOffPeakListResultSchema,
          );
          bound = listed.tasks.some(
            (task) =>
              task.sessionId === boundSessionId && !OFF_PEAK_TERMINAL_STATUSES.has(task.status),
          );
        } catch (error) {
          context.logger?.warn("Failed to check bound idle-time tasks before OffPeakCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "offpeak.create.bound_session_check.failed",
            sessionId: boundSessionId,
          });
          // Unknown must not mean unbound: a temporary host/database failure must not re-enable
          // two tasks in the same session.
          throw new Error(OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR);
        }
        if (bound) throw new Error(OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR);
      }
      const result = await requestClient(
        zcodeProtocolMethods.offPeakCreate,
        {
          title: input.title,
          prompt: input.prompt,
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
          // Bind the current session; the host still injects the workspace from that session
          // (parallel to automation/create).
          ...(boundSessionId ? { boundSessionId } : {}),
        },
        zcodeOffPeakCreateResultSchema,
      );
      if (!result.ok) {
        // Pass failure classification through unchanged for the handler to translate; do not
        // downgrade it to a message string at the port layer.
        return {
          ok: false,
          failureStage: result.failureStage,
          errorCategory: result.errorCategory,
          errorCode: result.errorCode,
        };
      }
      return { ok: true, task: toOffPeakTaskSummary(result.task) };
    },
    async list() {
      const result = await requestClient(
        zcodeProtocolMethods.offPeakList,
        {},
        zcodeOffPeakListResultSchema,
      );
      return result.tasks.map(toOffPeakTaskSummary);
    },
  };
}

function toOffPeakTaskSummary(input: ZCodeOffPeakTaskProtocolSnapshot): OffPeakTaskSummary {
  return {
    offPeakTaskId: input.offPeakTaskId,
    title: input.title,
    status: input.status,
    queuePosition: input.queuePosition,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
  };
}
