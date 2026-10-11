// Command inbox: unified command admission and query entry point.
// Keep three kinds of facts separate: in-flight/live input is always pinned; only settled entries enter the 512/session LRU.
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

/** Guard decision: reject (revert optimistic state) or noop (silently finalize a late request, §6.3). */
export type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

type PersistentLookup = (key: CommandKey) => Promise<CommandAck | null> | CommandAck | null;

export interface CommandInboxHost {
/** Current session revision; return null for an unknown session (createSession uses a null sessionId). */
  getRevision(sessionId: string): number | null;
/** Current projection generation for the session; CAS must check epoch before revision. */
  getLogEpoch(sessionId: string): string | null;
/** Resolve row-targeting command entity/action against the same source of truth. */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
/** Business guard (product-protocol guard ID). Allow by default. */
  guard?(envelope: CommandEnvelope): GuardDecision;
/** The callback order below defines persisted-fact precedence; implementations must match sourceCommandId exactly. */
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
/** Authoritative order assigned by serialized CLI admission; use it to construct ConversationInputIntent. */
      admissionSeq: number;
      admittedAt: number;
      queueItemId: string;
/** Fill in the terminal state after execution. Must be called once to release the per-session admission gate. */
      settle: (final: CommandFinal) => void;
    };

// createSession and queries with a null sessionId belong to the global bucket.
const GLOBAL_BUCKET = "@global";

export function queueItemIdForCommand(commandId: string): string {
  return `queue_${commandId}`;
}

type GateRelease = () => void;

/**
 * FIFO async gate. Return an explicit release because the per-session gate must span gateway
 * execution and remain held until settlement; a regular with-lock would admit the next command as
 * soon as the handler returns.
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

  constructor(private readonly host: CommandInboxHost) {}

  async handle(raw: unknown): Promise<CommandInboxOutcome> {
    const parsed = parseCommandEnvelope(raw);
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

      // Keep lock order fixed: key gate → per-session admission gate. Hold the session gate until
      // settlement so different commandIds in one session are serialized in the order the CLI
      // actually admits them.
      const releaseSession = await this.sessionGates.acquire(bucketKey);
      try {
        // While waiting for the session gate, the previous command may have added persisted facts
        // for this key.
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

        // With more than 512 entries of churn, the old single-table LRU could evict commands still
        // running or queued. A later query then returned unknown and a retry executed them again.
        // Pin the new command before releasing the key gate.
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
            // In-flight duplicates previously received the admission ACK directly, before fork or
            // create had a child result. If the ACK was lost, a retry failed to navigate. Requests
            // for the same key must share this final promise and see the same terminal result
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
      // The execute path released early after pinning; release is idempotent, so other paths release
      // here.
      releaseKey();
    }
  }

  /** The gateway validates the upper-layer schema range of 1..64; query concurrently here while preserving Promise.all input order. */
  async query(
    keys: readonly CommandKey[],
  ): Promise<Array<{ key: CommandKey; result: CommandAck | "unknown" }>> {
    return Promise.all(keys.map((key) => this.queryOne(key)));
  }

  /** Pin the same complete intent after queue/guide admission; settled churn must not affect it. */
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

  /** Unpin when a queued/guide command enters the transcript, is canceled, or fails; its terminal state may then move to the settled LRU. */
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
   * After Resident deactivation, the inbox must return to the CLI cold-start state. Do not clear
   * in-flight/live facts; the caller must use them to guard reclamation. Settled facts can still be
   * loaded from the durable transcript/timeline.
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
    // failed is terminal fact and must not be replaced by duplicate status, which could make the
    // UI or service treat it as accepted.
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
