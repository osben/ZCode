// Bridge session events to the workflowRuns mirror (the DWF case in app-events.ts calls only this function).
//
// There are two reasons for a separate module: keep the contracts payload type here so app-workflow-mirror.ts
// continues to depend only on @zcode/shared (the same rule that keeps the shared reducer from depending back on contracts);
// this also keeps app-events.ts's switch within max-lines.
import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { applyWorkflowProgressToMirror, type TuiWorkflowMirror } from "./app-workflow-mirror.js";

export type WorkflowMirrorSetter = (
  updater: (current: TuiWorkflowMirror) => TuiWorkflowMirror,
) => void;

/**
 * Reduce one `dynamic_workflow_run_progress` event into the mirror.
 *
 * The projection-side counterpart is bootstrap's `onDynamicWorkflowRunProgress`; both call the **same** shared reducer,
 * so the TUI and Desktop cannot calculate different states for the same event stream.
 */
export function applyWorkflowProgressEvent(
  payload: unknown,
  setWorkflowMirror?: WorkflowMirrorSetter,
): void {
  if (!setWorkflowMirror) return;
  // Convert the bounded contracts payload before assigning it to the shared structured input. This assignment is a compile-time guard
  // against the two shapes drifting (matching the bootstrap v4 projection pattern).
  const envelope: WorkflowRunProgressEnvelope = payload as DynamicWorkflowRunProgressPayload;
  // When unchanged, applyWorkflowProgressToMirror returns the same reference, so React skips rerendering:
  // the shared reducer's "null = no semantic change" means "do not redraw" on the UI side.
  setWorkflowMirror((current) => applyWorkflowProgressToMirror(current, envelope));
}
