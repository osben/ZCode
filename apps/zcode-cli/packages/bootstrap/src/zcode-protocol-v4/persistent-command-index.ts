// Session-scoped lazy index for commands/query.
// Run the loader once per session; merge new transcript/marker/child/discarded facts incrementally through record.
import type { CommandAck, CommandKey } from "@zcode/shared/zcode-protocol-v4";

export type PersistentCommandFactSource = "transcript" | "timeline" | "child" | "discarded";

export interface PersistentCommandIndexSeed {
  workspacePath: string;
  workspaceIdentity?: string;
  facts?: Partial<Record<PersistentCommandFactSource, readonly CommandAck[]>>;
}

export interface PersistentCommandIndexTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface PersistentCommandIndexHost {
  loadSession(sessionId: string): Promise<PersistentCommandIndexSeed | null>;
}

interface SessionIndex {
  workspaceKey: string;
  facts: Record<PersistentCommandFactSource, Map<string, CommandAck>>;
}

function workspaceKey(target: PersistentCommandIndexTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function emptyFacts(): SessionIndex["facts"] {
  return {
    transcript: new Map(),
    timeline: new Map(),
    child: new Map(),
    discarded: new Map(),
  };
}

export class PersistentCommandIndex {
  private readonly sessions = new Map<string, Promise<SessionIndex | null>>();

  constructor(private readonly host: PersistentCommandIndexHost) {}

  async lookup(source: PersistentCommandFactSource, key: CommandKey): Promise<CommandAck | null> {
    if (key.sessionId === null) return null;
    const index = await this.ensureSession(key.sessionId);
    return index?.facts[source].get(key.commandId) ?? null;
  }

  /**
   * Call after transcript append, marker settlement, child creation, or discarded-ledger write; do not rescan everything.
   * Reject explicitly when the expected target differs from the workspaceKey from the initial load, preventing same-path remote cross-wiring.
   */
  async record(
    target: PersistentCommandIndexTarget,
    sessionId: string,
    source: PersistentCommandFactSource,
    ack: CommandAck,
  ): Promise<void> {
    const index = await this.ensureSession(sessionId);
    if (!index) throw new Error("fault.command.querySessionNotFound");
    if (index.workspaceKey !== workspaceKey(target)) {
      throw new Error("fault.command.queryForeignWorkspace");
    }
    index.facts[source].set(ack.commandId, ack);
  }

  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensureSession(sessionId: string): Promise<SessionIndex | null> {
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      pending = this.host.loadSession(sessionId).then((seed) => {
        if (!seed) return null;
        const facts = emptyFacts();
        for (const source of ["transcript", "timeline", "child", "discarded"] as const) {
          for (const ack of seed.facts?.[source] ?? []) facts[source].set(ack.commandId, ack);
        }
        return { workspaceKey: workspaceKey(seed), facts };
      });
      // Do not cache a rejected Promise on read failure; the next query can retry after the store recovers.
      pending.catch(() => {
        if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
      });
      pending.then(
        (index) => {
          // unknown/session-not-found are not facts and must not be cached; later persisted transcript entries must become visible.
          if (index === null && this.sessions.get(sessionId) === pending) {
            this.sessions.delete(sessionId);
          }
        },
        () => {},
      );
      this.sessions.set(sessionId, pending);
    }
    return pending;
  }
}
