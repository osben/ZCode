// Handle turn_complete: usage/cache statistics plus a fallback result.
//
// Keep both responsibilities together because they come from the same event; this also keeps app-events.ts's switch within max-lines.
import type React from "react";
import type { ModelUsageSummary } from "@zcode/contracts";
import type { CacheStats, Message } from "./app-model.js";
import { cacheStatsFromPayload, usageFromPayload } from "./app-event-data.js";
import { projectedTranscriptHasResponse } from "./app-transcript-stream.js";
import { stringField } from "./state.js";

/**
 * turn_complete carries the authoritative `response`; append it only when this text is **not already** in the transcript.
 *
 * Why this is needed: notification-driven turns have no submitPrompt and therefore no applyResult to append a result. In most cases,
 * streaming events have already rendered the text, but turns with only tool calls or a stream that failed midway may leave no text at all;
 * this fallback is then the only source of the answer.
 *
 * Why this does not duplicate output: the check is based on **content**, not timing. `projectedTranscriptHasResponse` is already used by
 * appendAgentResult's guard, so whichever path appends first, the other sees that the content is present and skips it—the same idempotency idea
 * as event ID deduplication (by content/identity, without relying on order).
 *
 * This symmetry has one requirement: the guard scans only `streamProjected` messages, so the message appended here
 * must **set `streamProjected: true`**. Otherwise, when a stream fails but turn_complete carries a response, this path appends a regular message,
 * then applyResult cannot see it and appends another, duplicating the answer. `transcriptText` falls back to `content` for messages without parts,
 * so there is no need to synthesize parts.
 */
export function applyTurnCompleteFallbackResponse(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const response = stringField(payload, "response");
  if (!response || response.trim().length === 0) return;
  setMessages((current) =>
    projectedTranscriptHasResponse(current, response)
      ? current
      : [...current, { content: response, role: "agent", streamProjected: true }],
  );
}

export function applyTurnCompleteEvent(
  payload: Record<string, unknown>,
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>,
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>,
): void {
  const turnUsage = usageFromPayload(payload);
  if (turnUsage) setUsage(turnUsage);

  const cacheStats = cacheStatsFromPayload(payload);
  if (cacheStats) setCacheStats(cacheStats);
}
