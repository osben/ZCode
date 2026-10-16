import type { SiwcPlanUsageSnapshot, SiwcPlanUsageWindow } from "@zcode/shared";
import type { ModelStreamEvent, ModelTextResult, ModelUsage } from "@zcode/contracts";

type ProviderFetch = typeof globalThis.fetch;

/**
 * Mutable per-bound-model capture of the latest ChatGPT plan (SIWC) usage snapshot,
 * threaded the same way as `RawRequestBodyCapture`: created once per binding, written by
 * the fetch wrapper below on every response that carries usage headers, and read by the
 * runner after the request completes.
 */
export interface SiwcUsageCapture {
  snapshot: SiwcPlanUsageSnapshot | null;
}

const PRIMARY_HEADER_PREFIX = "x-codex-primary";
const SECONDARY_HEADER_PREFIX = "x-codex-secondary";
const USED_PERCENT_HEADER_SUFFIX = "-used-percent";
const WINDOW_MINUTES_HEADER_SUFFIX = "-window-minutes";
const RESET_AT_HEADER_SUFFIX = "-reset-at";

/**
 * Wrap a fetch for chatgpt-account providers to passively capture plan usage windows from
 * model RESPONSE headers. Purely observational: the request and response flow through
 * untouched, and responses without usage headers leave the capture unchanged (SIWC preview
 * tokens may not send them). No fallback endpoints, no extra network calls.
 */
export function createSiwcUsageCaptureFetch(
  baseFetch: ProviderFetch,
  capture: SiwcUsageCapture,
): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const snapshot = readSiwcUsageSnapshotFromHeaders(response.headers);
    if (snapshot) capture.snapshot = snapshot;
    return response;
  };
}

/** Read the primary (5h) + secondary (weekly) usage windows from response headers, if reported. */
export function readSiwcUsageSnapshotFromHeaders(headers: Headers): SiwcPlanUsageSnapshot | null {
  const primary = readUsageWindowFromHeaders(headers, PRIMARY_HEADER_PREFIX);
  if (!primary) {
    // The primary window identifies the reading; secondary-only headers are ignored rather
    // than fabricating a snapshot whose required 5h window is unknown.
    return null;
  }
  const secondary = readUsageWindowFromHeaders(headers, SECONDARY_HEADER_PREFIX);
  return { primary, ...(secondary ? { secondary } : {}) };
}

function readUsageWindowFromHeaders(
  headers: Headers,
  prefix: string,
): SiwcPlanUsageWindow | undefined {
  const usedPercent = parseFinitePercent(headers.get(prefix + USED_PERCENT_HEADER_SUFFIX));
  // used-percent is the required member of the numeric pair; a missing or garbage value
  // skips the whole window instead of displaying a fabricated percentage.
  if (usedPercent === undefined) return undefined;
  const windowMinutes = parsePositiveInt(headers.get(prefix + WINDOW_MINUTES_HEADER_SUFFIX));
  const resetsAt = readNonEmptyTrimmed(headers.get(prefix + RESET_AT_HEADER_SUFFIX));
  return {
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseFinitePercent(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return undefined;
  return parsed;
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function readNonEmptyTrimmed(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Attach the latest captured snapshot (if any) to a completion usage object. */
function withSiwcUsage(usage: ModelUsage, capture: SiwcUsageCapture): ModelUsage {
  return capture.snapshot
    ? { ...usage, providerRateLimits: capture.snapshot }
    : usage;
}

/** Finish events are the sole usage carrier on the streaming path (also feeds SIWC aggregation). */
export function attachSiwcUsageToFinishEvent(
  event: ModelStreamEvent,
  capture: SiwcUsageCapture,
): ModelStreamEvent {
  if (event.type !== "finish" || !capture.snapshot) return event;
  return { ...event, usage: withSiwcUsage(event.usage, capture) };
}

/** Generate-text results carry usage directly. */
export function attachSiwcUsageToTextResult(
  result: ModelTextResult,
  capture: SiwcUsageCapture,
): ModelTextResult {
  if (!capture.snapshot) return result;
  return { ...result, usage: withSiwcUsage(result.usage, capture) };
}
