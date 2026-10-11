import type { IntlInstance } from "@/i18n/IntlProvider.js";

type UsageErrorSurface = "chatPlan" | "entitlement" | "stats";

const CREDENTIAL_ERROR_PATTERNS = [
  /token\s+(expired|incorrect)/i,
  /expired.*token/i,
  /incorrect.*token/i,
  /invalid.*(?:api\s*)?key/i,
  /(?:api\s*)?key.*invalid/i,
  /unauthorized/i,
  /forbidden/i,
  /\b40[13]\b/,
  /认证|鉴权|授权|密钥|无效|过期/i,
];

// Team-plan business errors (for example, “only the enterprise owner account can query enterprise summary data” and
// “you have no valid team-plan authorization record, so you cannot create an API Key”) are explicit rejection reasons from the remote service
// and must be shown verbatim. Because “authorization record” contains the word “authorization,” checking credentials first would
// misclassify it as a credential problem (translated copy + Check API Key button), so business errors take priority.
const TEAM_PLAN_BUSINESS_ERROR_PATTERNS = [
  /企业主账号/,
  /团队套餐/,
  /无法创建API\s*Key/i,
  /授权记录/,
];

export function isUsageTeamPlanBusinessError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return TEAM_PLAN_BUSINESS_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function isUsageCredentialError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return CREDENTIAL_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatUsageErrorMessage(
  intl: IntlInstance,
  surface: UsageErrorSurface,
  error: string | null | undefined,
): string {
  // Team-plan business errors are explicit rejection reasons from the remote service; generic copy would hide the real failure reason
  // (such as “only the enterprise owner account can query enterprise summary data”), making it hard to distinguish a permission issue from a network issue.
  // Check these before credential errors: “you have no valid team-plan authorization record…” contains “authorization,”
  // so checking it later would mistake it for a credential error and use translated copy.
  if (isUsageTeamPlanBusinessError(error) && error?.trim()) {
    return error.trim();
  }

  // Provider APIs return English authentication errors, which do not tell users what to check next.
  // Translate recoverable key/OAuth issues into actionable checks here; callers still write the original error to logs.
  if (isUsageCredentialError(error)) {
    return intl.formatMessage({ id: `usage.error.${surface}.credential` });
  }

  return intl.formatMessage({ id: `usage.error.${surface}.generic` });
}
