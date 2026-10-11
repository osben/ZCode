// Orchestration for direct launch from the hub.
// Do not synthesize conversation copy: create an empty session in the target project → send it a startSavedWorkflow command →
// if accepted, navigate to the new session (the launch card is already at the top); if rejected or an error is thrown, delete the empty session and return the error to the caller
// (inline in the arguments dialog / toast), leaving the user in the hub. "Failure before session exists" (invariant 2): if createSession
// is rejected, do not send start or keep a session; if start is rejected, immediately call deleteSession to remove the empty session just created.
import { useCallback, useRef, useState } from "react";
import {
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  savedWorkflowStartRejectionReasonSchema,
  type CommandAck,
  type SavedWorkflowStartRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
} from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";

/** Target project coordinates (the workflow's project; never use the active project; invariant 7); remoteSessionId determines the connection endpoint. */
export interface SavedWorkflowLaunchTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/** Launch request: name is guaranteed by parsing (invariant 6), scope selects the target, and args have been collected by the arguments dialog. */
interface SavedWorkflowLaunchRequest {
  name: string;
  scope: "project" | "global";
  args: Record<string, unknown>;
}

/** Error reason = rejection vocabulary ∪ missing capability ∪ fallback; map directly to the i18n key `workflows.hub.launch.error.<reason>`. */
export type SavedWorkflowLaunchErrorReason =
  | SavedWorkflowStartRejectionReason
  | "unsupported"
  | "generic";

export interface SavedWorkflowLaunchError {
  reason: SavedWorkflowLaunchErrorReason;
  /** Raw fault code / ACK status; for logging and troubleshooting only, not displayed directly. */
  code: string;
  /** Human-readable server reason (already length-limited after compiler diagnostics are combined); displayed in an inline mono block when present. */
  message?: string;
}

type SavedWorkflowLaunchResult =
  | { ok: true; sessionId: string; runId: string; toolCallId: string }
  | { ok: false; error: SavedWorkflowLaunchError };

interface UseSavedWorkflowLauncherResult {
  launch: (
    target: SavedWorkflowLaunchTarget,
    request: SavedWorkflowLaunchRequest,
  ) => Promise<SavedWorkflowLaunchResult>;
  /** Launch in progress: show loading and disable the arguments dialog primary button to prevent duplicate clicks. */
  pending: boolean;
  /** Most recent launch failure (cleared on success or before a new launch). */
  error: SavedWorkflowLaunchError | null;
  clearError: () => void;
}

// Fault code returned by the v4 handler when the capability is missing (no dwf port) (interaction-background.ts).
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";

/** workspaceId for createSession follows the same convention as conversation connections: prefer identity, otherwise use the path. */
export function launchWorkspaceId(target: SavedWorkflowLaunchTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

/** Resolve the connection lease for the target project (remoteSessionId determines the endpoint). Shared by the direct launcher and "promote to global" (useSavedWorkflowPromote): both create a session in the target project, but send different first commands. */
export function acquireLaunchLease(
  target: SavedWorkflowLaunchTarget,
  agentService: WorkspaceConnectionAgentService,
) {
  return acquireWorkspaceConnection(
    {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    },
    agentService,
  );
}

/** Map a rejected ACK to a structured error: missing capability → unsupported; rejection vocabulary → matching reason; otherwise → generic. */
function mapLaunchError(ack: CommandAck): SavedWorkflowLaunchError {
  const code = ack.reasonCode ?? ack.status;
  const message = ack.message;
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) {
    return { reason: "unsupported", code, ...(message ? { message } : {}) };
  }
  if (ack.reasonCode?.startsWith(SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX)) {
    const suffix = ack.reasonCode.slice(SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX.length);
    const parsed = savedWorkflowStartRejectionReasonSchema.safeParse(suffix);
    if (parsed.success) return { reason: parsed.data, code, ...(message ? { message } : {}) };
  }
  // Unknown faults and codes outside the rejection vocabulary (including new codes seen by old clients) are shown as generic errors.
  return { reason: "generic", code, ...(message ? { message } : {}) };
}

