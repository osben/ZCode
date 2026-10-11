import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * “Showing details for {shown}/{total} steps” (docs/dynamic-workflow/presentation.md, “The run card”
 * and “The run pane”): when a run exceeds `WORKFLOW_RUNS_LIMITS.maxNodes`, the instance table stops at the limit, while
 * the counts above (steps, settled) already include items outside the table. This row states that difference: **the run is not truncated;
 * details for individual steps are**.
 *
 * The card and details page share this implementation; a run must use the same wording on both surfaces.
 *
 * Show only when actual instances are omitted. `truncated` is also set when smaller tables such as reports/artifacts/phases hit their limits
 * (workflow-runs.ts); in those cases no steps are missing, and saying "Showing 40/40 steps" would be pointless.
 */
export function WorkflowTruncatedNotice({
  className,
  run,
  testId,
}: {
  className?: string;
  /** This run from the live projection; absent means it was evicted from the projection and there is nothing to report. */
  run: WorkflowRunState | undefined;
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  if (run?.truncated !== true) return null;
  const shown = run.nodes.length;
  const { total } = workflowRunStepCounts(run);
  if (shown >= total) return null;
  return (
    <p
      className={cn("min-w-0 text-ui-xs text-foreground-subtlest", className)}
      data-testid={testId}
    >
      {/* Do not add thousands separators to either number: the adjacent summary segment (`{done}/{total} steps`) also uses plain numbers,
          and “2,001” beside “2001” is more distracting than the missing separator. */}
      {intl.formatMessage({ id: "chat.toolCall.workflow.run.truncated" }, { shown, total })}
    </p>
  );
}
