/** Keeps diagnostic wording aligned with the anomaly guard in core `model-errors.ts`. */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

import {
  requestVerificationActionMessages,
  requestVerificationRecoveryAction,
  type RequestVerificationRecoveryAction,
} from "@/request-security-edition/errors.js";
export {
  resolveRequestVerificationBusinessCode,
  isRequestVerificationTerminalError,
  isRequestVerificationRejectedMessage,
  REQUEST_VERIFICATION_REJECTED_MESSAGE,
} from "@/request-security-edition/errors.js";
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
 * | Off-peak ticket expired | 3102 | 400 | Missed the slot or old-version expiry; prompt to create a new task manually |
 * | Off-peak run timeout | 3106 | 400 | Single run hit the time cap; prompt to create a new task manually |
 * | Upstream HTTP failure | 2007 | 500 | Retryable; refresh quota and do not deduct quota locally |
 */
import { isOffPeakTicketExpiredError, OFF_PEAK_TICKET_EXPIRED_MARKER } from "@zcode/shared";

export const PROVIDER_BUSINESS_ERROR_CODES = [
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
  "3106",
  "2007",
  "429",
  // ChatGPT plan (OpenAI SIWC) codes; specs/chatgpt-plan-signin.md "Limits and recovery in Desktop".
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_invalid_user",
  "subscription_sharing_user_not_eligible",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
] as const;

export type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | RequestVerificationRecoveryAction
  | "retry-later"
  | "upgrade";

export const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
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
  "3106": "zcode.error.providerBusiness.3106",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
  subscription_sharing_usage_limit_exceeded: "chat.quota.chatgptPlanLimited",
  subscription_sharing_invalid_user: "zcode.error.chatgptPlan.signInAgain",
  subscription_sharing_user_not_eligible: "zcode.error.chatgptPlan.notEligible",
  chatpass_v2_scope_not_authorized: "zcode.error.chatgptPlan.signInAgain",
  chatpass_v2_invalid_authorization_context: "zcode.error.chatgptPlan.signInAgain",
};

export const PROVIDER_BUSINESS_ERROR_ACTION_MESSAGE_IDS: Record<
  ProviderBusinessErrorUiAction,
  string
> = {
  login: "chat.error.action.relogin",
  "refresh-quota": "chat.error.action.refreshQuota",
  "switch-model": "chat.error.action.switchModel",
  ...requestVerificationActionMessages,
  "retry-later": "chat.error.action.retryLater",
  upgrade: "chat.quota.action.upgrade",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  "3007": requestVerificationRecoveryAction,
  // 3008/3009/3010 concurrency limit: show the upgrade banner under Start Plan; use the upgrade action outside Start Plan.
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  // Both a missed slot and a run timeout need a new ticket; banner retry or switching models cannot restore the original one.
  "3102": null,
  "3106": null,
  "2007": "retry-later",
  "429": "retry-later",
  // The ChatGPT plan banner and the Model settings action cover these; no relogin of the Z.ai account.
  subscription_sharing_usage_limit_exceeded: null,
  subscription_sharing_invalid_user: null,
  subscription_sharing_user_not_eligible: null,
  chatpass_v2_scope_not_authorized: null,
  chatpass_v2_invalid_authorization_context: null,
};

/** ChatGPT plan codes whose recovery is in Model settings → ChatGPT Plan. */
const CHATGPT_PLAN_SETTINGS_CODES: ReadonlySet<string> = new Set([
  "subscription_sharing_invalid_user",
  "subscription_sharing_user_not_eligible",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
]);

export function isChatGptPlanSettingsRecoveryCode(code: string | undefined): boolean {
  return code !== undefined && CHATGPT_PLAN_SETTINGS_CODES.has(code);
}

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (code === OFF_PEAK_TICKET_EXPIRED_MARKER) {
    return "zcode.error.offPeakTicketExpired";
  }
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
  // PROVIDER_BUSINESS_ERROR / SEND_FAILED / unknown_error + "exceed limit/exceed quota limit".
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

const CONCURRENT_LIMIT_BUSINESS_CODES = new Set(["3008", "3009", "3010"]);

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

/** Check whether a business code represents a concurrency limit. */
export function isConcurrentLimitBusinessCode(code: string | undefined): boolean {
  return Boolean(code && CONCURRENT_LIMIT_BUSINESS_CODES.has(code));
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

/** For upstream 500-class errors, refresh the quota snapshot before retrying to avoid an incorrect local quota deduction in the UI. */
export function shouldRefreshQuotaOnProviderBusinessRetry(code: string | undefined): boolean {
  return code === "2007" || code === "1005";
}

/**
 * Only an explicit 3102 may prompt a quota refund; the legacy marker also covers run timeouts and must not be treated as 3102.
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | "3106" | typeof OFF_PEAK_TICKET_EXPIRED_MARKER | undefined {
  const normalized = code?.trim();
  if (normalized === "3102" || normalized === "3106") {
    return normalized;
  }
  return isOffPeakTicketExpiredError(message) ? OFF_PEAK_TICKET_EXPIRED_MARKER : undefined;
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
