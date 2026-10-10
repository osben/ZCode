// v4 interaction response registry (native implementation, resolveInteraction).
//
// Background: permissions/AskUserQuestion in conversation-product-protocol are "reverse requests":
// the CLI sends them to the client through context.requestClient and awaits a response. Older clients
// respond with an RPC RESPONSE (resolveClientRequest finalizes by server-N ID). v4 clients do not send
// an RPC response; they issue a forward `resolveInteraction` COMMAND (first response wins; late ones are no-ops).
//
// This registry joins the two response paths. When interaction-broker issues a reverse request, it
// registers a deferred by the business requestId (= v4 interactionId) and races it against
// requestClient. Once the v4 command surface (handlers/interaction-background.ts) receives
// resolveInteraction, it resolves the deferred through this registry; the broker-side Promise.race
// immediately finalizes with the v4 response and aborts the pending reverse RPC.
//
// Layering: this registry only finds the deferred by ID and delivers a response; it does not know
// about permission/userInput schema differences. The broker registers its own resolve callback (the
// closure knows the kind), so the registry treats the response body as opaque.
// Ownership: this file is native v4 infrastructure in the v4 directory. Imports from legacy broker/server
// directories are valid (dependencies may point only from legacy directories to v4).
import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@zcode/shared";

export type V4InteractionAnswer = {
  optionId?: string;
  freeText?: string;
  // (Elicitation response convergence, synchronized with shared command.ts resolveInteraction
  // answer): when action exists, the broker maps accept/decline/cancel exactly; content is passed
  // directly using the legacy userInput response content semantics (preserving multi-question answers and annotations).
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

const ASK_USER_QUESTION_HIDDEN_GRACE_MS = 60_000;
const ASK_USER_QUESTION_AUTO_RESOLUTION_MS = 300_000;
interface V4InteractionRegistryOptions {
  hiddenGraceMs?: number;
  autoResolutionMs?: number;
  now?: () => number;
}

export function resolveV4InteractionRegistryOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): V4InteractionRegistryOptions | undefined {
  if (env.ZCODE_ENV !== "test") return undefined;
  const rawScale = env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]?.trim();
  if (!rawScale) return undefined;
  const scale = Number(rawScale);
  if (!Number.isFinite(scale) || scale < 1 || scale > 1_000) {
    throw new Error(`${ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV} must be between 1 and 1000`);
  }
  return {
    hiddenGraceMs: Math.max(1, Math.round(ASK_USER_QUESTION_HIDDEN_GRACE_MS / scale)),
    autoResolutionMs: Math.max(1, Math.round(ASK_USER_QUESTION_AUTO_RESOLUTION_MS / scale)),
  };
}

export type V4InteractionAutoResolution =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface V4InteractionRegistrationOptions {
  sessionId: string;
  kind: "askUserQuestion" | "other";
  fullAccess?: () => Promise<void>;
  initialAutoResolution?: V4InteractionAutoResolution;
  onAutoResolutionUpdated?: (state: V4InteractionAutoResolution) => void | Promise<void>;
}

interface RegisteredInteraction {
  /** Broker-side callback: map a v4 answer to the response required by its schema and resolve the reverse request. */
  resolve: (answer: V4InteractionAnswer) => void;
  options?: V4InteractionRegistrationOptions;
  autoResolution?: V4InteractionAutoResolution;
  /**
   * Whether this AskUserQuestion is eligible for timing, fixed at registration. Once disabled, it
   * stays false; re-enabling does not apply retroactively to older questions.
   */
  fullAccessPending?: Promise<void>;
  autoResolutionEligible: boolean;
  visibleTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  token: symbol;
}

export class V4InteractionRegistry {
  private readonly pending = new Map<string, RegisteredInteraction>();
  private readonly queuesBySession = new Map<string, string[]>();
  private readonly hiddenGraceMs: number;
  private readonly autoResolutionMs: number;
  private readonly now: () => number;
  private askUserQuestionAutoResolutionEnabled = true;
  private interactionPreferenceCommandApplied = false;

