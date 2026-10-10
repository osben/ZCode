import { useMemo } from "react";
import type { SessionDebugSnapshot } from "@zcode/shared";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";

/**
 * Minimum trustworthy decoding window. When a proxy or network buffers an entire response and
 * delivers it at once, durationMs - TTFT can collapse to a few dozen milliseconds, making
 * outputTokens / window produce a false spike of tens of thousands of tok/s (observed with
 * SSE buffering by Clash-like proxies). Rounds below this window are not shown as facts;
 * the developer panel continues to show raw values for diagnosis.
 */
export const MIN_RELIABLE_GENERATION_DURATION_MS = 100;

/**
 * Output throughput for the most recent **trustworthy** model request. Search backward for the
 * first round whose decoding window meets the threshold; skip burst-delivered rounds rather than
 * treating them as current facts. Remain absent if no trustworthy round is found or its throughput
 * is unknown (null).
 */
export function resolveLatestTokensPerSecond(
  rounds: readonly SessionDebugSnapshot["rounds"][number][],
): number | null {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!;
    if (
      round.generationDurationMs !== null &&
      round.generationDurationMs < MIN_RELIABLE_GENERATION_DURATION_MS
    ) {
      continue;
    }
    return round.tokensPerSecond ?? null;
  }
  return null;
}

export function formatTokensPerSecond(locale: string, tokensPerSecond: number): string {
  // Match the TPS column in the developer tools panel: one decimal place; styles handle tabular rendering.
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(tokensPerSecond);
}

/**
 * Live session throughput (tok/s). The source of truth is agent-side session/debug telemetry
 * (outputTokens / decoding time for each completed model request). This hook only polls once per
 * second; it does not derive a local Δtoken/Δt. If polling fails (an older CLI reports
 * sessionUnavailable or a detached child has been reclaimed), the previous snapshot must not be
 * presented as current; hide it silently as specified.
 */
export function useSessionThroughput({
  enabled,
  sessionId,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  sessionId: string | null | undefined;
  workspaceIdentity?: string;
  workspacePath: string;
}): { tokensPerSecond: number | null } {
  const debugState = useSessionDebug({
    enabled: enabled && typeof sessionId === "string" && sessionId.length > 0,
    taskId: sessionId ?? null,
    workspaceIdentity,
    workspacePath,
  });
  const { rounds, error } = debugState;
  return useMemo(
    () => ({ tokensPerSecond: error ? null : resolveLatestTokensPerSecond(rounds) }),
    [rounds, error],
  );
}
