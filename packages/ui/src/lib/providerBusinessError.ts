/**
 * zcode-plan / Coding Plan business error codes and frontend handling contract.
 *
 * | Scenario       | code | HTTP | Frontend handling |
 * |----------------|------|------|----------|
 * | Missing/invalid JWT | 1006 | 200 | Sign in or reauthorize |
 * | Quota exhausted | 1005 | 200 | Disable entry point and refresh quota |
 * | Model unavailable | 3006 | 400 | Switch to another model in Built-in Provider |
 * | Invalid parameters | 3001 | 400 | Check the request body |
 * | Security validation rejected | 3007 | 403 | Client cannot complete security validation; contact support |
 * | Model concurrency limit | 3010 | 429 | Show the upgrade banner under Start Plan |
 * | Rate limited | 3002/429 | 429 | Show rate-limit message and retry later |
 * | Off-peak ticket unavailable | 3102 | 400 | Segment duration limit reached; create a new off-peak task to continue |
 * | Upstream HTTP failure | 2007 | 500 | Retryable; refresh quota and do not deduct quota locally |
 */
import { isOffPeakTicketExpiredError } from "@zcode/shared";

const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "2007",
  "429",
] as const;

type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | "retry-later"
  | "upgrade";

const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  // 3007 Security validation rejected: the client cannot complete validation, so there is no recovery action to perform.
  "3007": null,
  // 3008/3009/3010 concurrency limit: show the upgrade banner under Start Plan; use the upgrade action outside Start Plan.
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  // 3102 Off-peak ticket unavailable: continuation requires creating a new off-peak task; retry/model-switch actions in the banner cannot recover it.
  "3102": null,
  "2007": "retry-later",
  "429": "retry-later",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function getProviderBusinessErrorUiAction(
  code: string | undefined,
): ProviderBusinessErrorUiAction | null {
  if (!isProviderBusinessErrorCode(code)) {
    return null;
  }
  return PROVIDER_BUSINESS_ERROR_UI_ACTIONS[code];
}

const START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
]);

export function resolveStartPlanQuotaExhaustedBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "1005" | undefined {
  if (code === "1005") {
    return "1005";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // Older running/historical tasks retain only the outer error code, so the real providerCode=1005 was reduced to
  // PROVIDER_BUSINESS_ERROR / SEND_FAILED / unknown_error + "exceed limit/exceed quota limit"。
  // ChatView calls this inside the Start Plan provider boundary to avoid affecting same-named errors from other providers.
  if (
    (normalizedMessage.includes("exceed limit") ||
      normalizedMessage.includes("exceed quota limit") ||
      normalizedMessage.includes("quota exceeded")) &&
    (!normalizedCode || START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES.has(normalizedCode))
  ) {
    return "1005";
  }

  return undefined;
}

const CONCURRENT_LIMIT_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
  "MODEL_RATE_LIMITED",
]);

const CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["concurrent", "concurrency", "并发"];

const MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["model", "模型"];

export const START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE =
  "Start Plan is busy and automatic model stream recovery reached the maximum retry count.";

export type StartPlanConcurrentLimitBannerReason = "initial-busy" | "retry-exhausted-busy";

export const GLM_QUOTA_BANNER_BUSINESS_CODES = [
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
] as const;

export type GlmQuotaBannerBusinessCode = (typeof GLM_QUOTA_BANNER_BUSINESS_CODES)[number];

const GLM_QUOTA_BANNER_BUSINESS_CODE_SET = new Set<string>(GLM_QUOTA_BANNER_BUSINESS_CODES);

/**
 * Determines whether this is a concurrency-limit business error (3008/3009/3010).
 * Under Start Plan, show the concurrency-limit upgrade banner instead of the ordinary error banner.
 */
export function resolveStartPlanConcurrentLimitBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3008" | "3009" | "3010" | undefined {
  if (code === "3008") {
    return "3008";
  }
  if (code === "3009") {
    return "3009";
  }
  if (code === "3010") {
    return "3010";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // Fallback: older paths may reduce 3008/3009/3010 to a wrapper code plus concurrency-related message.
  // Some historical tasks persist only unknown_error + "model concurrency limit exceeded";
  // this is model-level concurrency and must not degrade to blocking 3008, which would keep Composer locked after recovery.
  if (
    CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) => normalizedMessage.includes(pattern)) &&
    (!normalizedCode || CONCURRENT_LIMIT_WRAPPER_CODES.has(normalizedCode))
  ) {
    return MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) =>
      normalizedMessage.includes(pattern),
    )
      ? "3009"
      : "3008";
  }

  return undefined;
}

export function resolveGlmQuotaBannerBusinessCode(
  code: string | undefined,
): GlmQuotaBannerBusinessCode | undefined {
  const normalizedCode = code?.trim();
  if (normalizedCode && GLM_QUOTA_BANNER_BUSINESS_CODE_SET.has(normalizedCode)) {
    // GLM API 1308/1309/1310/1311/1313-1321 are quota,
    // plan, or account-usage limits; do not let the ordinary error banner hide the upgrade entry point.
    return normalizedCode as GlmQuotaBannerBusinessCode;
  }
  return undefined;
}

export function resolveStartPlanConcurrentLimitBannerReason(
  message: string | undefined,
): StartPlanConcurrentLimitBannerReason {
  return message?.trim() === START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE
    ? "retry-exhausted-busy"
    : "initial-busy";
}

/** Keeps diagnostic wording aligned with the anomaly guard in core `model-errors.ts`. */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * Off-peak ticket unavailable (upstream 3102: ticket invalid or expired).
 * The adapter wraps this business code as `off-peak-ticket-expired: <upstream message>` in the turn error.
 * When the outer code is reduced to a wrapper such as PROVIDER_BUSINESS_ERROR, use the stable marker as fallback;
 * otherwise the banner would show the raw "off peak ticket is invaliad or expired" message to the user.
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | undefined {
  if (code?.trim() === "3102") {
    return "3102";
  }
  return isOffPeakTicketExpiredError(message) ? "3102" : undefined;
}

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
