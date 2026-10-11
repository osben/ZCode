// Cold-recovery coordinator: when a subscription targets a session absent from the in-memory
// registry but possibly persisted (for example, opening a historical session after restarting the
// CLI), use the host hook to restore the record, then return to the existing gateway READY hydration
// path. Split out of v4-gateway for single responsibility and max-lines constraints.
//
// Semantics:
// - Keep the existing single-flight runtime activation here; the gateway owns the full READY watermark.
// - Classify errors without branching on error text (per project convention):
//   fault.subscribe.sessionNotFound (missing from the store too / host does not support recovery)
//   versus fault.subscribe.resumeFailed (failure during recovery, preserving the original cause).
//   Include reasonCode in the message so the renderer can display lastError in the subscription error block without UI changes.

import type { MessageWithParts } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";

export type ColdSessionResumeOutcome =
  | { status: "resumed"; persistedMessages?: MessageWithParts[] }
  | { status: "notFound" };

/** Narrow host capability surface required by the coordinator (same shape as V4GatewayHost, avoiding a circular import). */
export interface ColdSessionResumeHost {
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

/** Structured error for subscribing to an unavailable session (see the file header for reasonCode values). */
export class V4SubscribeSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reasonCode: "fault.subscribe.sessionNotFound" | "fault.subscribe.resumeFailed",
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${detail} (${reasonCode})`, options);
    this.name = "V4SubscribeSessionUnavailableError";
  }
}

export class ColdSessionResumeCoordinator {
  /** sessionId → in-progress runtime activation; release as soon as it settles. */
  private readonly flights = new Map<string, Promise<MessageWithParts[] | undefined>>();

  constructor(private readonly host: ColdSessionResumeHost) {}

  ensureResumed(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const inFlight = this.flights.get(sessionId);
    if (inFlight) {
      this.host.onDebug?.(`cold resume joined existing flight session=${sessionId}`);
      return inFlight;
    }
    this.host.onDebug?.(`cold resume flight created session=${sessionId}`);
    const flight = this.resume(sessionId, resumeThoughtLevel, workspace).finally(() => {
      this.flights.delete(sessionId);
      this.host.onDebug?.(`cold resume flight cleared session=${sessionId}`);
    });
    this.flights.set(sessionId, flight);
    return flight;
  }

  clear(): void {
    this.flights.clear();
  }

  private async resume(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const resume = this.host.resumePersistedSession;
    if (!resume) {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active: ${sessionId}`,
      );
    }
    let outcome: ColdSessionResumeOutcome;
    try {
      outcome = workspace
        ? await resume.call(this.host, sessionId, resumeThoughtLevel, workspace)
        : await resume.call(this.host, sessionId, resumeThoughtLevel);
    } catch (error) {
      this.host.onError?.("v4.subscribe.resume", error, {
        phase: "resumePersistedSession",
        sessionId,
      });
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        `Failed to resume persisted session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (outcome.status === "notFound") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active and not persisted: ${sessionId}`,
      );
    }
    return outcome.persistedMessages;
  }
}
