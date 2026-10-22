/**
 * ACP session resume bookkeeping of one runtime (specs/acp-agent-runtime.md "S5").
 *
 * The runtime remembers the ACP session id it last established, so a restart after a failure asks the
 * agent to load that session again instead of starting over. The host passes the id it persisted for
 * the ZCode session, so a cold resume can do the same. Each handshake reports how the session began.
 */

/**
 * `created`: no earlier session existed. `loaded`: the agent restored the earlier session with
 * `session/load`. `reset`: an earlier session existed but was not restored (no load capability, or
 * the load failed), so the agent started a new one.
 */
export type AcpSessionStart = "created" | "loaded" | "reset";

export class AcpSessionResume {
  #target: string | undefined;
  #start: AcpSessionStart | undefined;

  constructor(previousSessionId: string | undefined) {
    this.#target = previousSessionId;
  }

  /** The ACP session id the next handshake asks the agent to load; `undefined` starts a new session. */
  get target(): string | undefined {
    return this.#target;
  }

  /** Records a committed handshake: its session id becomes the next target and its start is reported once. */
  committed(sessionId: string, start: AcpSessionStart): void {
    this.#target = sessionId;
    this.#start = start;
  }

  /** Returns how the latest session began, then clears it. */
  take(): AcpSessionStart | undefined {
    const start = this.#start;
    this.#start = undefined;
    return start;
  }
}
