import {
  resolveHighspeedProviderId,
  resolveHighspeedDrawProviderId,
  highspeedDrawResponseSchema,
  HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
  type HighspeedCardApi,
  type HighspeedCardUsage,
  type HighspeedCardSnapshot,
  type HighspeedDrawRequest,
  type HighspeedDrawResponse,
  type HighspeedPrepareFallbackReason,
  type HighspeedPrepareTurnParams,
  type HighspeedPrepareTurnResult,
  type HighspeedServiceSnapshot,
  type HighspeedTurnExecution,
  type ModelSelection,
} from "@zcode/shared";
import type { IHighspeedCardService } from "#src/highspeed/highspeedCard.js";

export { createHighspeedHttpTransport } from "./highspeedHttpTransport.js";

export interface HighspeedServiceTransport {
  draw(
    request: HighspeedDrawRequest,
    headers?: Record<string, string>,
  ): Promise<HighspeedDrawResponse>;
  healthy(cardId: string, headers?: Record<string, string>): Promise<HighspeedCardUsage>;
}

/**
 * Dynamic auth material for accelerated inference. Acceleration goes through the /api/v1/highspeed/ gateway, sharing draw's
 * Coding Plan dual-JWT contract: the zcode JWT identifies session identity, while the Coding Plan business JWT + Team identity headers verify plan entitlement.
 * These fields must come from the same selected-connection resolution; splicing across families is forbidden
 * (a ZAI JWT paired with a BigModel key is rejected by the server at token issuance).
 */
export interface HighspeedInferenceAuth {
  accountScope?: string;
  ownerKey?: string;
  zcodeJwt: string;
  family: "zai" | "bigmodel";
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}

export interface HighspeedCardServiceOptions {
  transport: HighspeedServiceTransport;
  resolveHealthyIdentity?: () => Promise<{
    ownerKey: string;
    sessionScope: string;
    zcodeJwt: string;
  } | null>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  /**
   * Dynamic auth material for accelerated inference. Acceleration cards are split by account family and never migrate silently across families;
   * must reuse the same selected-connection resolution as draw. The default fixture serves local tests only.
   */
  resolveInferenceAuth?: () => Promise<HighspeedInferenceAuth>;
  /** A mocked draw only verifies business state; messages still go through the session's ordinary inference routing. */
  inferenceMode?: "highspeed" | "session-default";
  /** draw is only available to Coding Plan users; defaults to supported to keep mock and existing-test semantics. */
  resolveCodingPlanSupported?: () => Promise<boolean>;
  /**
   * The session model must belong to the selected Coding Plan provider's model catalog before a new draw may start (spec §3 rule 14);
   * defaults to covered to keep mock and existing-test semantics. Resolution errors count as not covered, so stale combinations never reach the draw API.
   */
  resolveModelCovered?: (providerId: string, modelId: string) => Promise<boolean>;
}

const DEFAULT_WAIT_BUDGET_MS = 1000;
/**
 * Cooldown entered after a draw rejection that a send actually observed within its budget (spec §3 rule 16).
 * Without it, a persistently rejected draw (2026-10-19 production: HTTP 400 code=3001 on every draw) was
 * re-issued by every following send, each paying the failing request's full latency before falling back.
 * A late background rejection no turn observes must NOT set this; the next send still redraws (CR-01).
 */
const DRAW_FAILURE_RETRY_BACKOFF_MS = 60_000;

type SendBudgetOutcome<T> = { kind: "settled"; value: T } | { kind: "timeout" };
/** Races an await against the current prepareTurn send budget; exhausting the budget only ends the wait and never cancels the request. */
type SendBudget = <T>(task: Promise<T>) => Promise<SendBudgetOutcome<T>>;

/**
 * Coding Plan dual JWT + Team identity headers. draw and accelerated inference share the same /api/v1/highspeed/ gateway and auth middleware;
 * both must carry exactly identical Coding Plan credentials, and accelerated inference only adds the card ID.
 */
