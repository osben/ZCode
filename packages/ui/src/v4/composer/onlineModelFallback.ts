import type { SessionConfigState, SessionModelTransition } from "@zcode/shared/zcode-protocol-v4";

export interface ModelConfigProjectionObservation {
  sessionId: string;
  config: Pick<SessionConfigState, "provider" | "model" | "thought">;
}

/**
 * Only confirms that the online fallback for the current target session has landed in the
 * authoritative projection.
 *
 * The old implementation also generated a global string model preference, letting session
 * facts pollute the next workspace draft in reverse. App Recent now writes a structured
 * ModelSelection only when a regular user submission is accepted; nothing is persisted here.
 */
export function isOnlineModelFallbackAuthoritative(params: {
  targetSessionId: string | null;
  current: ModelConfigProjectionObservation | null;
  transition: SessionModelTransition;
  hasPendingExplicitIntent: boolean;
}): boolean {
  const { targetSessionId, current, transition, hasPendingExplicitIntent } = params;
  if (
    hasPendingExplicitIntent ||
    !targetSessionId ||
    !current ||
    current.sessionId !== targetSessionId ||
    !current.config.provider ||
    !current.config.model ||
    current.config.provider !== transition.to.provider ||
    current.config.model !== transition.to.model
  ) {
    return false;
  }
  return !(
    transition.from.provider === current.config.provider &&
    transition.from.model === current.config.model
  );
}
