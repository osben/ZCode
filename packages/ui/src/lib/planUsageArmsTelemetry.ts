import {
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  sanitizeTelemetryModelValue,
  type ArmsCustomEventPayload,
  type IPlatformService,
  type ZCodeTaskNetworkDebugStatus,
} from "@zcode/shared";
import { logger } from "@/logger.js";

export const PLAN_USAGE_ARMS_GROUP = "plan_usage";
export const PLAN_USAGE_ARMS_EVENT_REQUEST = "plan_request";
export const PLAN_USAGE_ARMS_EVENT_TTFT = "plan_ttft";

export type PlanUsageRequestStatus =
  | "accepted"
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "retry_scheduled"
  | "stream_stalled";

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

const reportedModelRequestEventKeys = new Set<string>();
const MAX_REPORTED_MODEL_REQUEST_EVENT_KEYS = 2_000;

function rememberModelRequestEventKey(eventKey: string): boolean {
  if (reportedModelRequestEventKeys.has(eventKey)) {
    return false;
  }
  reportedModelRequestEventKeys.add(eventKey);
  if (reportedModelRequestEventKeys.size > MAX_REPORTED_MODEL_REQUEST_EVENT_KEYS) {
    const oldest = reportedModelRequestEventKeys.values().next().value;
    if (typeof oldest === "string") {
      reportedModelRequestEventKeys.delete(oldest);
    }
  }
  return true;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

function networkRequestStatus(
  statusType: ZCodeTaskNetworkDebugStatus["statusType"],
): PlanUsageRequestStatus {
  switch (statusType) {
    case "model_request_started":
      return "started";
    case "model_request_completed":
      return "completed";
    case "model_request_failed":
      return "failed";
    case "model_retry_scheduled":
      return "retry_scheduled";
    case "model_stream_stalled":
      return "stream_stalled";
  }
}

function omitUndefinedProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const compact: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact;
}

/** Existing fallback bucket when actual state has no provider ID; must remain distinct from the normalized value for “custom provider.” */
const PLAN_USAGE_PROVIDER_ID_UNKNOWN = "unknown";

/**
 * Reporting projection for provider/model.
 *
 * IDs and model names for custom providers are user-defined; reporting them verbatim could expose private names and create high cardinality, so reuse the same allowlist as
 * `chat_error_banner`: preserve stable IDs for built-in providers and normalize all others to `custom`.
 * Rewrite only the reported value — whether to send the event is still determined by the caller's original `providerId` gate, and local logs keep the original value.
 *
 * Do not merge the `unknown` fallback into `custom`: it means “the protocol event did not include a provider” and is part of existing metrics.
 * In this branch, evaluate the model name against its own allowlist, preserving useful dimensions without passing through a custom model name.
 */
function providerTelemetryProjection(
  providerId: string,
  modelName: string | undefined,
): { provider_id: string; provider_scope: string; model_name: string | undefined } {
  if (providerId === PLAN_USAGE_PROVIDER_ID_UNKNOWN) {
    return {
      provider_id: PLAN_USAGE_PROVIDER_ID_UNKNOWN,
      provider_scope: PLAN_USAGE_PROVIDER_ID_UNKNOWN,
      model_name: sanitizeTelemetryModelValue(modelName) || undefined,
    };
  }
  const provider = resolveTelemetryProviderScope(providerId);
  const modelId = resolveTelemetryModelId(provider.providerScope, modelName);
  return {
    provider_id: provider.providerId,
    provider_scope: provider.providerScope,
    model_name: modelId || undefined,
  };
}

export function reportPlanUsageRequestToArms(
  reporter: ArmsReporter | null | undefined,
  params: {
    providerId?: string | null;
    modelName?: string | null;
    askMode?: string | null;
    requestStatus?: PlanUsageRequestStatus;
    properties?: Record<string, string | number | boolean | undefined>;
  },
): void {
  if (!reporter) {
    return;
  }

  const providerId = params.providerId?.trim();
  if (!providerId) {
    return;
  }

  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_REQUEST,
    group: PLAN_USAGE_ARMS_GROUP,
    value: 1,
    properties: {
      ask_mode: params.askMode?.trim() || undefined,
      ...providerTelemetryProjection(providerId, params.modelName?.trim()),
      request_status: params.requestStatus ?? "accepted",
      ...params.properties,
    },
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS 上报失败", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS 上报异常", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function reportPlanUsageModelRequestStartedToArms(
  reporter: ArmsReporter | null | undefined,
  event: ZCodeTaskNetworkDebugStatus,
): void {
  if (!reporter) {
    return;
  }
  if (!rememberModelRequestEventKey(event.eventKey)) {
    return;
  }

  const providerId = event.providerId?.trim() || "unknown";
  const status = networkRequestStatus(event.statusType);
  const durationMs = nonNegativeInteger(event.durationMs);
  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_REQUEST,
    group: PLAN_USAGE_ARMS_GROUP,
    value: durationMs ?? 1,
    properties: omitUndefinedProperties({
      ask_mode: event.querySource?.trim() || undefined,
      ...providerTelemetryProjection(providerId, event.modelId?.trim()),
      request_status: status,
      request_id: event.requestId,
      task_id: event.taskId,
      input_id: event.inputId,
      query_id: event.queryId,
      event_key: event.eventKey,
      attempt: positiveInteger(event.attempt),
      next_attempt: positiveInteger(event.nextAttempt),
      max_attempts: positiveInteger(event.maxAttempts),
      status_code: nonNegativeInteger(event.statusCode),
      duration_ms: durationMs,
      delay_ms: nonNegativeInteger(event.delayMs),
      idle_ms: nonNegativeInteger(event.idleMs),
      timeout_ms: nonNegativeInteger(event.timeoutMs),
      retryable: event.retryable,
      reason: event.reason?.trim() || undefined,
      transport: event.transport?.trim() || undefined,
      provider_kind: event.providerKind?.trim() || undefined,
    }),
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS 上报失败", {
        providerId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS 上报异常", {
      providerId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function reportPlanUsageTtftToArms(
  reporter: ArmsReporter | null | undefined,
  params: {
    providerId?: string | null;
    modelName?: string | null;
    askMode?: string | null;
    ttftMs: number;
  },
): void {
  if (!reporter || !Number.isFinite(params.ttftMs) || params.ttftMs < 0) {
    return;
  }

  const providerId = params.providerId?.trim();
  if (!providerId) {
    return;
  }

  const ttftMs = Math.max(0, Math.round(params.ttftMs));
  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_TTFT,
    group: PLAN_USAGE_ARMS_GROUP,
    value: ttftMs,
    properties: {
      ask_mode: params.askMode?.trim() || undefined,
      ...providerTelemetryProjection(providerId, params.modelName?.trim()),
      ttft_ms: ttftMs,
    },
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS TTFT 上报失败", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS TTFT 上报异常", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
