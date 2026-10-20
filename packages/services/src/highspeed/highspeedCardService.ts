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
import type { IHighspeedCardService } from "./highspeedCard.js";

export { createHighspeedHttpTransport } from "./highspeedHttpTransport.js";

export interface HighspeedServiceTransport {
  draw(request: HighspeedDrawRequest): Promise<HighspeedDrawResponse>;
  healthy(cardId: string): Promise<HighspeedCardUsage>;
}

/**
 * Dynamic auth material for accelerated inference. Acceleration goes through the /api/v1/highspeed/ gateway
 * and shares draw's Coding Plan dual-JWT contract: the zcode JWT identifies session identity, while the Coding
 * Plan business JWT plus Team identity headers verify plan entitlement.
 * These fields must come from the same selected-connection resolution; splicing across families is forbidden
 * (pairing a ZAI JWT with a BigModel key is rejected server-side at token issuance).
 */
export interface HighspeedInferenceAuth {
  zcodeJwt: string;
  family: "zai" | "bigmodel";
  codingPlanAuthorization: string;
  targetType: "PERSONAL" | "TEAM";
  organizationId?: string;
  projectId?: string;
}

export interface HighspeedCardServiceOptions {
  transport: HighspeedServiceTransport;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  /**
   * Dynamic auth material for accelerated inference. Acceleration cards are split by account family and never
   * migrate silently across families; must reuse the same selected-connection resolution as draw.
   * The default fixture serves local tests only.
   */
  resolveInferenceAuth?: () => Promise<HighspeedInferenceAuth>;
  /** A mocked draw only verifies business state; messages still go through the session's ordinary inference routing. */
  inferenceMode?: "highspeed" | "session-default";
  /** draw is only available to Coding Plan users; the default treats it as supported to keep mock and existing-test semantics. */
  resolveCodingPlanSupported?: () => Promise<boolean>;
  /**
   * The session model must belong to the selected Coding Plan provider's model catalog before a new draw may start (spec §3 rule 14);
   * the default treats it as covered to keep mock and existing-test semantics. Resolution errors count as not covered, preventing stale combinations from hitting the draw API.
   */
  resolveModelCovered?: (providerId: string, modelId: string) => Promise<boolean>;
}

const DEFAULT_WAIT_BUDGET_MS = 1000;
/**
 * Cooldown entered after a draw rejection that a send actually observed within its budget (spec §3 rule 16).
 * Without it, a persistently rejected draw (2026-10-19 production: HTTP 400 code=3001 on every draw) was
 * re-issued by every following send, each paying the failing request's full latency before falling back.
 * A late background rejection no turn observes must NOT set this — the next send still redraws (CR-01).
 */
const DRAW_FAILURE_RETRY_BACKOFF_MS = 60_000;

type SendBudgetOutcome<T> = { kind: "settled"; value: T } | { kind: "timeout" };
/** Races an await against the current prepareTurn's send budget; exhausting the budget only ends the wait and never cancels the request. */
type SendBudget = <T>(task: Promise<T>) => Promise<SendBudgetOutcome<T>>;

/**
 * Coding Plan dual JWT + Team identity headers. draw and accelerated inference share the same /api/v1/highspeed/
 * gateway and the same auth middleware: both must carry exactly identical Coding Plan credentials; accelerated
 * inference only adds the card ID on top.
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
    // The API contract requires the Bearer prefix; the credential store may hold a bare token, so normalize here.
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
 * Builds the selection and dynamic auth material for one accelerated execution. Static facts such as endpoint,
 * API shape, and model capabilities come from the ZCode Built-in Provider Config; provider definitions must never
 * be sent down again per individual message.
 */
