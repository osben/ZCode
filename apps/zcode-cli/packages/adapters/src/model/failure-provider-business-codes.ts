import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
  type ModelErrorCode as ModelErrorCodeType,
  type ModelFailureReason,
  type ModelRetryReason,
} from "@zcode/contracts";
import { isNetworkFailure, isTimeoutFailure } from "./failure-inspection.js";
import type { ProviderBusinessError } from "./model-execution.js";

interface ProviderBusinessCodeMapping {
  code: ModelErrorCodeType;
  message?: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
}

// Some OpenAI-compatible providers wrap recoverable upstream network failures as business codes.
const PROVIDER_NETWORK_BUSINESS_CODES = new Set(["1234"]);
const PROVIDER_INTERNAL_NETWORK_MESSAGES = new Set([
  "500 internal network error",
  "internal network error",
  "internal network failure",
]);

const TERMINAL_RATE_LIMIT_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRateLimited,
  reason: ModelFailureReasonValue.RateLimited,
  retryReason: ModelRetryReasonValue.RateLimited,
  retryable: false,
};
const TERMINAL_BUSINESS_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRequestFailed,
  reason: ModelFailureReasonValue.Unknown,
  retryReason: ModelRetryReasonValue.NetworkError,
  retryable: false,
};
const RETRYABLE_RATE_LIMIT_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRateLimited,
  reason: ModelFailureReasonValue.RateLimited,
  retryReason: ModelRetryReasonValue.RateLimited,
  retryable: true,
};
const RETRYABLE_OVERLOAD_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRequestFailed,
  reason: ModelFailureReasonValue.ProviderOverloaded,
  retryReason: ModelRetryReasonValue.ProviderOverloaded,
  retryable: true,
};

