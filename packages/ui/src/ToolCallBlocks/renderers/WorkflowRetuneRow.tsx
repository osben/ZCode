// ============================================================
// The transcript row for an in-place revision.
// ============================================================
// When only the concurrency limit changes while a run is active, `AmendWorkflow` does not compile or create a new run; it only changes that run's limit. Therefore
// this row has no card to render: the run's card is in the turn that started it, and drawing another would look like a second run; the original static card
// shows compile validation, making a concurrency change look like the workflow was recompiled and started.
//
// Render the same settings row left by GUI “Configure” (`WorkflowSettingsChangeRow`) verbatim — the same action should read the same regardless of who
// initiated it. The only difference is that this row is **clickable**: it is where the model's tool step lands, and users can return to that run from here.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";

/**
 * The value in the input → metadata in the settings turn. These are two representations of the same thing (GUI uses turn metadata; tools use
 * input), so mapping both to one shape leaves a single implementation for the wording.
 *
 * `requested` is the **unclamped value sent by the model** (`readWorkflowRetuneCall`), while the CLI clamps it to
 * `[1, ceiling]`. Pass the ceiling to the wording logic too: `workflowSettingsChangeSegments` treats `to >= ceiling` and missing `to` identically,
 * both reading “limit restored to the local default” — the truth after clamping
 * (clamping to the ceiling means this run has no custom limit). Thus the row never shows a number above the local maximum.
 * If the ceiling is unknown (the run has left the projection or an older CLI did not send it), the requested value is all we can show; it can only be
 * too high, not too low — and “up to n” is an upper bound, so it does not mislead users into thinking more ran than actually did.
 *
 * Leave `from` unset: the input does not know the previous value, and this row's wording reads only `to`. Leave `predecessorRunId` unset too —
 * an in-place change has no predecessor (workflow-row-meta.ts).
 */
function retuneAsAmendMeta(
  requested: number | null,
  ceiling: number | undefined,
): WorkflowSettingsAmendMeta {
  return {
    maxConcurrency: requested === null ? {} : { to: requested },
    ...(ceiling === undefined ? {} : { ceiling }),
  };
}

export function WorkflowRetuneRow({
  ceiling,
  onOpen,
  requested,
  runId,
}: {
  /** Local concurrency ceiling (from that run's projection); omitted when unknown. */
  ceiling?: number;
  /** Open this run's detail page; if the host does not provide this (read-only display or feature disabled), this row is only a record. */
  onOpen?: () => void;
  requested: number | null;
  runId: string;
}) {
  const row = <WorkflowSettingsChangeRow amend={retuneAsAmendMeta(requested, ceiling)} />;
  if (onOpen === undefined) {
    return (
      <div data-testid="workflow-retune-row" data-workflow-retune-run-id={runId}>
        {row}
      </div>
    );
  }
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer rounded-md px-1 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid="workflow-retune-row"
      data-workflow-retune-run-id={runId}
      onClick={onOpen}
      type="button"
    >
      {row}
    </button>
  );
}
