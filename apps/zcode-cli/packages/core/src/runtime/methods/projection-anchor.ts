import type {
  MessageAnchorOrigin,
  MessageProjectionAnchor,
  SyntheticUserMessageSource,
  TraceContext,
} from "../deps.js";

// ── v4 transcript anchors (manifest) ──
// Additive JSON: old data has no anchor, so the read side degrades gracefully; turnId comes from the existing traceContext value.
// sourceCommandId is written from command execution context once the v4 command inbox is wired.
export function buildProjectionAnchor(
  traceContext: TraceContext,
  origin?: MessageAnchorOrigin,
  sourceCommandId?: string,
): MessageProjectionAnchor | undefined {
  if (traceContext.turnId === undefined && origin === undefined && sourceCommandId === undefined) {
    return undefined;
  }
  return {
    ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
    ...(origin ? { origin } : {}),
    ...(sourceCommandId ? { sourceCommandId } : {}),
  };
}

// Read-only mapping from the legacy SyntheticUserMessageSource to the v4 userInput.origin vocabulary.
export function mapSyntheticSourceToAnchorOrigin(
  source: SyntheticUserMessageSource,
): MessageAnchorOrigin {
  switch (source) {
    case "background_task":
    case "subagent":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    default:
      return "synthetic";
  }
}
