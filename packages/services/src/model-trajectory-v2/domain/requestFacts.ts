import type {
  ZCodeTrajectoryV2CacheBreakpoint,
  ZCodeTrajectoryV2RequestParams,
  ZCodeTrajectoryV2StreamTiming,
} from "../contract.js";
import { asArray, asNumber, asObject, asString, type UnknownRecord } from "./values.js";

/** Request parameters from an Anthropic- or OpenAI-shaped wire body. */
export function extractRequestParams(
  body: UnknownRecord | undefined,
): ZCodeTrajectoryV2RequestParams {
  if (!body) return {};
  const params: ZCodeTrajectoryV2RequestParams = {};
  const maxOutputTokens =
    asNumber(body.max_tokens) ??
    asNumber(body.max_completion_tokens) ??
    asNumber(body.max_output_tokens);
  if (maxOutputTokens !== undefined) params.maxOutputTokens = maxOutputTokens;

  const thinking = asObject(body.thinking);
  const thinkingType = asString(thinking?.type);
  if (thinkingType) {
    const budgetTokens = asNumber(thinking?.budget_tokens);
    params.thinking =
      budgetTokens === undefined ? { type: thinkingType } : { type: thinkingType, budgetTokens };
  }

  const effort =
    asString(asObject(body.output_config)?.effort) ??
    asString(body.reasoning_effort) ??
    asString(asObject(body.reasoning)?.effort);
  if (effort) params.effort = effort;

  const toolChoice = describeToolChoice(body.tool_choice);
  if (toolChoice) params.toolChoice = toolChoice;

  const temperature = asNumber(body.temperature);
  if (temperature !== undefined) params.temperature = temperature;
  if (typeof body.stream === "boolean") params.stream = body.stream;
  return params;
}

function describeToolChoice(value: unknown): string | undefined {
  const named = asString(value);
  if (named) return named;
  const choice = asObject(value);
  if (!choice) return undefined;
  const type = asString(choice.type);
  // Anthropic: {type:"tool", name}; OpenAI: {type:"function", function:{name}}.
  const toolName = asString(choice.name) ?? asString(asObject(choice.function)?.name);
  if (toolName && (type === "tool" || type === "function")) return `tool:${toolName}`;
  return type;
}

export interface CacheBreakpointFacts {
  breakpoints: ZCodeTrajectoryV2CacheBreakpoint[];
  complete: boolean;
}

/**
 * `cache_control` markers on system blocks, tool definitions and message parts. Message-level markers come from the
 * wire messages, or from the SDK messages' provider options when the wire messages were trimmed.
 */
export function extractCacheBreakpoints(
  body: UnknownRecord | undefined,
  sdkMessages: unknown,
): CacheBreakpointFacts {
  const breakpoints: ZCodeTrajectoryV2CacheBreakpoint[] = [];
  asArray(body?.system).forEach((block, index) => {
    const marker = cacheMarker(asObject(block)?.cache_control);
    if (marker) breakpoints.push({ location: "system", index, ...marker });
  });
  asArray(body?.tools).forEach((tool, index) => {
    const marker = cacheMarker(asObject(tool)?.cache_control);
    if (marker) breakpoints.push({ location: "tools", index, ...marker });
  });

  if (Array.isArray(body?.messages)) {
    body.messages.forEach((message, index) => {
      const marker = asArray(asObject(message)?.content)
        .map((part) => cacheMarker(asObject(part)?.cache_control))
        .find(Boolean);
      if (marker) breakpoints.push({ location: "message", index, ...marker });
    });
    return { breakpoints, complete: true };
  }

  if (Array.isArray(sdkMessages)) {
    sdkMessages.forEach((message, index) => {
      const options = asObject(asObject(asObject(message)?.providerOptions)?.anthropic);
      const marker = cacheMarker(options?.cacheControl);
      if (marker) breakpoints.push({ location: "message", index, ...marker });
    });
    return { breakpoints, complete: true };
  }

  return { breakpoints, complete: false };
}

function cacheMarker(value: unknown): { ttl?: string } | undefined {
  const marker = asObject(value);
  if (!marker) return undefined;
  const ttl = asString(marker.ttl);
  return ttl ? { ttl } : {};
}

/** The model-io `timing` key; malformed or missing input yields undefined. */
export function parseStreamTiming(value: unknown): ZCodeTrajectoryV2StreamTiming | undefined {
  const raw = asObject(value);
  if (!raw || typeof raw.stream !== "boolean") return undefined;
  const timing: ZCodeTrajectoryV2StreamTiming = { stream: raw.stream };
  const keys = ["timeToFirstProviderEventMs", "timeToFirstContentMs", "timeToFirstTextMs"] as const;
  for (const key of keys) {
    const ms = asNumber(raw[key]);
    if (ms !== undefined && ms >= 0) timing[key] = ms;
  }
  return timing;
}

export function parseCacheWriteTokens(usage: unknown): number | undefined {
  return asNumber(asObject(usage)?.cacheWriteTokens);
}