  constructor(options: V4InteractionRegistryOptions = {}) {
    this.hiddenGraceMs = options.hiddenGraceMs ?? ASK_USER_QUESTION_HIDDEN_GRACE_MS;
    this.autoResolutionMs = options.autoResolutionMs ?? ASK_USER_QUESTION_AUTO_RESOLUTION_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Register when the broker starts a reverse request. Return an unregister function for the
   * broker to call in finally, so both v4 and RPC-response completion paths clean up and prevent
   * leaks. Re-registering the same interactionId (for a reannounce retry) replaces the old
   * callback: the broker's race/abort has invalidated the old reverse request, so point to the
   * latest wait.
   */
  register(
    interactionId: string,
    resolve: (answer: V4InteractionAnswer) => void,
    options?: V4InteractionRegistrationOptions,
  ): () => void {
    const previous = this.pending.get(interactionId);
    const token = Symbol(interactionId);
    if (previous) {
      this.clearTimers(previous);
    }
    const entry: RegisteredInteraction = {
      resolve,
      options,
      token,
      autoResolutionEligible:
        previous?.autoResolutionEligible ??
        (options?.kind === "askUserQuestion" ? this.askUserQuestionAutoResolutionEnabled : false),
      ...(previous?.autoResolution || options?.initialAutoResolution
        ? { autoResolution: previous?.autoResolution ?? options?.initialAutoResolution }
        : {}),
    };
    this.pending.set(interactionId, entry);
    if (options && !previous) {
      const queue = this.queuesBySession.get(options.sessionId) ?? [];
      queue.push(interactionId);
      this.queuesBySession.set(options.sessionId, queue);
    }
    if (options) {
      if (entry.autoResolution) {
        if (options.kind === "askUserQuestion" && !entry.autoResolutionEligible) {
          void this.convertToSnoozed(entry);
        } else {
          this.resumeAutoResolution(interactionId, entry);
        }
      } else {
        this.activateHead(options.sessionId);
      }
    }
    return () => {
      const current = this.pending.get(interactionId);
      if (!current || current.token !== token) return;
      this.remove(interactionId, current);
    };
  }

  /**
   * Complete a v4 resolveInteraction command by delivering its response to the waiting broker
   * deferred. Return whether it matched. If there is no match (already answered, unregistered, or
   * unknown id), the command completes successfully and idempotently (proto.alreadyResolved
   * semantics: the first response from multiple clients wins, and late responses are harmless).
   */
  resolve(interactionId: string, answer: V4InteractionAnswer): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry || entry.fullAccessPending) return false;
    // Delete before resolving: resolve may synchronously trigger the broker's finally cleanup and
    // unregister, so this ordering prevents duplicate delivery during re-entry.
    this.remove(interactionId, entry);
    entry.resolve(answer);
    return true;
  }

  /** Responses with permission side effects are available only to registered capabilities for the same session; keep the request on failure so it can be retried. */
  async resolveFullAccess(interactionId: string, sessionId: string): Promise<boolean> {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    if (entry.options?.sessionId !== sessionId || !entry.options.fullAccess) {
      throw new Error("Full access is not supported for this interaction");
    }
    if (entry.fullAccessPending) {
      await entry.fullAccessPending;
      return true;
    }
    const operation = entry.options.fullAccess();
    entry.fullAccessPending = operation;
    try {
      await operation;
      if (this.pending.get(interactionId) !== entry) return false;
      this.remove(interactionId, entry);
      entry.resolve({ optionId: "allowOnce" });
      return true;
    } finally {
      delete entry.fullAccessPending;
    }
  }

  /** The first valid action permanently pauses auto-completion for the current AskUserQuestion; repeated or late calls are no-ops. */
  async snoozeAutoResolution(interactionId: string): Promise<boolean> {
    const entry = this.pending.get(interactionId);
    if (
      !entry?.options ||
      entry.options.kind !== "askUserQuestion" ||
      !entry.autoResolution ||
      entry.autoResolution.state === "snoozed"
    ) {
      return false;
    }
    await this.convertToSnoozed(entry);
    return true;
  }

  /**
   * Update the global gate. Disabling it synchronously cancels every timer and waits for active
   * countdowns to persist as snoozed before ACK. Re-enabling allows timing only for questions
   * registered afterward.
   */
  async setAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    this.interactionPreferenceCommandApplied = true;
    return this.applyAskUserQuestionAutoResolutionEnabled(enabled);
  }

  /**
   * The session startup handshake supports old Hosts and initializes the first runtime only. Once
   * an explicit workspace command arrives, a late handshake must not overwrite a newer settings
   * update.
   */
  async initializeAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    if (this.interactionPreferenceCommandApplied) return 0;
    return this.applyAskUserQuestionAutoResolutionEnabled(enabled);
  }

  private async applyAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    this.askUserQuestionAutoResolutionEnabled = enabled;
    if (enabled) return 0;

    const persistence: Promise<void>[] = [];
    let snoozedInteractionCount = 0;
    for (const entry of this.pending.values()) {
      if (entry.options?.kind !== "askUserQuestion") continue;
      entry.autoResolutionEligible = false;
      if (entry.autoResolution && entry.autoResolution.state !== "snoozed") {
        snoozedInteractionCount += 1;
        persistence.push(this.convertToSnoozed(entry));
      }
    }
    await Promise.all(persistence);
    return snoozedInteractionCount;
  }

  has(interactionId: string): boolean {
    return this.pending.has(interactionId);
  }

  /** Resident reclamation check: whether this session still has an interaction awaiting a user response (deactivation would lose the response). */
  hasPendingForSession(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.options?.sessionId === sessionId) return true;
    }
    return false;
  }

  private activateHead(sessionId: string): void {
    const queue = this.queuesBySession.get(sessionId);
    const interactionId = queue?.[0];
    if (!interactionId) return;
    const entry = this.pending.get(interactionId);
    if (
      !entry?.options ||
      entry.options.kind !== "askUserQuestion" ||
      !entry.autoResolutionEligible ||
      entry.autoResolution
    ) {
      return;
    }
    const startedAt = this.now();
    const visibleAt = startedAt + this.hiddenGraceMs;
    const deadlineAt = startedAt + this.autoResolutionMs;
    entry.autoResolution = {
      state: "hiddenGrace",
      startedAt,
      visibleAt,
      deadlineAt,
    };
    this.notifyAutoResolution(entry);
    this.scheduleActiveAutoResolution(interactionId, entry);
  }

  private resumeAutoResolution(interactionId: string, entry: RegisteredInteraction): void {
    const sessionId = entry.options?.sessionId;
    if (!sessionId || this.queuesBySession.get(sessionId)?.[0] !== interactionId) {
      return;
    }
    const autoResolution = entry.autoResolution;
    if (!autoResolution) return;
    if (autoResolution.state === "snoozed") {
      this.notifyAutoResolution(entry);
      return;
    }
    const now = this.now();
    if (now >= autoResolution.deadlineAt) {
      queueMicrotask(() => {
        this.resolve(interactionId, {
          action: "accept",
          content: { answers: {} },
        });
      });
      return;
    }
    if (autoResolution.state === "hiddenGrace" && now >= autoResolution.visibleAt) {
      entry.autoResolution = {
        ...autoResolution,
        state: "visibleCountdown",
      };
    }
    this.notifyAutoResolution(entry);
    this.scheduleActiveAutoResolution(interactionId, entry);
  }

  private scheduleActiveAutoResolution(interactionId: string, entry: RegisteredInteraction): void {
    const autoResolution = entry.autoResolution;
    if (!autoResolution || autoResolution.state === "snoozed") return;
    const now = this.now();
    if (autoResolution.state === "hiddenGrace") {
      entry.visibleTimer = setTimeout(
        () => {
          const current = this.pending.get(interactionId);
          if (current !== entry || current.autoResolution?.state !== "hiddenGrace") {
            return;
          }
          current.autoResolution = {
            state: "visibleCountdown",
            startedAt: autoResolution.startedAt,
            visibleAt: autoResolution.visibleAt,
            deadlineAt: autoResolution.deadlineAt,
          };
          this.notifyAutoResolution(current);
        },
        Math.max(0, autoResolution.visibleAt - now),
      );
    }
    entry.deadlineTimer = setTimeout(
      () => {
        this.resolve(interactionId, {
          action: "accept",
          content: { answers: {} },
        });
      },
      Math.max(0, autoResolution.deadlineAt - now),
    );
  }

  private notifyAutoResolution(entry: RegisteredInteraction): void {
    if (!entry.autoResolution) return;
    void entry.options?.onAutoResolutionUpdated?.(entry.autoResolution);
  }

  private async convertToSnoozed(entry: RegisteredInteraction): Promise<void> {
    const autoResolution = entry.autoResolution;
    if (!autoResolution || autoResolution.state === "snoozed") return;
    this.clearTimers(entry);
    entry.autoResolution = {
      state: "snoozed",
      startedAt: autoResolution.startedAt,
      snoozedAt: this.now(),
    };
    await entry.options?.onAutoResolutionUpdated?.(entry.autoResolution);
  }

  private clearTimers(entry: RegisteredInteraction): void {
    if (entry.visibleTimer) clearTimeout(entry.visibleTimer);
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    delete entry.visibleTimer;
    delete entry.deadlineTimer;
  }

  private remove(interactionId: string, entry: RegisteredInteraction): void {
    this.pending.delete(interactionId);
    this.clearTimers(entry);
    const sessionId = entry.options?.sessionId;
    if (!sessionId) return;
    const queue = this.queuesBySession.get(sessionId);
    if (!queue) return;
    const index = queue.indexOf(interactionId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.queuesBySession.delete(sessionId);
      return;
    }
    this.activateHead(sessionId);
  }
}
