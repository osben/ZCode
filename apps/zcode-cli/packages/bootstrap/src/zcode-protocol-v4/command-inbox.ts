// Command inbox: the unified command admission and query entry point.
// Three fact classes are strictly separated: in-flight / live inputs stay pinned forever; only settled ones enter the 512/session LRU.
import { PendingSessionCreations } from "./command-inbox-creations.js";
import type {
  CommandAck,
  CommandEnvelope,
  CommandKey,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  PROTOCOL_V4_LIMITS,
  ROW_TARGETING_COMMANDS,
  parseCommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";

/** Guard verdict: reject (withdraw optimistic) or noop (late arrival silently closed out, §6.3). */
export type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

type PersistentLookup = (key: CommandKey) => Promise<CommandAck | null> | CommandAck | null;

export interface CommandInboxHost {
  /** Prepare a cold session after the idempotent query, while holding session admission; no separate accept queue. */
  prepareDecision?(envelope: CommandEnvelope): Promise<void>;

  /** The session's current revision; null for an unknown session (createSession uses a null sessionId). */
  getRevision(sessionId: string): number | null;
  /** The session's current projection epoch; CAS must check epoch first, then revision. */
  getLogEpoch(sessionId: string): string | null;
  /** Entity/action verdict from the same resolver as row-targeting commands. */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
  /** Business guard (product-protocol guard id). Defaults to always allow. */
  guard?(envelope: CommandEnvelope): GuardDecision;
  /** The callback order below is the persisted-fact priority; implementations must match sourceCommandId exactly. */
  lookupTranscriptCommand?: PersistentLookup;
  lookupTimelineCommand?: PersistentLookup;
  lookupChildCommand?: PersistentLookup;
  lookupDiscardedCommand?: PersistentLookup;
  now?(): number;
}

interface InFlightEntry {
  ack: CommandAck;
  final: Promise<CommandAck>;
  resolveFinal: (ack: CommandAck) => void;
}

type CommandFinal = Pick<
  CommandAck,
  "status" | "reasonCode" | "message" | "result" | "memoryEnabled"
>;

interface LiveInputEntry {
  ack: CommandAck;
  intent: ConversationInputIntent;
}

export type CommandInboxOutcome =
  | { kind: "ack"; ack: CommandAck }
  | {
      kind: "execute";
      envelope: CommandEnvelope;
      ack: CommandAck;
      /** Authoritative order assigned by CLI serial admission; used to build the ConversationInputIntent. */
      admissionSeq: number;
      admittedAt: number;
      queueItemId: string;
      /** Called once after execution finishes to fill in the final state; releases the per-session admission gate. */
      settle: (final: CommandFinal) => void;
    };

// createSession and null-sessionId queries go to the global bucket.
const GLOBAL_BUCKET = "@global";

export function queueItemIdForCommand(commandId: string): string {
  return `queue_${commandId}`;
}

type GateRelease = () => void;

/**
 * FIFO async gate. An explicit release is returned because the per-session gate must span the
 * gateway execute and only release at settle; a plain with-lock would let the next admission
 * through too early when handle returns.
 */
class AsyncGateRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<GateRelease> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

export class CommandInbox {
  private readonly inFlight = new Map<string, Map<string, InFlightEntry>>();
  private readonly liveInputs = new Map<string, Map<string, LiveInputEntry>>();
  private readonly settled = new Map<string, Map<string, CommandAck>>();
  private readonly admissionSeq = new Map<string, number>();
  private readonly keyGates = new AsyncGateRegistry();
  private readonly sessionGates = new AsyncGateRegistry();
  private readonly creations = new PendingSessionCreations();

  constructor(private readonly host: CommandInboxHost) {}

  /**
   * Resolves once every createSession received so far for `sessionId` has settled. A subscribe for the
   * reserved id waits here, so it is never answered "not found" while its create is still running.
   */
  whenSessionCreationSettles(sessionId: string): Promise<void> {
    return this.creations.whenSettled(sessionId);
  }

  async handle(raw: unknown): Promise<CommandInboxOutcome> {
    // Parsed once, so the raw input's fields are read a single time for both the registration and admission.
    const parsed = parseCommandEnvelope(raw);
    // The creation is registered on receipt, before any await, so a subscribe that arrives during
    // admission (prepareDecision) already waits for it. A reservation carries its id in the payload and
    // dispatches with a null envelope target, so the payload id is the key.
    const creatingSessionId =
      parsed.ok && parsed.envelope.type === "createSession"
        ? createSessionKey(parsed.envelope)
        : null;
    if (creatingSessionId === null) return this.admit(raw, parsed);
    const release = this.creations.begin(creatingSessionId);
    let outcome: CommandInboxOutcome;
    try {
      outcome = await this.admit(raw, parsed);
    } catch (error) {
      release();
      throw error;
    }
    if (outcome.kind === "ack") {
      release();
      return outcome;
    }
    // An admitted create stays pending until the handler settles it, not until admission returns.
    const settle = outcome.settle;
    return {
      ...outcome,
      settle: (final) => {
        try {
          settle(final);
        } finally {
          release();
        }
      },
    };
  }

  private async admit(
    raw: unknown,
    parsed: ReturnType<typeof parseCommandEnvelope>,
  ): Promise<CommandInboxOutcome> {
    if (!parsed.ok) {
      return this.ackOnly({
        commandId: this.extractCommandId(raw),
        status: "rejected",
        reasonCode: "proto.invalidPayload",
        message: parsed.error.message,
        revisionAtDecision: 0,
      });
    }
    const envelope = parsed.envelope;
    const key = { sessionId: envelope.sessionId, commandId: envelope.commandId };
    const bucketKey = this.bucketKey(envelope.sessionId);
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));

    try {
      const pinned = this.inFlight.get(bucketKey)?.get(envelope.commandId);
      if (pinned) return this.ackOnly(this.retryAck(await pinned.final));
      const existing = await this.lookupExact(key);
      if (existing) return this.ackOnly(this.retryAck(existing));

      // Fixed lock order: key gate → per-session admission gate. The session gate is held until
      // settle, so different commandIds in the same session serialize in the order the CLI
      // actually performs admission.
      const releaseSession = await this.sessionGates.acquire(bucketKey);
      try {
        // While waiting on the session gate, the previous command may have incrementally written persisted facts for this key.
        const afterWaitPinned = this.inFlight.get(bucketKey)?.get(envelope.commandId);
        if (afterWaitPinned) {
          releaseSession();
          return this.ackOnly(this.retryAck(await afterWaitPinned.final));
        }
        const afterWait = await this.lookupExact(key);
        if (afterWait) {
          releaseSession();
          return this.ackOnly(this.retryAck(afterWait));
        }

        await this.host.prepareDecision?.(envelope);
        const decision = this.decide(envelope);
        if (decision.kind === "ack") {
          if (decision.remember) this.rememberSettled(bucketKey, envelope.commandId, decision.ack);
          releaseSession();
          return this.ackOnly(decision.ack);
        }

        const nextAdmissionSeq = (this.admissionSeq.get(bucketKey) ?? 0) + 1;
        const admittedAt = this.host.now?.() ?? Date.now();
        this.admissionSeq.set(bucketKey, nextAdmissionSeq);
        let resolveFinal!: (ack: CommandAck) => void;
        const final = new Promise<CommandAck>((resolve) => {
          resolveFinal = resolve;
        });
        const entry: InFlightEntry = { ack: decision.ack, final, resolveFinal };
        this.mapFor(this.inFlight, bucketKey).set(envelope.commandId, entry);

        // The old single-table LRU evicted commands still executing/queued during >512-entry
        // churn; the query then returned unknown and a retry executed again. New commands are
        // pinned first, then the key gate is released.
        releaseKey();
        let settled = false;
        return {
          kind: "execute",
          envelope,
          ack: decision.ack,
          admissionSeq: nextAdmissionSeq,
          admittedAt,
          queueItemId: queueItemIdForCommand(envelope.commandId),
          settle: (final) => {
            if (settled) return;
            settled = true;
            const live = this.liveInputs.get(bucketKey)?.get(envelope.commandId);
            const ack = {
              ...decision.ack,
              ...final,
            };
            this.inFlight.get(bucketKey)?.delete(envelope.commandId);
            if (live) {
              live.ack = ack;
            } else {
              this.rememberSettled(bucketKey, envelope.commandId, ack);
            }
            // An in-flight duplicate used to take the admission ACK directly and return before
            // fork/create had a child result; a lost ACK retried and navigation failed. All
            // same-key requests must share this one final promise and see the same final state
            // before the session FIFO is released.
            entry.resolveFinal(ack);
            releaseSession();
          },
        };
      } catch (error) {
        releaseSession();
        throw error;
      }
    } catch (error) {
      return this.ackOnly(this.queryUnavailableAck(key, error));
    } finally {
      // The execute path already released early after pinning; release is idempotent, other paths release here.
      releaseKey();
    }
  }

  /** The 1..64 upper-bound schema is validated by the gateway; queries run in parallel preserving Promise.all input order. */
  async query(
    keys: readonly CommandKey[],
  ): Promise<Array<{ key: CommandKey; result: CommandAck | "unknown" }>> {
    return Promise.all(keys.map((key) => this.queryOne(key)));
  }

  /** Pins the same full intent after queue/guide admission; settled churn must not touch it. */
  pinLiveInput(sessionId: string, intent: ConversationInputIntent, ack?: CommandAck): void {
    const bucketKey = this.bucketKey(sessionId);
    const inFlightAck = this.inFlight.get(bucketKey)?.get(intent.sourceCommandId)?.ack;
    this.mapFor(this.liveInputs, bucketKey).set(intent.sourceCommandId, {
      intent,
      ack: ack ??
        inFlightAck ?? {
          commandId: intent.sourceCommandId,
          status: "accepted",
          revisionAtDecision: 0,
        },
    });
    this.settled.get(bucketKey)?.delete(intent.sourceCommandId);
  }

  /** Unpins when the queue/guide input enters the transcript, is cancelled, or fails; may move the final state into the settled LRU. */
  releaseLiveInput(key: CommandKey, finalAck?: CommandAck): void {
    const bucketKey = this.bucketKey(key.sessionId);
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    this.liveInputs.get(bucketKey)?.delete(key.commandId);
    if (finalAck ?? live?.ack) {
      this.rememberSettled(bucketKey, key.commandId, finalAck ?? live!.ack);
    }
  }

  hasPinnedSessionState(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    return (
      (this.inFlight.get(bucketKey)?.size ?? 0) > 0 ||
      (this.liveInputs.get(bucketKey)?.size ?? 0) > 0
    );
  }

  /**
   * After a resident deactivates, the inbox must also return to the CLI cold-start state.
   * In-flight/live facts must not be cleared; callers must use them as recycle-guard
   * conditions. Settled facts can still be re-sourced from the durable transcript/timeline.
   */
  clearSession(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    if (this.hasPinnedSessionState(sessionId)) return false;
    this.inFlight.delete(bucketKey);
    this.liveInputs.delete(bucketKey);
    this.settled.delete(bucketKey);
    this.admissionSeq.delete(bucketKey);
    return true;
  }

  /** Only for replacement paths that already closed execution admission and released the old instance; final-state facts still re-source from the persistent ledger. */
  async resetReleasedSession(sessionId: string): Promise<void> {
    const bucketKey = this.bucketKey(sessionId);
    await Promise.all(
      [...(this.inFlight.get(bucketKey)?.values() ?? [])].map((entry) => entry.final),
    );
    this.liveInputs.delete(bucketKey);
    this.clearSession(sessionId);
  }

  private async queryOne(
    key: CommandKey,
  ): Promise<{ key: CommandKey; result: CommandAck | "unknown" }> {
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));
    try {
      return { key, result: (await this.lookupExact(key)) ?? "unknown" };
    } catch (error) {
      return { key, result: this.queryUnavailableAck(key, error) };
    } finally {
      releaseKey();
    }
  }

  private async lookupExact(key: CommandKey): Promise<CommandAck | null> {
    const bucketKey = this.bucketKey(key.sessionId);
    const inflight = this.inFlight.get(bucketKey)?.get(key.commandId);
    if (inflight) return await inflight.final;
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    if (live) return live.ack;
    const settled = this.settled.get(bucketKey)?.get(key.commandId);
    if (settled) {
      this.touchSettled(bucketKey, key.commandId, settled);
      return settled;
    }

    for (const lookup of [
      this.host.lookupTranscriptCommand,
      this.host.lookupTimelineCommand,
      this.host.lookupChildCommand,
      this.host.lookupDiscardedCommand,
    ]) {
      const found = await lookup?.(key);
      if (found) return found;
    }
    return null;
  }

  private decide(
    envelope: CommandEnvelope,
  ): { kind: "execute"; ack: CommandAck } | { kind: "ack"; ack: CommandAck; remember: boolean } {
    const revision = envelope.sessionId === null ? 0 : this.host.getRevision(envelope.sessionId);
    if (revision === null || (envelope.type !== "createSession" && envelope.sessionId === null)) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "proto.sessionNotFound",
          revisionAtDecision: 0,
        },
      };
    }

    if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
      if (envelope.baseRevision === undefined) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "rejected",
            reasonCode: "proto.missingBaseRevision",
            revisionAtDecision: revision,
          },
        };
      }
      const logEpoch =
        envelope.sessionId === null ? null : this.host.getLogEpoch(envelope.sessionId);
      if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch !== logEpoch) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleLogEpoch",
            revisionAtDecision: revision,
          },
        };
      }
      if (envelope.baseRevision !== revision) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleRevision",
            revisionAtDecision: revision,
          },
        };
      }
    }

    const targetDecision = this.host.validateRowTarget?.(envelope);
    if (targetDecision?.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (targetDecision?.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }

    const decision = this.host.guard?.(envelope) ?? {
      verdict: "allow" as const,
    };
    if (decision.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "noop") {
      return {
        kind: "ack",
        remember: true,
        ack: {
          commandId: envelope.commandId,
          status: "noop",
          reasonCode: decision.reasonCode,
          revisionAtDecision: revision,
          result: decision.result,
        },
      };
    }
    return {
      kind: "execute",
      ack: {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: revision,
      },
    };
  }

  private retryAck(ack: CommandAck): CommandAck {
    // failed is a final-state fact; it must not be overwritten by duplicate status and mislead UI/services into treating it as acceptable.
    return ack.status === "failed" ? ack : { ...ack, status: "duplicate" };
  }

  private queryUnavailableAck(key: CommandKey, _error: unknown): CommandAck {
    return {
      commandId: key.commandId,
      status: "failed",
      reasonCode: "fault.command.queryUnavailable",
      revisionAtDecision: key.sessionId === null ? 0 : (this.host.getRevision(key.sessionId) ?? 0),
    };
  }

  private ackOnly(ack: CommandAck): CommandInboxOutcome {
    return { kind: "ack", ack };
  }

  private bucketKey(sessionId: string | null): string {
    return sessionId ?? GLOBAL_BUCKET;
  }

  private keyGateKey(key: CommandKey): string {
    return `${this.bucketKey(key.sessionId)}\0${key.commandId}`;
  }

  private mapFor<T>(store: Map<string, Map<string, T>>, bucketKey: string): Map<string, T> {
    let bucket = store.get(bucketKey);
    if (!bucket) {
      bucket = new Map();
      store.set(bucketKey, bucket);
    }
    return bucket;
  }

  private touchSettled(bucketKey: string, commandId: string, ack: CommandAck): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, ack);
  }

  private rememberSettled(bucketKey: string, commandId: string, ack: CommandAck): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, ack);
    while (bucket.size > PROTOCOL_V4_LIMITS.idempotencyTablePerSession) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
  }

  private extractCommandId(raw: unknown): string {
    if (typeof raw === "object" && raw !== null && "commandId" in raw) {
      const id = (raw as { commandId: unknown }).commandId;
      if (typeof id === "string") return id;
    }
    return "";
  }
}

/** The session id a createSession is for: the payload id of a reservation, else the envelope target. */
function createSessionKey(envelope: CommandEnvelope): string | null {
  const payloadId = (envelope.payload as { sessionId?: unknown } | null)?.sessionId;
  if (typeof payloadId === "string" && payloadId.length > 0) return payloadId;
  return envelope.sessionId;
}
