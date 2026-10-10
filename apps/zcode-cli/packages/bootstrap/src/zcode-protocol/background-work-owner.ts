import type { SessionId, SessionInfo } from "@zcode/contracts";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Query only an existing executor; never restore the runtime just to read output. */
export async function readBackgroundBashOutputFromOwner(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  workId: string,
): Promise<BackgroundBashOutputResult> {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const live = context.sessions.get(current);
    if (live) {
      // A cold-restored child record may use a new adapter while the old task remains in its
      // ancestor; liveness does not imply task ownership. Always pass the original sessionId to
      // verify ownership. Continue only when the task is absent; return read failures or missing
      // capabilities unchanged.
      const result = await live.app.readBackgroundBashOutput(workId, sessionId);
      if (result.kind !== "unavailable") return result;
    }
    const stored: SessionInfo | null | undefined = await context.deps.sessionStore?.getSession(
      current as SessionId,
    );
    current = stored?.parentID ? String(stored.parentID) : undefined;
  }
  return { kind: "unavailable", workId };
}
