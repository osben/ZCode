import { SessionEventType } from "@zcode/contracts";
import type { WorkspaceHookReviewFlow, WorkspaceHookReviewFlowRegistry } from "@zcode/core";
import type { WorkspaceHookReviewHostPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";

/**
 * Supervise a review flow until it terminates: follow the supersede chain and complete telemetry
 * and ReviewSettled on timeout.
 *
 * This is the **only** place that awaits flow.result. If nothing awaits it, the 10-minute deadline
 * silently settles it as timed_out in the registry. The frontend receives no ReviewSettled and keeps
 * rendering the panel as pending; every later click is rejected by registry.validate as
 * workspace_hooks_review_superseded (observed: nine consecutive rejected clicks, with no automatic reopen).
 *
 * Extracted for reuse by requestReview and the reopen path after revoke. Every flow-creation entry
 * point must pass through this supervisor or it can create another unattended orphan flow.
 */
export async function superviseWorkspaceHookReviewFlow(input: {
  flow: WorkspaceHookReviewFlow;
  host: WorkspaceHookReviewHostPort;
  registry: WorkspaceHookReviewFlowRegistry;
  sessionId: string;
  telemetry: WorkspaceHookReviewTelemetry;
}): Promise<void> {
  let flow = input.flow;
  while (true) {
    const outcome = await flow.result;
    if (outcome.reasonCode === "workspace_hooks_review_superseded") {
      const current = input.registry.getCurrentFlow(input.sessionId);
      if (!current || current === flow) return;
      flow = current;
      continue;
    }
    if (outcome.reasonCode === "workspace_hooks_interaction_timeout") {
      input.telemetry.timeout(flow.request);
      await input.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: flow.request.interactionId,
          state: "timed_out",
          reasonCode: outcome.reasonCode,
        },
      });
    }
    return;
  }
}