const PROVIDER_BUSINESS_CODE_MAPPINGS = new Map<string, ProviderBusinessCodeMapping>([
  [
    "500",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1006",
    {
      code: ModelErrorCode.ProviderNotConfigured,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
    },
  ],
  [
    "1005",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3006",
    {
      code: ModelErrorCode.ModelNotFound,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3001",
    {
      code: ModelErrorCode.InvalidModelRequest,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3007",
    {
      code: ModelErrorCode.InvalidModelRequest,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
    },
  ],
  // 3008/3009/3010: concurrency limits. Similar to quota exhaustion 1005, but these use the upgrade banner rather than refresh-quota.
  [
    "3008",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "3009",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  // 3010: concurrency limit for the current model. Keep it as a non-automatically-retried rate limit; UI guides users to switch models or upgrade.
  [
    "3010",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  // Recoverable errors from BigModel documentation must be listed explicitly; also classify 1261 as
  // context overflow. Explicitly terminate long-term quota, plan entitlement, fair-use, and provider
  // terminal business codes so the generic 429 fallback does not retry them incorrectly.
  [
    "1120",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1230",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1234",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
    },
  ],
  [
    "1261",
    {
      code: ModelErrorCode.ModelContextExceeded,
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1113",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1302",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1303",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1305",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1304",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1308",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1309",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1310",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1311",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1312",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ProviderOverloaded,
      retryReason: ModelRetryReasonValue.ProviderOverloaded,
      retryable: true,
    },
  ],
  [
    "1313",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "3002",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "2007",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
]);

// These codes come from provider documentation and mean the user must top up, change plans, or wait
// for a long-term quota reset. Consume only codes exposed by the AI SDK / existing ProviderBusinessError;
// do not parse raw provider response fields here. insufficient_quota previously fell into generic 429
// retries, so its terminal meaning must not depend on Retry-After duration.
for (const code of [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
  "2056",
  "20097",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, TERMINAL_RATE_LIMIT_MAPPING);
}

for (const code of ["1008", "1314", "1315"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, TERMINAL_BUSINESS_MAPPING);
}

for (const code of ["rate_limit_reached_error", "rate_limit_error"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, RETRYABLE_RATE_LIMIT_MAPPING);
}

for (const code of ["engine_overloaded_error", "overloaded_error"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, RETRYABLE_OVERLOAD_MAPPING);
}

// OpenAI SIWC (Sign in with ChatGPT token sharing) subscription_sharing_* / chatpass_v2_* codes.
// These never fall back to another billing path: eligibility/scope failures terminate, transient
// 503-class failures keep credentials and retry with bounded backoff, and the usage-limit code
// surfaces the manage-usage action instead of inferring a reset time.
PROVIDER_BUSINESS_CODE_MAPPINGS.set("subscription_sharing_user_not_eligible", {
  code: ModelErrorCode.ModelRequestFailed,
  message:
    "Your ChatGPT plan is not available for this app or workspace. Sign in with an eligible ChatGPT Plus/Pro account to continue.",
  reason: ModelFailureReasonValue.InvalidRequest,
  retryReason: ModelRetryReasonValue.NetworkError,
  retryable: false,
});
PROVIDER_BUSINESS_CODE_MAPPINGS.set("subscription_sharing_usage_limit_exceeded", {
  code: ModelErrorCode.ModelRateLimited,
  message:
    "ChatGPT plan usage limit reached. Manage your usage at https://chatgpt.com/settings/usage (5-hour window, shared across all apps using the plan).",
  reason: ModelFailureReasonValue.RateLimited,
  retryReason: ModelRetryReasonValue.RateLimited,
  retryable: false,
});
PROVIDER_BUSINESS_CODE_MAPPINGS.set("subscription_sharing_unsupported_capability", {
  code: ModelErrorCode.InvalidModelRequest,
  message:
    "The ChatGPT plan direct route rejected a request field or tool. Remove the unsupported capability and retry.",
  reason: ModelFailureReasonValue.InvalidRequest,
  retryReason: ModelRetryReasonValue.NetworkError,
  retryable: false,
});
PROVIDER_BUSINESS_CODE_MAPPINGS.set("subscription_sharing_route_not_supported", {
  code: ModelErrorCode.InvalidModelRequest,
  message: "The ChatGPT plan direct route does not support this endpoint or method.",
  reason: ModelFailureReasonValue.InvalidRequest,
  retryReason: ModelRetryReasonValue.NetworkError,
  retryable: false,
});
PROVIDER_BUSINESS_CODE_MAPPINGS.set("subscription_sharing_invalid_user", {
  // The runner's auth-retry hook still gets one refresh+retry chance for 401s before this
  // terminal classification is returned to the caller.
  code: ModelErrorCode.ProviderNotConfigured,
  message:
    "The ChatGPT plan no longer accepts this account. Sign in again with zcode login chatgpt.",
  reason: ModelFailureReasonValue.AuthFailed,
  retryReason: ModelRetryReasonValue.AuthRefresh,
  retryable: false,
});
for (const code of [
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, {
    code: ModelErrorCode.ProviderNotConfigured,
    message:
      "The ChatGPT plan grant does not include the required scope. Re-run zcode login chatgpt to consent to plan usage.",
    reason: ModelFailureReasonValue.AuthFailed,
    retryReason: ModelRetryReasonValue.AuthRefresh,
    retryable: false,
  });
}
for (const code of [
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, {
    code: ModelErrorCode.ModelRequestFailed,
    message: "The ChatGPT plan service is temporarily unavailable. Retrying with backoff.",
    reason: ModelFailureReasonValue.ServerError,
    retryReason: ModelRetryReasonValue.ServerError,
    retryable: true,
  });
}

export function getProviderBusinessCodeMapping(
  providerCode: string,
): ProviderBusinessCodeMapping | undefined {
  return PROVIDER_BUSINESS_CODE_MAPPINGS.get(providerCode);
}

export function isRetryableProviderBusinessNetworkFailure(
  error: ProviderBusinessError,
  providerCode: string | undefined,
): boolean {
  if (providerCode) {
    // AI SDK SSE error chunks may wrap the underlying ECONNRESET in ProviderBusinessError.providerCode.
    // This is still a transport disconnection and must use network-error retry semantics, not become unknown.
    if (isNetworkFailure(providerCode)) {
      return true;
    }
    if (PROVIDER_NETWORK_BUSINESS_CODES.has(providerCode)) {
      return true;
    }

    const normalizedCode = providerCode.toLowerCase();
    if (normalizedCode === "network_error" || normalizedCode === "network_error_retryable") {
      return true;
    }
  }

  return isProviderBusinessInternalNetworkFailure(error);
}

export function isRetryableProviderBusinessTimeoutFailure(
  error: ProviderBusinessError,
  providerCode: string | undefined,
  statusCode?: number,
): boolean {
  // AI SDK/SSE error chunks may wrap underlying headers/body timeouts in ProviderBusinessError.providerCode.
  // These errors have no actual provider business semantics and must retain ordinary timeout retry behavior.
  return isTimeoutFailure(
    error,
    providerCode,
    statusCode ?? error.statusCode ?? error.responseStatus,
  );
}

function isProviderBusinessInternalNetworkFailure(error: ProviderBusinessError): boolean {
  if (readResponseBodyErrorType(error.responseBodySummary) !== "api_error") {
    return false;
  }

  const normalizedMessage =
    normalizeProviderMessage(error.providerMessage) ??
    normalizeProviderMessage(error.message) ??
    normalizeProviderMessage(readResponseBodyErrorMessage(error.responseBodySummary));
  return normalizedMessage ? PROVIDER_INTERNAL_NETWORK_MESSAGES.has(normalizedMessage) : false;
}

function readResponseBodyErrorType(summary: unknown): string | undefined {
  return normalizeProviderMessage(asRecord(asRecord(summary).error).type);
}

function readResponseBodyErrorMessage(summary: unknown): string | undefined {
  return stringValue(asRecord(asRecord(summary).error).message);
}

function normalizeProviderMessage(value: unknown): string | undefined {
  const text = stringValue(value)?.trim().toLowerCase();
  return text && text.length > 0 ? text : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