export function buildHighspeedCodingPlanAuthHeaders(params: {
  zcodeJwt: string;
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}): Record<string, string> {
  const zcodeJwt = params.zcodeJwt.trim();
  const codingPlanAuthorization = params.codingPlanAuthorization.trim();
  if (!zcodeJwt) throw new Error("highspeed request requires zcode jwt");
  if (!codingPlanAuthorization) throw new Error("highspeed request requires Coding Plan jwt");
  if (params.targetType === "TEAM" && (!params.organizationId || !params.projectId)) {
    throw new Error("highspeed team request requires organization and project");
  }
  return {
    Authorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
    // The API contract requires the Bearer prefix; the credential store may hold a bare token, so normalize it here.
    "X-Bigmodel-Authorization": /^Bearer\s/i.test(codingPlanAuthorization)
      ? codingPlanAuthorization
      : `Bearer ${codingPlanAuthorization}`,
    "Bigmodel-Target-Type": params.targetType,
    ...(params.targetType === "TEAM"
      ? {
          "Bigmodel-Organization": params.organizationId!,
          "Bigmodel-Project": params.projectId!,
        }
      : {}),
  };
}

function toSnapshot(card: HighspeedCardApi): HighspeedCardSnapshot {
  return {
    cardId: card.card_id,
    taskId: card.task_id,
    provider: card.provider,
    model: card.model,
    issuedAt: card.issued_at,
    expiresAt: card.expires_at,
  };
}

/**
 * Builds the selection and dynamic auth material for one accelerated execution. Static facts such as endpoint, API shape,
 * and model capabilities come from the ZCode Built-in Provider Config; provider definitions must never be sent per message.
 */
