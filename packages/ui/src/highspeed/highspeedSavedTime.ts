import type { CodingPlanRegularTpsRequest } from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";

export interface HighspeedTimingMetricsForSavedTime {
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
}

export function calculateHighspeedSavedDurationMs(params: {
  outputTokens: number;
  regularTps: number;
  highspeedTps: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
}): number {
  if (
    !Number.isFinite(params.regularTps) ||
    params.regularTps <= 0 ||
    !Number.isFinite(params.highspeedTps) ||
    params.highspeedTps <= 0
  ) {
    return 0;
  }
  const modelSpeedup = params.highspeedTps / params.regularTps;
  if (!Number.isFinite(modelSpeedup) || modelSpeedup <= 0) return 0;
  if (
    params.modelDurationMs !== undefined &&
    params.toolDurationMs !== undefined &&
    Number.isFinite(params.modelDurationMs) &&
    Number.isFinite(params.toolDurationMs) &&
    params.modelDurationMs >= 0 &&
    params.toolDurationMs >= 0
  ) {
    const modelDurationMs = params.modelDurationMs;
    const toolDurationMs = params.toolDurationMs;
    const otherDurationMs =
      params.otherDurationMs !== undefined &&
      Number.isFinite(params.otherDurationMs) &&
      params.otherDurationMs >= 0
        ? params.otherDurationMs
        : Math.max(0, params.durationMs - modelDurationMs - toolDurationMs);
    // The CLI already persisted the real model/tool durations; tool and other waiting times are not shortened by the model speed change.
    const regularDurationMs = toolDurationMs + otherDurationMs + modelDurationMs * modelSpeedup;
    const actualDurationMs = modelDurationMs + toolDurationMs + otherDurationMs;
    return Math.max(0, Math.round(regularDurationMs - actualDurationMs));
  }
  // Bug root cause: card-level TPS was previously applied to the whole turn duration, so tool-call
  // time was also incorrectly shortened by the model speed. Tools take a fixed 20%; only the
  // remaining 80% of model inference is shortened by the Highspeed multiplier.
  const highspeedShare = 0.2 + 0.8 / modelSpeedup;
  const estimatedRegularDurationMs = params.durationMs / highspeedShare;
  return Math.max(0, Math.round(estimatedRegularDurationMs - params.durationMs));
}

/**
 * Uniformly passes the settled real-duration breakdown into the calculator, avoiding a silent
 * fallback to the 20/80 estimate when the breakdown fields are missing before persistence.
 */
export function calculateHighspeedSavedDurationFromMetrics(
  metrics: HighspeedTimingMetricsForSavedTime,
  regularTps: number,
  highspeedTps: number,
): number {
  return calculateHighspeedSavedDurationMs({
    ...metrics,
    regularTps,
    highspeedTps,
  });
}

export async function readHighspeedRegularTpsFromHealth(params: {
  usageStatsService: IUsageStatsService;
  preferredProviderId: string;
  /**
   * Account access context of the current Coding Plan. After the Provider refactor, request-time
   * auth can only be resolved from it; when missing, the host cannot determine which account or
   * team project to query and will always throw.
   */
  accountAccess: CodingPlanRegularTpsRequest["accountAccess"];
  timeZone?: string;
}): Promise<number | undefined> {
  const getRegularTps = params.usageStatsService.getCodingPlanRegularTps;
  if (!getRegularTps) return undefined;
  return getRegularTps.call(params.usageStatsService, {
    preferredProviderId: params.preferredProviderId,
    accountAccess: params.accountAccess,
    ...(params.timeZone ? { timeZone: params.timeZone } : {}),
  });
}
