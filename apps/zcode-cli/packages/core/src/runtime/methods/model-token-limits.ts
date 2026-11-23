import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import { traceContextToLogContext } from "../deps.js";
import type { AutoCompactPolicyConfig, Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS = 32_000;

export function resolveNormalRequestMaxOutputTokens(input: {
  modelMaxOutputTokens: number | undefined;
}): number {
  // 32K is the default when the model has no declared output budget, not a global cap on model configuration.
  // Use the resolved model value as-is; otherwise a 64K model's request budget would be incorrectly clipped to 32K.
  return (
    positiveFlooredTokens(input.modelMaxOutputTokens) ?? DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS
  );
}

/**
 * Auto Compact、Microcompact 与 Compact summary 共用的策略配置。
 * 修复原因：摘要上限改为 Auto Compact reserve 后，三处必须读同一份窗口与输出上限；
 * 否则 compact 配置覆盖窗口时，触发阈值和摘要上限会按两套数计算。
 */
export function resolveAutoCompactPolicyConfig(
  runtime: Pick<AgentRuntimeInternal, "config">,
  model: Model,
): AutoCompactPolicyConfig {
  return {
    contextWindow: model.properties.contextWindow,
    ...runtime.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: runtime.config.modelContextBudgetStrategy,
  };
}

export function resolveModelStepMaxOutputTokens(input: {
  baselineMaxOutputTokens: number;
  contextWindow: number | undefined;
  estimatedCurrentUsage: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
}): number {
  // legacy is supported only for input compatibility; calculate the preflight cap from the remaining window for all requests, including tool continuations.
  if (
    input.contextWindow === undefined ||
    !Number.isFinite(input.contextWindow) ||
    input.contextWindow <= 0 ||
    !Number.isFinite(input.estimatedCurrentUsage) ||
    input.estimatedCurrentUsage < 0
  ) {
    return input.baselineMaxOutputTokens;
  }

  const estimatedAvailable = Math.floor(input.contextWindow - input.estimatedCurrentUsage - 1_000);
  if (estimatedAvailable <= 0) {
    // A local estimate is not an authoritative provider rejection; when no positive amount can be sent, preserve the baseline for existing error recovery.
    return input.baselineMaxOutputTokens;
  }
  const candidate = Math.min(input.baselineMaxOutputTokens, estimatedAvailable);
  return candidate;
}

export function modelRequestTokenLimitLogContext(input: {
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
  traceContext: TraceContext;
}) {
  return {
    ...traceContextToLogContext(input.traceContext),
    contextWindow: input.contextWindow,
    event: "model.request.token_limits",
    inputBudgetTokens: inputBudgetTokens(input.contextWindow, input.maxOutputTokens),
    maxOutputTokens: input.maxOutputTokens,
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    module: "core.runtime",
  };
}

function inputBudgetTokens(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): number | undefined {
  if (
    contextWindow === undefined ||
    maxOutputTokens === undefined ||
    !Number.isFinite(contextWindow) ||
    !Number.isFinite(maxOutputTokens)
  ) {
    return undefined;
  }

  return Math.max(0, Math.floor(contextWindow) - Math.floor(maxOutputTokens));
}

function positiveFlooredTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
