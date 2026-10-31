// Renderer-side persistent ledger of committed V4 commands.
// It stores only client recovery hints: it takes no part in conversation projection and must never auto-replay from it.
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  resolvePendingCommandWorkspaceKey,
  type PendingCommandClientContext,
} from "@/v4/pendingCommandWorkspace.js";
import { pendingCommandReplayFor, type PendingCommandReplay } from "@/v4/pendingCommandReplay.js";
import { acceptComposerRecentReceipt } from "@/lib/composerRecent.js";
import {
  completePendingTaskDraft,
  markPendingTaskDraftCommand,
  releasePendingTaskDraftCommand,
  readPendingTaskDraft,
  readV4ComposerDraft,
  persistV4ComposerDraft,
  clearV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
export type { PendingCommandReplay } from "@/v4/pendingCommandReplay.js";

export type PendingCommandResolution =
  | "accepted"
  | "duplicate"
  | "authoritative"
  | "failed"
  | "discarded";

export const PENDING_COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
const STORAGE_KEY = "zcode-v4-pending-commands:v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingCommandRecoveryReason = "discarded";

export interface PendingCommandEntry {
  commandId: string;
  clientId: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number;
  replay: PendingCommandReplay;
  clientContext?: PendingCommandClientContext;
  recovery?: PendingCommandRecoveryReason;
  recoveryDismissed?: boolean;
}

export interface PendingCommandReplayRequest {
  type: "sendText" | "sendGoalCommand" | "compact" | "createSession";
  payload: Record<string, unknown>;
  sessionId: string | null;
  baseRevision?: number;
  clientContext?: PendingCommandClientContext;
}

export interface PendingCommandRegistryOptions {
  storage?: StorageLike;
  now?: () => number;
}

type QueryCommands = (params: CommandsQueryParams) => Promise<CommandsQueryResult>;

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function keyOf(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "<global>"}\u0000${commandId}`;
}

function clonePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function isEntry(value: unknown): value is PendingCommandEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PendingCommandEntry>;
  return (
    typeof entry.commandId === "string" &&
    typeof entry.clientId === "string" &&
    (typeof entry.sessionId === "string" || entry.sessionId === null) &&
    typeof entry.issuedAt === "number" &&
    typeof entry.expiresAt === "number" &&
    Boolean(entry.replay) &&
    typeof entry.replay === "object"
  );
}

function isRuntimeLocalDiscard(ack: CommandAck): boolean {
  return (
    ack.reasonCode === "fault.command.inputDiscardedOnRestart" &&
    ack.result?.type === "inputDisposition" &&
    (ack.result.delivery === "queue" || ack.result.delivery === "guide")
  );
}

/**
 * ACK, queue, and transcript each used to keep their own transient state; after a renderer refresh or
 * a lost ACK the UI had cleared with no way to prove CLI admission. This ledger persists the
 * "pending reconciliation hint" before the uplink, and settles it via queue/guided/transcript
 * sourceCommandId or an explicit terminal state; the registry itself never produces authoritative facts.
 */
export class PendingCommandRegistry {
  private readonly storage: StorageLike | undefined;
  private readonly now: () => number;
  private readonly entries = new Map<string, PendingCommandEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly resolutionListeners = new Map<
    string,
    Set<(resolution: PendingCommandResolution) => void>
  >();
  private readonly reconcileInFlight = new Map<string, Promise<void>>();

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? Date.now;
    this.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeResolution(
    commandId: string,
    listener: (resolution: PendingCommandResolution) => void,
  ): () => void {
    const listeners = this.resolutionListeners.get(commandId) ?? new Set();
    listeners.add(listener);
    this.resolutionListeners.set(commandId, listeners);
    return () => {
      const current = this.resolutionListeners.get(commandId);
      current?.delete(listener);
      if (current?.size === 0) this.resolutionListeners.delete(commandId);
    };
  }

  record(
    envelope: CommandEnvelope,
    clientContext?: PendingCommandClientContext,
  ): PendingCommandEntry | null {
    this.pruneExpired();
    const replay = pendingCommandReplayFor(envelope);
    if (!replay) return null;
    const key = keyOf(envelope.sessionId, envelope.commandId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: PendingCommandEntry = {
      commandId: envelope.commandId,
      clientId: envelope.clientId,
      sessionId: envelope.sessionId,
      issuedAt: envelope.issuedAt,
      // TTL anchors to first registration; reload/reconcile must not extend it.
      expiresAt: this.now() + PENDING_COMMAND_TTL_MS,
      replay,
      ...(clientContext ? { clientContext } : {}),
    };
    this.entries.set(key, entry);
    const composer = clientContext?.composer;
    // The first-send recovery hint must be persisted first; on failure refuse the uplink rather than leave an unqueryable pending identity.
    if (!this.commit() && composer?.draftId) {
      this.entries.delete(key);
      throw new Error("composer.draft-storage-unavailable");
    }
    try {
      if (composer?.draftId)
        markPendingTaskDraftCommand(
          composer.scope,
          composer.draftId,
          envelope.commandId,
          envelope.sessionId,
        );
    } catch (error) {
      this.entries.delete(key);
      this.commit();
      throw error;
    }
    return entry;
  }

  list(sessionId: string | null): readonly PendingCommandEntry[] {
    this.pruneExpired();
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort((left, right) => left.issuedAt - right.issuedAt);
  }

  findCommand(commandId: string): PendingCommandEntry | undefined {
    return [...this.entries.values()].find((entry) => entry.commandId === commandId);
  }

  // Called on every streamed frame: iterate directly instead of copying the entry array for one existence check.
  private hasEntriesForSession(sessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  listRecoverable(sessionId: string | null): readonly PendingCommandEntry[] {
    return this.list(sessionId).filter(
      // Compatibility with unknown states already written to localStorage by the first V4 version: it is not an actionable error and must not re-enter the UI.
      (entry) => entry.recovery === "discarded" && !entry.recoveryDismissed,
    );
  }

  settle(sessionId: string | null, commandId: string): void {
    if (!this.entries.delete(keyOf(sessionId, commandId))) return;
    this.commit();
  }

  rejectCommand(sessionId: string | null, commandId: string): void {
    const entry = this.entries.get(keyOf(sessionId, commandId));
    if (entry) this.rejectComposer(entry);
    this.settle(sessionId, commandId);
  }

  dismissRecovery(sessionId: string | null, commandId: string): void {
    const key = keyOf(sessionId, commandId);
    const entry = this.entries.get(key);
    if (!entry?.recovery || entry.recoveryDismissed) return;
    this.entries.set(key, { ...entry, recoveryDismissed: true });
    this.commit();
  }

  applyAck(envelope: CommandEnvelope, ack: CommandAck): void {
    let entry = this.entries.get(keyOf(envelope.sessionId, envelope.commandId));
    if (!entry) return;
    if (entry.replay.kind === "sensitiveDigest") {
      // Interactive answers are not replayable; once a definite ACK arrives, its reconciliation duty is over.
      this.settle(entry.sessionId, entry.commandId);
      return;
    }
    entry = this.remapCreatedSession(entry, ack);
    if (ack.status === "accepted" || ack.status === "duplicate") {
      if (!this.acceptComposer(entry)) return;
      this.clearRecovery(entry);
      this.notifyResolution(entry.commandId, ack.status);
      return;
    }
    if (ack.status === "failed" && ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      this.rejectComposer(entry);
      if (isRuntimeLocalDiscard(ack)) {
        this.notifyResolution(entry.commandId, "discarded");
        this.settle(entry.sessionId, entry.commandId);
        return;
      }
      this.notifyResolution(entry.commandId, "failed");
      this.markRecovery(entry, "discarded");
      return;
    }
    this.rejectComposer(entry);
    this.notifyResolution(entry.commandId, "failed");
    this.settle(entry.sessionId, entry.commandId);
  }

  applyQuery(result: CommandsQueryResult): void {
    for (const item of result.results) {
      let entry = this.entries.get(keyOf(item.key.sessionId, item.key.commandId));
      if (!entry) continue;
      if (item.result === "unknown") {
        // A query may overtake a send still being prepared on the Host; a miss is not a rejection.
        // Settling early would restore already-sent text and drop the settlement subscription for a
        // late ACK. Keep the hint and let an explicit result, the authoritative projection, or the
        // existing TTL close it out.
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.queryUnavailable"
      ) {
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.inputDiscardedOnRestart"
      ) {
        this.rejectComposer(entry);
        if (isRuntimeLocalDiscard(item.result)) {
          this.notifyResolution(entry.commandId, "discarded");
          this.settle(entry.sessionId, entry.commandId);
          continue;
        }
        this.notifyResolution(entry.commandId, "failed");
        this.markRecovery(entry, "discarded");
        continue;
      }
      entry = this.remapCreatedSession(entry, item.result);
      if (entry.replay.kind === "sensitiveDigest") {
        this.settle(entry.sessionId, entry.commandId);
        continue;
      }
      if (item.result.status === "accepted" || item.result.status === "duplicate") {
        if (!this.acceptComposer(entry)) continue;
        this.clearRecovery(entry);
        this.notifyResolution(entry.commandId, item.result.status);
      } else {
        this.rejectComposer(entry);
        this.notifyResolution(entry.commandId, "failed");
        this.settle(entry.sessionId, entry.commandId);
      }
    }
  }

  reconcileSnapshot(snapshot: ConversationSnapshot): void {
    // Bug root cause: every streamed frame rescanned the whole history to collect sourceCommandIds.
    // The scan can only matter when this session still has pending entries or someone awaits a
    // command's settlement; with neither, return immediately — the result is unchanged.
    if (this.resolutionListeners.size === 0 && !this.hasEntriesForSession(snapshot.sessionId)) {
      return;
    }
    const settled = new Set<string>();
    for (const item of snapshot.queue.items) {
      if (item.sourceCommandId) {
        // Treating "entered queue" as still-undelivered meant localStorage was only
        // cleaned at transcript time; after an App/CLI restart the old runtime queue is dropped
        // normally, yet the resend prompt fired anyway. The queue projection is already the CLI's
        // authoritative receipt, so the renderer ingress ledger should settle here.
        settled.add(item.sourceCommandId);
      }
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        settled.add(row.sourceCommandId);
      }
      if (row.kind === "timelineMarker" && row.marker.type === "compact" && row.sourceCommandId) {
        // compact produces no user row; the timeline marker is the authoritative evidence that the maintenance command started executing.
        settled.add(row.sourceCommandId);
      }
    }
    if (settled.size === 0) return;
    let changed = false;
    for (const commandId of settled) {
      const entry = this.entries.get(keyOf(snapshot.sessionId, commandId));
      if (entry && !this.acceptComposer(entry)) continue;
      this.notifyResolution(commandId, "authoritative");
      changed = this.entries.delete(keyOf(snapshot.sessionId, commandId)) || changed;
    }
    if (changed) this.commit();
  }

  private acceptComposer(entry: PendingCommandEntry): boolean {
    const composer = entry.clientContext?.composer;
    if (!composer) return true;
    if (!acceptComposerRecentReceipt(composer, this.storage)) return false;
    try {
      if (composer.draftId && this.ownsPendingDraft(entry)) {
        const workspace = entry.clientContext?.workspace;
        if (!workspace || !entry.sessionId) return false;
        const draft = readV4ComposerDraft(
          workspace.workspacePath,
          workspace.workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          composer.scope,
        );
        // The user may have switched away during first send; the next input still belongs to this
        // session and must not leak into the next task directory. The recovered transport-failure
        // text has been authoritatively accepted, so clear it instead of putting it back into the
        // live conversation input.
        if (draft && entry.replay.kind === "input") {
          const payload = entry.replay.payload;
          const sentText =
            composer.submittedText ??
            (entry.replay.type === "createSession"
              ? (payload.firstInput as { text?: string } | undefined)?.text
              : (payload.displayText ?? payload.text));
          if (
            draft.text !== sentText &&
            !readV4ComposerDraft(
              workspace.workspacePath,
              workspace.workspaceIdentity,
              entry.sessionId,
            ) &&
            !persistV4ComposerDraft(
              workspace.workspacePath,
              workspace.workspaceIdentity,
              entry.sessionId,
              draft,
            )
          )
            return false;
        }
        if (
          !clearV4ComposerDraft(
            workspace.workspacePath,
            workspace.workspaceIdentity,
            V4_DRAFT_SCOPE_ROOT,
            composer.scope,
          )
        )
          return false;
        completePendingTaskDraft(composer.scope, composer.draftId);
      }
      return true;
    } catch {
      return false;
    }
  }

  private rejectComposer(entry: PendingCommandEntry): void {
    const composer = entry.clientContext?.composer;
    if (composer?.draftId)
      releasePendingTaskDraftCommand(composer.scope, composer.draftId, entry.commandId);
  }

  reconcileSession(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    const inFlightKey = JSON.stringify([workspaceKey, sessionId]);
    const existing = this.reconcileInFlight.get(inFlightKey);
    if (existing) return existing;
    const pending = this.runReconcile(sessionId, query, workspaceKey).finally(() => {
      if (this.reconcileInFlight.get(inFlightKey) === pending) {
        this.reconcileInFlight.delete(inFlightKey);
      }
    });
    this.reconcileInFlight.set(inFlightKey, pending);
    return pending;
  }

  consumeReplay(key: {
    sessionId: string | null;
    commandId: string;
  }): PendingCommandReplayRequest | null {
    const entry = this.entries.get(keyOf(key.sessionId, key.commandId));
    if (!entry || entry.replay.kind !== "input") return null;
    const request: PendingCommandReplayRequest = {
      type: entry.replay.type,
      payload: clonePayload(entry.replay.payload),
      sessionId: entry.sessionId,
      ...(entry.replay.baseRevision !== undefined
        ? { baseRevision: entry.replay.baseRevision }
        : {}),
      ...(entry.clientContext ? { clientContext: entry.clientContext } : {}),
    };
    // Bug cause: the first-send admission already persisted the old session, and a confirmed resend
    // reusing the old ID is rejected by the CLI. Drop the ID only when the user confirms generating
    // a new command; retries of the same command keep the original envelope, which also stays
    // compatible with old recovery records.
    if (request.type === "createSession") delete request.payload.sessionId;
    // The user confirmed a resend with a new commandId; the old discarded hint settles locally.
    this.rejectComposer(entry);
    this.settle(entry.sessionId, entry.commandId);
    return request;
  }

  private async runReconcile(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    // The null bucket collects creates from every workspace; query only the Agent the command originally belonged to.
    const entries = this.list(sessionId).filter(
      (entry) =>
        workspaceKey === undefined ||
        resolvePendingCommandWorkspaceKey(entry) === workspaceKey ||
        (sessionId !== null && resolvePendingCommandWorkspaceKey(entry) === null),
    );
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const result = await query({
        commands: batch.map((entry) => ({
          sessionId: entry.sessionId,
          commandId: entry.commandId,
        })),
      });
      this.applyQuery(result);
    }
  }

  private markRecovery(entry: PendingCommandEntry, recovery: PendingCommandRecoveryReason): void {
    if (entry.recovery === recovery) return;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), {
      ...entry,
      recovery,
      recoveryDismissed: false,
    });
    this.commit();
  }

  private clearRecovery(entry: PendingCommandEntry): void {
    if (!entry.recovery && !entry.recoveryDismissed) return;
    const { recovery: _recovery, recoveryDismissed: _dismissed, ...settled } = entry;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), settled);
    this.commit();
  }

  private remapCreatedSession(entry: PendingCommandEntry, ack: CommandAck): PendingCommandEntry {
    if (
      entry.replay.kind !== "input" ||
      entry.replay.type !== "createSession" ||
      (ack.status !== "accepted" && ack.status !== "duplicate") ||
      ack.result?.type !== "createSession" ||
      entry.sessionId === ack.result.sessionId
    ) {
      return entry;
    }
    this.entries.delete(keyOf(entry.sessionId, entry.commandId));
    const remapped = { ...entry, sessionId: ack.result.sessionId };
    this.entries.set(keyOf(remapped.sessionId, remapped.commandId), remapped);
    this.commit();
    return remapped;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (isEntry(value)) {
          this.entries.set(keyOf(value.sessionId, value.commandId), value);
        }
      }
      this.pruneExpired();
    } catch {
      // Corrupted storage must not block chat; what is dropped is a client recovery hint, not a CLI authoritative fact.
      this.entries.clear();
    }
  }

  private ownsPendingDraft(entry: PendingCommandEntry): boolean {
    const composer = entry.clientContext?.composer;
    return Boolean(
      composer?.draftId && readPendingTaskDraft(composer.scope)?.draftId === composer.draftId,
    );
  }

  private pruneExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now && !this.ownsPendingDraft(entry)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  private commit(): boolean {
    let written = Boolean(this.storage);
    if (this.storage) {
      try {
        if (this.entries.size === 0) {
          this.storage.removeItem(STORAGE_KEY);
        } else {
          this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
        }
      } catch {
        // Plain commands keep the existing in-memory fallback; first-send directory handover checks the write result in record.
        written = false;
      }
    }
    for (const listener of this.listeners) listener();
    return written;
  }

  /** First-submission reconciliation decision for listeners only (spec: Reconciliation). */
  reportReconciledResolution(commandId: string, resolution: "accepted" | "failed"): void {
    this.notifyResolution(commandId, resolution);
  }

  private notifyResolution(commandId: string, resolution: PendingCommandResolution): void {
    const listeners = this.resolutionListeners.get(commandId);
    if (!listeners) return;
    this.resolutionListeners.delete(commandId);
    for (const listener of listeners) listener(resolution);
  }
}

export const pendingCommandRegistry = new PendingCommandRegistry();
