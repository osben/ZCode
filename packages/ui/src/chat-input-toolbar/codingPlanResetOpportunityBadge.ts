import type { CodingPlanUsageRemainingState } from "@/CodingPlanUsageRemainingPanel.js";
import type { CodingPlanQuotaResetUiController } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { findCodingPlanQuotaLimit } from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";

export function resolveChatCodingPlanResetOpportunityBadge(
  state: CodingPlanUsageRemainingState | null,
  resetUi: Pick<CodingPlanQuotaResetUiController, "entry" | "opportunityVisible" | "week">,
) {
  const limits = state?.visibleSnapshot?.quota?.limits ?? [];
  const fiveHourTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );

  // Bugfix: the badge used to hide when quota remaining was 100% (resetting would gain nothing).
  // But redeeming rewrites remaining to 100%, making the badge for the remaining opportunities vanish
  // and leaving users thinking the card was swallowed. Show the count whenever that quota exists and
  // has available opportunities.
  return mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(fiveHourTokenLimit) && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(weeklyTokenLimit) && resetUi.week.opportunityVisible,
    },
  ]);
}
