import type { ConversationRow, WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";

/**
 * Provenance for a directly launched run: its scope, description, arguments, and the time
 * “you launched it from the workflow hub.” Only runs launched from the hub have this data—it is attached to the launching turn's turnHeader / userInput row
 * as `workflowLaunch` metadata (with the same toolCallId). Runs launched through a tool path have no such entry in the row window, so this returns
 * undefined and the side pane omits this section. Prefer turnHeader (the live projection is authoritative; `startedAt` is the launch time), falling back to the same data on the user-visible row (cold-recovery hydration also writes it to the userInput row).
 */
interface WorkflowLaunchProvenance {
  meta: WorkflowLaunchMeta;
  startedAt?: number;
}

export function resolveWorkflowLaunchProvenance(
  rows: readonly ConversationRow[] | undefined,
  toolCallId: string,
): WorkflowLaunchProvenance | undefined {
  let fallback: WorkflowLaunchProvenance | undefined;
  for (const row of rows ?? []) {
    if (row.kind === "turnHeader" && row.workflowLaunch?.toolCallId === toolCallId) {
      return { meta: row.workflowLaunch, startedAt: row.startedAt };
    }
    if (
      fallback === undefined &&
      row.kind === "userInput" &&
      row.workflowLaunch?.toolCallId === toolCallId
    ) {
      fallback = { meta: row.workflowLaunch, startedAt: row.createdAt };
    }
  }
  return fallback;
}
