// Orchestrate the “Promote globally” action.
//
// Project-to-global promotion does not move a file: project workflows often refer to this repository's paths / commands / conventions, and copying them byte for byte would create
// a global definition that is guaranteed to fail in other projects. This action asks the model to **summarize**: the GUI creates a new session in the project, and the first user
// message is the summary prompt (`createSession.firstInput`, sent automatically); the model reads the file, extracts parameters, and saves a separate copy through SaveWorkflow
// (`scope: "global"`). The source file remains unchanged and the confirmation dialog still applies.
//
// Why not use `onCreateViaChat` for “revise / create via conversation”: that path only prefills a composer draft without sending,
// but this is an action the user already initiated and should not require another Send click. Why not use the direct launcher: it sends
// the startSavedWorkflow command (runs a workflow), while this action sends an ordinary user message. A create request with firstInput
// is either accepted as a whole or rejected; there is no intermediate “session created, message not sent” state, so no cleanup is needed.
import { useCallback, useRef, useState } from "react";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { WorkspaceConnectionAgentService } from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";
import { buildSavedWorkflowPromotePrompt } from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  acquireLaunchLease,
  launchWorkspaceId,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

/** Project workflow being promoted: include its name and path in the prompt (the model reads the file itself), and select copy based on locale. */
interface SavedWorkflowPromoteRequest {
  name: string;
  path: string;
  locale: string;
}

type SavedWorkflowPromoteResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      /** Raw fault code / ACK status, used by logs and fallback toast copy. */
      code: string;
      /** Human-readable reason from the server (shown first when available). */
      message?: string;
    };

interface UseSavedWorkflowPromoteResult {
  promote: (
    target: SavedWorkflowLaunchTarget,
    request: SavedWorkflowPromoteRequest,
  ) => Promise<SavedWorkflowPromoteResult>;
  /** Currently launching: disable the card / details menu to prevent duplicate clicks. */
  pending: boolean;
}

/**
 * Carrier `agentService` = the agent service resolved for this project (already available in the project group); `onNavigate` switches to the new session after accepted
 * (shared with direct launch via `onNavigateToLaunchedRun`). Use runtime defaults for model / mode rather than reusing composer
 * draft configuration — the same choice as direct launch.
 */
export function useSavedWorkflowPromote(params: {
  agentService: WorkspaceConnectionAgentService;
  onNavigate?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}): UseSavedWorkflowPromoteResult {
  const { agentService, onNavigate } = params;
  const [pending, setPending] = useState(false);
  // Synchronous source of truth to prevent re-entry within one frame (setPending is asynchronous, so state alone cannot block double clicks).
  const pendingRef = useRef(false);

  const promote = useCallback(
    async (
      target: SavedWorkflowLaunchTarget,
      request: SavedWorkflowPromoteRequest,
    ): Promise<SavedWorkflowPromoteResult> => {
      if (pendingRef.current) {
        return { ok: false, code: "promote_in_flight" };
      }
      pendingRef.current = true;
      setPending(true);
      const lease = acquireLaunchLease(target, agentService);
      try {
        const ack = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: {
              workspaceId: launchWorkspaceId(target),
              firstInput: { text: buildSavedWorkflowPromotePrompt(request) },
            },
            sessionId: null,
          }),
        );
        if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
          logger.warn("[saved-workflow-promote] createSession(firstInput) 被拒", {
            workspacePath: target.workspacePath,
            name: request.name,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
          return {
            ok: false,
            code: ack.reasonCode ?? ack.status,
            ...(ack.message ? { message: ack.message } : {}),
          };
        }
        onNavigate?.(target, ack.result.sessionId);
        return { ok: true, sessionId: ack.result.sessionId };
      } catch (thrown) {
        return {
          ok: false,
          code: "exception",
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [agentService, onNavigate],
  );

  return { promote, pending };
}
