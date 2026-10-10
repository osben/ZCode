import { CheckIcon, Loader2 } from "lucide-react";
import type { CodingPlanResetType } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanQuotaResetUiStatus } from "@/lib/codingPlanQuotaResetUi.js";

/**
 * Automatic reset hint content (presentation only), used by the controlled tooltip on the composer quota entry:
 * - processing: spinner + “Resetting 5-hour/weekly quota…”
 * - completed: green checkmark + “5-hour/weekly quota reset”
 * Includes role="status" so screen readers announce state changes.
 */
export function CodingPlanQuotaResetStatusContent({
  status,
  resetType = "FIVE_HOUR",
}: {
  status: CodingPlanQuotaResetUiStatus;
  resetType?: CodingPlanResetType;
}) {
  const { intl } = useZCodeIntl();

  if (status === "processing") {
    return (
      <span role="status" className="inline-flex items-center gap-1.5 text-ui-base">
        <Loader2
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span>
          {intl.formatMessage({
            id:
              resetType === "WEEK"
                ? "codingPlan.quotaReset.processingWeek"
                : "codingPlan.quotaReset.processing",
          })}
        </span>
      </span>
    );
  }

  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-ui-base text-success">
      <CheckIcon
        className="size-3.5 shrink-0 animate-in zoom-in-75 motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span>
        {intl.formatMessage({
          id:
            resetType === "WEEK" ? "codingPlan.quotaReset.doneWeek" : "codingPlan.quotaReset.done",
        })}
      </span>
    </span>
  );
}
