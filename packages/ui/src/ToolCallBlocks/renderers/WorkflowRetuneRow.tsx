// ============================================================
// The transcript row for an in-place revision.（docs/dynamic-workflow/concurrency.md）
// ============================================================
// When only the concurrency limit changes while a run is active, `AmendWorkflow` does not compile or create a new run; it only changes that run's limit. Therefore
// this row has no card to render: the run's card is in the turn that started it, and drawing another would look like a second run; the original static card
// This would display “Validated · Adjusted run X · Script unchanged,” although none of those three things happened.
//
// Render the same settings row left by GUI “Configure” (`WorkflowSettingsChangeRow`) verbatim — the same action should read the same regardless of who
// initiated it. The only difference is that this row is **clickable**: it is where the model's tool step lands, and users can return to that run from here.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";

/**
 * The value in the input → metadata in the settings turn. These are two representations of the same thing (GUI uses turn metadata; tools use
 * input), so mapping both to one shape leaves a single implementation for the wording.
 *
 * `requested` is the **model-emitted** number (`readWorkflowRetuneCall`). It has no upper limit:
 * default concurrency D is a starting point, not a ceiling, and values above D are effective. Pass
 * D here too (the metadata key `ceiling` predates the default-concurrency concept) so the wording
 * rule can handle it: `workflowSettingsChangeSegments` treats `to === D` and missing `to` alike,
 * saying “restore the ceiling to default” (equal to default means this run has no custom ceiling),
 * and reports other values as-is. If D is unknown (the run was removed from the projection or an
 * older CLI never sent it), report only the requested value.
 *
 * Leave `from` unset: the input does not know the previous value, and this row's wording reads only `to`. Leave `predecessorRunId` unset too —
 * an in-place change has no predecessor (workflow-row-meta.ts).
 */
function retuneAsAmendMeta(
  requested: number | null,
  defaultConcurrency: number | undefined,
): WorkflowSettingsAmendMeta {
  return {
    maxConcurrency: requested === null ? {} : { to: requested },
    ...(defaultConcurrency === undefined ? {} : { ceiling: defaultConcurrency }),
  };
}

export function WorkflowRetuneRow({
  defaultConcurrency,
  onOpen,
  requested,
  runId,
}: {
  /** Default concurrency D (from the run projection's `run.concurrencyCeiling`); absent when unknown. */
  defaultConcurrency?: number;
  /** Open this run's details page; if the host omits this (read-only surface or rollout disabled), this row is informational only. */
  onOpen?: () => void;
  requested: number | null;
  runId: string;
}) {
  const row = (
    <WorkflowSettingsChangeRow amend={retuneAsAmendMeta(requested, defaultConcurrency)} />
  );
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