export function buildHighspeedTurnExecution(params: {
  card: HighspeedCardSnapshot;
  auth: HighspeedInferenceAuth;
  /**
   * The submit-time selection at draw time (session's original model + reasoning level). Acceleration swaps the
   * endpoint, not the model, so the execution selection reuses that level; otherwise the CLI Registry rejects the
   * turn for a missing level. It is also the downgrade return target and must be sent along with selectionFallback.
   */
  sessionSelection: ModelSelection;
}): HighspeedTurnExecution {
  const providerId = resolveHighspeedProviderId(params.auth.family);
  const reasoningLevel = params.sessionSelection.options?.reasoningLevel;
  return {
    modelSelection: {
      providerId,
      // The card echoes the model submitted at request time: acceleration comes from switching endpoints, not models.
      modelId: params.card.model,
      // The execution-scoped selection must be complete: include the session's reasoning level, otherwise the CLI Registry rejects the turn for a missing level.
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
    requestAuth: {
      // Anthropic-compatible clients send x-api-key; the server still adjudicates with Authorization, the Coding Plan dual JWT, and the card ID.
      apiKey: params.auth.zcodeJwt,
      headers: {
        // Bug cause: accelerated inference used to send only the zcode JWT + card ID, but it shares draw's highspeed
        // gateway and auth middleware. Without the Coding Plan dual JWT + Team identity headers the gateway cannot
        // verify plan entitlement and returns 401 auth_failed. Reuse headers identical to draw's and add this execution's card ID.
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
    // Any accelerated-request failure falls back to the session model to finish the turn (spec §2.2): rules match in order,
    // card expiry (3402) gets its own reason so the Renderer can show a distinct message; the catch-all rule carries no error
    // code and covers auth, rate limits, 5xx, network, timeouts, and stream interruptions.
    // The CLI matches only on declarations and never interprets error codes itself; execution handles carrying these
    // declarations get 0 retries in the adapter layer and fall back on the first failure.
    selectionFallback: {
      providerId,
      rules: [
        {
          reason: "highspeed_card_expired",
          providerErrorCode: HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
        },
        { reason: "highspeed_request_failed" },
      ],
      // Bug root cause: the fallback target used to rely only on the CLI's in-memory session-resident selection. After a desktop
      // restart, cold recovery could land in a window where the Registry was just ready but account entitlement was unresolved, so
      // the persisted-selection validation failed and no binding happened; afterwards only accelerated turns were sent, so no binding
      // ever happened either, and card expiry (3402) downgraded silently and the whole turn failed with "highspeed card is invalid".
      // The initiator knows the original model here, so it must send it as the fallback target with the declaration (spec §2.2)
      // instead of betting on runtime state.
      target: params.sessionSelection,
    },
  };
}

export class HighspeedCardService implements IHighspeedCardService {
  private readonly transport: HighspeedServiceTransport;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly resolveInferenceAuth: () => Promise<HighspeedInferenceAuth>;
  private readonly inferenceMode: "highspeed" | "session-default";
  private readonly resolveCodingPlanSupported: () => Promise<boolean>;
  private readonly resolveModelCovered: (providerId: string, modelId: string) => Promise<boolean>;
  private card: HighspeedCardSnapshot | null = null;
  private nextDrawAt: number | null = null;
  private inFlightDraw: Promise<HighspeedDrawResponse> | null = null;

  constructor(options: HighspeedCardServiceOptions) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.resolveInferenceAuth =
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
    // Bug cause: scheduled jobs are background input turns and must not participate in draws for user-initiated sends; the gate
    // must look only at this turn's automationId, never the sticky cronAutomationId on the Task, otherwise manual inputs in the
    // same session would lose acceleration too.
    if (params.automationId?.trim()) {
      return { kind: "fallback", reason: "automation", nextDrawAt: this.nextDrawAt };
    }

    const now = this.now();
    this.expireCard(now);
    // Bug root cause: the 1s budget used to cover only the draw wait, while the gate checks (the model catalog waits for Provider
    // Runtime initialization) and accelerated-auth resolution each awaited outside the budget, so sends hung indefinitely whenever
    // the Registry was not ready or credential resolution stalled.
    // The budget starts when prepareTurn is entered; every await shares the same deadline (spec §3 rule 12).
    const withinBudget = this.createSendBudget(now, params.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);

    if (this.card) {
      return this.prepareWithCard(this.card, params, withinBudget);
    }
    if (this.nextDrawAt !== null && now < this.nextDrawAt) {
      return { kind: "fallback", reason: "cooldown", nextDrawAt: this.nextDrawAt };
    }

    // The draw body's provider contract requires Coding Plan builtin identities from the server's allowlist
    // (builtin:zai-coding-plan / builtin:bigmodel-coding-plan); Start/Off-Peak/API Key/custom providers cannot resolve to an
    // allowlisted value, so downgrade directly instead of sending a request that will certainly be rejected.
    // Regression constraint: never pass the session selection's full providerId (e.g. account:bigmodel-team-coding-plan)
    // or the account family (bigmodel) into the body; both are rejected by the allowlist with a 3001 parameter error.
    const drawProviderId = resolveHighspeedDrawProviderId(params.providerId);
    if (!drawProviderId) {
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }

    // The gate only blocks new draws; in-flight requests were legitimately started earlier and are unaffected by the gate.
    if (!this.inFlightDraw) {
      const gate = await withinBudget(this.checkDrawGates(params.providerId, params.model));
      // A gate that overruns the budget downgrades as not ready (rule 14) without starting a draw; the check itself is not cancelled and warms up the next turn once it finishes.
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

    this.applyDrawResponse(outcome.value);
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

  healthy(cardId: string): Promise<HighspeedCardUsage> {
    return this.transport.healthy(cardId);
  }

  /**
   * Gates for a new draw: rule 14 model catalog and rule 11 Coding Plan support, evaluated in order; returns the fallback reason,
   * or null when all pass. Resolution errors count as failing; card, cooldown, and in-flight state stay untouched.
   * A stale (coding-plan provider, retired model) combination restored from session recovery still passes the provider allowlist
   * and must be caught by the model catalog, so invalid combinations or credentials never hit the draw API.
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
   * The deadline is fixed on entering prepareTurn; the timer is lazily created once on demand and reused by every
   * subsequent await. Synchronous downgrade paths (automation / cooldown / outside the allowlist) never create it.
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

  private startDraw(
    params: HighspeedPrepareTurnParams,
    drawProviderId: string,
  ): Promise<HighspeedDrawResponse> {
    const draw = this.transport
      .draw({ task_id: params.taskId, provider: drawProviderId, model: params.model })
      .then((response) => {
        this.applyDrawResponse(response);
        return response;
      })
      .finally(() => {
        if (this.inFlightDraw === draw) this.inFlightDraw = null;
      });
    this.inFlightDraw = draw;
    return draw;
  }

  private applyDrawResponse(response: HighspeedDrawResponse): void {
    const parsed = highspeedDrawResponseSchema.parse(response);
    this.nextDrawAt = parsed.data.next_draw_at;
    this.card = parsed.data.card ? toSnapshot(parsed.data.card) : null;
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
    const auth = await withinBudget(this.resolveInferenceAuth());
    // Auth resolution overran the budget: send this turn normally, reusing draw-timeout semantics ("card was not ready within budget");
    // the card is kept and returned with the result, and the next turn reuses acceleration once auth is ready.
    if (auth.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", card, nextDrawAt: this.nextDrawAt };
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