/** Hub launcher hook. The caller resolves the `agentService` (project group = service resolved for the target project; global group = local base service, with the target set to the selected local project). `onNavigate` switches to the new session after acceptance (mirrors `handleSelectTaskInChat`, including `showChatMainView`). */
export function useSavedWorkflowLauncher(params: {
  agentService: WorkspaceConnectionAgentService;
  onNavigate?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}): UseSavedWorkflowLauncherResult {
  const { agentService, onNavigate } = params;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SavedWorkflowLaunchError | null>(null);
  // Synchronous source of truth for pending state: prevents duplicate triggers in the same frame (setPending is async, so state alone is insufficient).
  const pendingRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const launch = useCallback(
    async (
      target: SavedWorkflowLaunchTarget,
      request: SavedWorkflowLaunchRequest,
    ): Promise<SavedWorkflowLaunchResult> => {
      if (pendingRef.current) {
        return { ok: false, error: { reason: "generic", code: "launch_in_flight" } };
      }
      pendingRef.current = true;
      setPending(true);
      setError(null);

      const workspaceId = launchWorkspaceId(target);
      const lease = acquireLaunchLease(target, agentService);

      const deleteCreatedSession = (sessionId: string) => {
        void lease.transport
          .sendCommand(createCommandEnvelope({ type: "deleteSession", payload: {}, sessionId }))
          .then((ack) => {
            if (ack.status !== "accepted" && ack.status !== "noop") {
              logger.warn("[saved-workflow-launch] 回收空会话被拒", {
                sessionId,
                status: ack.status,
                reasonCode: ack.reasonCode ?? null,
              });
            }
          })
          .catch(() => {
            // Cleanup failure is harmless: the in-memory session disappears when the CLI exits and never appears in the transcript (it has no rows).
          });
      };

      let createdSessionId: string | null = null;
      try {
        // 1. Empty session: no firstInput or config; use the runtime default model/mode (do not reuse composer draft configuration).
        const createAck = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: { workspaceId },
            sessionId: null,
          }),
        );
        if (createAck.status !== "accepted" || createAck.result?.type !== "createSession") {
          // Session was not created: do not send start or keep a session; return a generic error.
          logger.warn("[saved-workflow-launch] createSession 被拒", {
            workspaceId,
            status: createAck.status,
            reasonCode: createAck.reasonCode ?? null,
          });
          const err: SavedWorkflowLaunchError = {
            reason: "generic",
            code: createAck.reasonCode ?? createAck.status,
            ...(createAck.message ? { message: createAck.message } : {}),
          };
          setError(err);
          return { ok: false, error: err };
        }
        createdSessionId = createAck.result.sessionId;

        // 2. startSavedWorkflow: look up by name/scope and pass arguments; omit the args key when there are no arguments.
        const startAck = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "startSavedWorkflow",
            payload: {
              name: request.name,
              scope: request.scope,
              ...(Object.keys(request.args).length > 0 ? { args: request.args } : {}),
            },
            sessionId: createdSessionId,
          }),
        );
        if (startAck.status === "accepted" && startAck.result?.type === "startSavedWorkflow") {
          // Accepted: the launch card is already at the top of the new session; switch to it to bring it to life (start silently without navigating if no navigation handler is available).
          onNavigate?.(target, createdSessionId);
          return {
            ok: true,
            sessionId: createdSessionId,
            runId: startAck.result.runId,
            toolCallId: startAck.result.toolCallId,
          };
        }
        // Launch rejected or failed: remove the empty session just created (invariant 2) and return the reason to the arguments dialog / toast.
        deleteCreatedSession(createdSessionId);
        const err = mapLaunchError(startAck);
        setError(err);
        return { ok: false, error: err };
      } catch (thrown) {
        if (createdSessionId) deleteCreatedSession(createdSessionId);
        const err: SavedWorkflowLaunchError = {
          reason: "generic",
          code: "exception",
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
        setError(err);
        return { ok: false, error: err };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [agentService, onNavigate],
  );

  return { launch, pending, error, clearError };
}