export function buildHighspeedTurnExecution(params: {
  card: HighspeedCardSnapshot;
  auth: HighspeedInferenceAuth;
  /**
   * The submit-time selection (session model + reasoning level). Acceleration swaps the endpoint, not the model, so the execution selection
   * keeps that level, otherwise the CLI Registry rejects the turn for a missing level; it is also the downgrade target and must be sent with selectionFallback.
   */
  sessionSelection: ModelSelection;
}): HighspeedTurnExecution {
  const providerId = resolveHighspeedProviderId(params.auth.family);
  const reasoningLevel = params.sessionSelection.options?.reasoningLevel;
  return {
    modelSelection: {
      providerId,
      // The card echoes the model submitted with the request: acceleration swaps the endpoint, not the model.
      modelId: params.card.model,
      // The execution-scoped selection must be complete: include the session's reasoning level, otherwise the CLI Registry rejects the turn.
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
    requestAuth: {
      // Anthropic-compatible clients send x-api-key; the server still adjudicates with Authorization, the Coding Plan dual JWT, and the card ID.
      apiKey: params.auth.zcodeJwt,
      headers: {
        // Bug cause: accelerated inference used to send only the zcode JWT + card ID, but it shares draw's highspeed gateway and auth middleware.
        // Without the Coding Plan dual JWT + Team identity headers the gateway cannot verify plan entitlement and returns 401 auth_failed.
        // Reuse exactly the same Coding Plan headers as draw, then add this execution's card ID.
        ...buildHighspeedCodingPlanAuthHeaders({
          zcodeJwt: params.auth.zcodeJwt,
          codingPlanAuthorization: params.auth.codingPlanAuthorization,
          targetType: params.auth.targetType,
          ...(params.auth.organizationId ? { organizationId: params.auth.organizationId } : {}),
          ...(params.auth.projectId ? { projectId: params.auth.projectId } : {}),
        }),
        "X-Highspeed-Card-ID": params.card.cardId,
      },
    },
    // Any accelerated-request failure falls back to the session model to finish the turn (spec §2.2): rules match in order; card expiry (3402) gets its own reason
    // so the Renderer can show a distinct message; the catch-all rule has no error code and covers auth, rate limits, 5xx, network, timeouts, and stream interruptions.
    // The CLI matches only on declarations and never interprets error codes itself; handles carrying these declarations get 0 adapter retries and fall back on the first failure.
    selectionFallback: {
      providerId,
      rules: [
        {
          reason: "highspeed_card_expired",
          providerErrorCode: HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
        },
        { reason: "highspeed_request_failed" },
      ],
      // Bug root cause: the fallback target used to rely only on the CLI's in-memory session selection. After a desktop restart, cold recovery could land
      // in the window where the Registry was ready but account entitlement was unresolved, so the persisted-selection check failed without binding; accelerated-only turns never bound
      // either, and on card expiry (3402) the downgrade was skipped silently, failing the turn with "highspeed card is invalid". The initiator knows the original model here,
      // so it must send it as the fallback target with the declaration (spec §2.2) instead of relying on runtime state.
      target: params.sessionSelection,
    },
  };
}

export class HighspeedCardService implements IHighspeedCardService {
  private readonly transport: HighspeedServiceTransport;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  readonly #resolveInferenceAuth: () => Promise<HighspeedInferenceAuth>;
  private readonly inferenceMode: "highspeed" | "session-default";
  private readonly resolveCodingPlanSupported: () => Promise<boolean>;
  readonly #resolveHealthyIdentity: NonNullable<
    HighspeedCardServiceOptions["resolveHealthyIdentity"]
  >;
  private readonly resolveModelCovered: (providerId: string, modelId: string) => Promise<boolean>;
  private card: HighspeedCardSnapshot | null = null;
  private nextDrawAt: number | null = null;
  private credentialScope: string | null = null;
  private inFlightDraw: Promise<HighspeedDrawResponse | null> | null = null;

  constructor(options: HighspeedCardServiceOptions) {
    this.transport = options.transport;
    this.#resolveHealthyIdentity = options.resolveHealthyIdentity ?? (async () => null);
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#resolveInferenceAuth =
      options.resolveInferenceAuth ??
      (async () => ({
        zcodeJwt: "mock-zcode-jwt",
        family: "zai",
        codingPlanAuthorization: "mock-coding-plan-jwt",
        targetType: "PERSONAL",
      }));
    this.inferenceMode = options.inferenceMode ?? "highspeed";
    this.resolveCodingPlanSupported = options.resolveCodingPlanSupported ?? (async () => true);
    this.resolveModelCovered = options.resolveModelCovered ?? (async () => true);
  }

  async prepareTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult> {
    // Bug cause: scheduled jobs are background input turns and must not take part in draws for user-initiated sends; the gate must look only at this turn's
    // automationId, never the sticky cronAutomationId on the Task, otherwise manual input in the same session would also lose acceleration.
    if (params.automationId?.trim()) {
      return { kind: "fallback", reason: "automation", nextDrawAt: this.nextDrawAt };
    }

    const now = this.now();
    this.expireCard(now);
    // Bug root cause: the 1s budget used to cover only the draw wait, so the gate checks (the model catalog waits for Provider Runtime initialization) and
    // accelerated-auth resolution each awaited outside the budget, hanging sends indefinitely when the Registry was not ready or credential resolution stalled.
    // The budget starts on entering prepareTurn; every await shares the same deadline (spec §3 rule 12).
    const withinBudget = this.createSendBudget(now, params.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);

    // The card and cooldown belong to the draw identity; a same-account re-login also changes the scope and must not inherit the previous session's state.
    if (this.credentialScope !== null && this.inferenceMode === "highspeed") {
      const scope = this.credentialScope;
      const auth = await withinBudget(this.#resolveInferenceAuth());
      if (auth.kind === "timeout") {
        return { kind: "fallback", reason: "draw-timeout", nextDrawAt: this.nextDrawAt };
      }
      if (scope !== this.authScope(auth.value)) {
        if (this.credentialScope === scope) this.clearCredentialState();
        return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
      }
    }
    if (this.card) {
      return this.prepareWithCard(this.card, params, withinBudget);
    }
    if (this.nextDrawAt !== null && now < this.nextDrawAt) {
      return { kind: "fallback", reason: "cooldown", nextDrawAt: this.nextDrawAt };
    }

    // The draw body's provider contract requires a Coding Plan builtin identity from the server allowlist
    // （builtin:zai-coding-plan / builtin:bigmodel-coding-plan）；Start/Off-Peak/API Key/
    // (builtin:zai-coding-plan / builtin:bigmodel-coding-plan); Start/Off-Peak/API Key/custom providers cannot resolve to an allowlisted value, so downgrade directly
    // instead of sending a request the server will certainly reject. Regression constraint: never pass the session selection's full providerId
    // (e.g. account:bigmodel-team-coding-plan) or the account family (bigmodel) into the body; the allowlist rejects both with a 3001 parameter error.
    const drawProviderId = resolveHighspeedDrawProviderId(params.providerId);
    if (!drawProviderId) {
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }

    // The gate only blocks new draws; in-flight requests were legitimately started earlier and are unaffected by the gate.
    if (!this.inFlightDraw) {
      const gate = await withinBudget(this.checkDrawGates(params.providerId, params.model));
      // A gate that overruns the budget downgrades as not ready (rule 14) without starting a draw; the check itself is not cancelled and warms up the next turn when it finishes.
      if (gate.kind === "timeout") {
        return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
      }
      if (gate.value) {
        return { kind: "fallback", reason: gate.value, nextDrawAt: this.nextDrawAt };
      }
    }

    const draw = this.inFlightDraw ?? this.startDraw(params, drawProviderId);
    let outcome;
    try {
      outcome = await withinBudget(draw);
    } catch {
      // Spec §3 rule 16: the draw rejection won this send's race, so this send falls back immediately and the
      // service enters the failure cooldown instead of letting every following send re-issue the same doomed
      // request. Only the max wins: a successful draw's next_draw_at (or an earlier cooldown) must not shorten.
      this.nextDrawAt = Math.max(this.nextDrawAt ?? 0, this.now() + DRAW_FAILURE_RETRY_BACKOFF_MS);
      return { kind: "fallback", reason: "draw-failed", nextDrawAt: this.nextDrawAt };
    }
    if (outcome.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", nextDrawAt: this.nextDrawAt };
    }

    if (!outcome.value) {
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }
    if (!this.card) {
      return { kind: "fallback", reason: "draw-miss", nextDrawAt: this.nextDrawAt };
    }
    return this.prepareWithCard(this.card, params, withinBudget);
  }

  async getSnapshot(): Promise<HighspeedServiceSnapshot> {
    this.expireCard(this.now());
    return {
      card: this.card,
      nextDrawAt: this.nextDrawAt,
      drawing: this.inFlightDraw !== null,
    };
  }

  async invalidateCard(cardId: string): Promise<boolean> {
    this.expireCard(this.now());
    if (this.card?.cardId !== cardId) return false;
    // Bug root cause: when the accelerated Provider is found removed from the Registry at creation time, the card stayed in the service and the Renderer kept locking the model selector.
    // The current card is voided by the cardId carried in the event; old events cannot delete a newly drawn card, and the cooldown time is unchanged.
    this.card = null;
    return true;
  }

  async getCurrentOwnerKey(): Promise<string | null> {
    return (await this.#resolveHealthyIdentity())?.ownerKey ?? null;
  }

  async healthy(cardId: string, ownerKey?: string): Promise<HighspeedCardUsage | null> {
    // A card cannot be claimed by the current login; the request uses only an atomic primary identity snapshot whose owner matches.
    if (!ownerKey) return null;
    const identity = await this.#resolveHealthyIdentity();
    if (!identity || identity.ownerKey !== ownerKey) return null;
    const usage = await this.transport.healthy(cardId, {
      Authorization: `Bearer ${identity.zcodeJwt.replace(/^Bearer\s+/i, "")}`,
    });
    const current = await this.#resolveHealthyIdentity();
    return current?.sessionScope === identity.sessionScope && usage.cardId === cardId
      ? usage
      : null;
  }

  /**
   * Gates for a new draw: rule 14 model catalog and rule 11 Coding Plan support, evaluated in order, returning the fallback reason
   * or null when all pass. Resolution errors count as failing; card, cooldown, and in-flight state are left untouched.
   * A stale combination (coding-plan provider, retired model) restored from session recovery still passes the provider allowlist
   * and must be caught by the model catalog, so invalid combinations or credentials never reach the draw API.
   */
  private async checkDrawGates(
    providerId: string,
    modelId: string,
  ): Promise<Extract<HighspeedPrepareFallbackReason, "unavailable" | "no-coding-plan"> | null> {
    if (!(await this.isModelCovered(providerId, modelId))) return "unavailable";
    if (!(await this.isCodingPlanSupported())) return "no-coding-plan";
    return null;
  }

  /**
   * The deadline is fixed when prepareTurn is entered; the timer is created lazily, once, on demand, and reused by later awaits;
   * synchronous downgrade paths (automation / cooldown / outside the allowlist) never register a timer.
   */
  private createSendBudget(startedAt: number, budgetMs: number): SendBudget {
    const deadline = startedAt + budgetMs;
    let expired: Promise<{ kind: "timeout" }> | null = null;
    return <T>(task: Promise<T>) => {
      expired ??= this.wait(Math.max(0, deadline - this.now())).then(() => ({
        kind: "timeout" as const,
      }));
      return Promise.race([task.then((value) => ({ kind: "settled" as const, value })), expired]);
    };
  }

  private async isCodingPlanSupported(): Promise<boolean> {
    try {
      return await this.resolveCodingPlanSupported();
    } catch {
      return false;
    }
  }

  private async isModelCovered(providerId: string, modelId: string): Promise<boolean> {
    try {
      return await this.resolveModelCovered(providerId, modelId);
    } catch {
      return false;
    }
  }

  private authScope(auth: HighspeedInferenceAuth): string {
    // Kept in Host memory only; accountScope, which includes the session revision, distinguishes a same-account re-login with the same JWT.
    return JSON.stringify([
      auth.accountScope,
      auth.zcodeJwt,
      auth.family,
      auth.codingPlanAuthorization,
      auth.targetType,
      auth.organizationId,
      auth.projectId,
    ]);
  }

  private clearCredentialState(): void {
    this.card = null;
    this.nextDrawAt = null;
    this.credentialScope = null;
  }

  private startDraw(
    params: HighspeedPrepareTurnParams,
    drawProviderId: string,
  ): Promise<HighspeedDrawResponse | null> {
    const draw = (async () => {
      const auth = this.inferenceMode === "highspeed" ? await this.#resolveInferenceAuth() : null;
      const scope = auth ? this.authScope(auth) : null;
      const ownerKey = auth?.ownerKey ?? (await this.#resolveHealthyIdentity())?.ownerKey;
      const response = await this.transport.draw(
        { task_id: params.taskId, provider: drawProviderId, model: params.model },
        auth ? buildHighspeedCodingPlanAuthHeaders(auth) : undefined,
      );
      // Reason: a late response from the previous account was once written unconditionally, and the new account's auth was then combined with the old card.
      // The request and cache are bound to the same identity; validate before committing the response, and stale responses change neither the card nor the cooldown.
      if (scope !== null && scope !== this.authScope(await this.#resolveInferenceAuth()))
        return null;
      this.applyDrawResponse(response, scope, ownerKey);
      return response;
    })().finally(() => {
      if (this.inFlightDraw === draw) this.inFlightDraw = null;
    });
    this.inFlightDraw = draw;
    return draw;
  }

  private applyDrawResponse(
    response: HighspeedDrawResponse,
    scope: string | null,
    ownerKey?: string,
  ): void {
    const parsed = highspeedDrawResponseSchema.parse(response);
    this.nextDrawAt = parsed.data.next_draw_at;
    this.card = parsed.data.card
      ? { ...toSnapshot(parsed.data.card), ...(ownerKey ? { ownerKey } : {}) }
      : null;
    this.credentialScope = scope;
    this.expireCard(this.now());
  }

  private expireCard(now: number): void {
    if (this.card && this.card.expiresAt <= now) this.card = null;
  }

  private async prepareWithCard(
    card: HighspeedCardSnapshot,
    params: Pick<HighspeedPrepareTurnParams, "taskId" | "providerId" | "model" | "reasoningLevel">,
    withinBudget: SendBudget,
  ): Promise<HighspeedPrepareTurnResult> {
    if (card.taskId !== params.taskId) {
      return { kind: "fallback", reason: "foreign-card", card, nextDrawAt: this.nextDrawAt };
    }
    if (this.inferenceMode === "session-default") {
      return {
        kind: "accelerated",
        card,
        nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      };
    }
    const auth = await withinBudget(this.#resolveInferenceAuth());
    // Auth resolution overran the budget: send this turn normally, reusing draw-timeout semantics ("card not ready within budget");
    // the card is kept and returned with the result, and the next turn reuses acceleration once auth is ready.
    if (auth.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", card, nextDrawAt: this.nextDrawAt };
    }
    if (this.credentialScope !== this.authScope(auth.value) || this.card !== card) {
      if (this.card === card) this.clearCredentialState();
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }
    // The fallback target is the session selection submitted this turn (provider / model / level): it is independent of the card and does not depend on CLI runtime state.
    const sessionSelection: ModelSelection = {
      providerId: params.providerId,
      modelId: params.model,
      ...(params.reasoningLevel ? { options: { reasoningLevel: params.reasoningLevel } } : {}),
    };
    return {
      kind: "accelerated",
      card,
      nextDrawAt: this.nextDrawAt ?? card.expiresAt,
      execution: buildHighspeedTurnExecution({ card, auth: auth.value, sessionSelection }),
    };
  }
}
