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
 * Dynamic auth material for accelerated inference. Acceleration goes through the /api/v1/highspeed/ gateway and
 * reuses draw's Coding Plan dual-JWT contract: the zcode JWT identifies the session identity, while the Coding
 * Plan business JWT + Team identity headers verify plan entitlements.
 * These fields must come from the same selected connection resolution; splicing across Families is forbidden
 * (a ZAI JWT with a BigModel key is only rejected when the server fetches the credential).
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
   * Dynamic auth material for accelerated inference. Acceleration cards are partitioned by account Family and
   * never silently migrate across Families; it must reuse draw's same selected connection resolution. The default
   * fixture serves local tests only.
   */
  resolveInferenceAuth?: () => Promise<HighspeedInferenceAuth>;
  /** On a mock draw, only the business state is verified; messages keep going through the session's current ordinary inference route. */
  inferenceMode?: "highspeed" | "session-default";
  /** draw is only open to Coding Plan users; the default treats it as supported, keeping mock and existing test semantics. */
  resolveCodingPlanSupported?: () => Promise<boolean>;
  /**
   * The session model must belong to the selected Coding Plan Provider's model catalog before a new draw may be
   * issued (spec §3 rule 14); the default treats it as covered, keeping mock and existing test semantics. Check
   * exceptions are treated as failing, so a stale combination never reaches the draw endpoint.
   */
  resolveModelCovered?: (providerId: string, modelId: string) => Promise<boolean>;
}

const DEFAULT_WAIT_BUDGET_MS = 1000;

type SendBudgetOutcome<T> = { kind: "settled"; value: T } | { kind: "timeout" };
/** Races one await against this prepareTurn's send budget; exhausting the budget only ends the wait and never cancels the request. */
type SendBudget = <T>(task: Promise<T>) => Promise<SendBudgetOutcome<T>>;

/**
 * Coding Plan dual JWTs + Team identity headers. draw and accelerated inference go through the same
 * /api/v1/highspeed/ gateway and the same auth middleware: both must carry exactly identical Coding Plan
 * credentials, with acceleration merely attaching the card ID in addition.
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
 * API shape, and model capabilities are provided by the ZCode Built-in Provider Config; sending provider
 * definitions along with each send is forbidden.
 */
export function buildHighspeedTurnExecution(params: {
  card: HighspeedCardSnapshot;
  auth: HighspeedInferenceAuth;
  /**
   * The selection submitted at draw time (the session's original model + thought level). Acceleration swaps the
   * endpoint, not the model; the execution selection inherits its reasoning level, otherwise the CLI Registry
   * would reject the turn for a missing level; it is also the fallback target for degradation and must be sent with selectionFallback.
   */
  sessionSelection: ModelSelection;
}): HighspeedTurnExecution {
  const providerId = resolveHighspeedProviderId(params.auth.family);
  const reasoningLevel = params.sessionSelection.options?.reasoningLevel;
  return {
    modelSelection: {
      providerId,
      // The card echoes the model submitted at request time: acceleration comes from swapping the endpoint, not the model.
      modelId: params.card.model,
      // An execution-scoped selection must be complete: carry the session's reasoning level, otherwise the CLI Registry rejects the turn for a missing level.
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
    requestAuth: {
      // Anthropic-compatible clients send x-api-key; the server still adjudicates with Authorization, the Coding Plan dual JWTs, and the card ID.
      apiKey: params.auth.zcodeJwt,
      headers: {
        // Bug cause: accelerated inference once sent only the zcode JWT + card ID, and since it goes through the
        // same highspeed gateway and the same auth middleware as draw, without the Coding Plan dual JWTs + Team
        // identity headers the gateway could not verify plan entitlements and returned 401 auth_failed. Here we
        // reuse exactly the Coding Plan headers from draw and attach this execution's card ID.
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
    // Any failure of the accelerated request falls back to the session model to finish the turn (spec §2.2): rules
    // match in order; card expiry (3402) gets its own reason so the Renderer can distinguish the prompt; the catch-all
    // rule carries no error code and covers auth, rate limits, 5xx, network, timeout, and stream interruption.
    // The CLI only matches on the declaration and never interprets error codes itself; an execution handle carrying
    // this declaration gets 0 adapter-level retries and falls back on the first failure.
    selectionFallback: {
      providerId,
      rules: [
        {
          reason: "highspeed_card_expired",
          providerErrorCode: HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE,
        },
        { reason: "highspeed_request_failed" },
      ],
      // Bug root cause: the fallback target once depended only on the CLI's in-memory resident session selection.
      // If cold recovery after a desktop restart landed in the window where the Registry had just become ready and
      // account entitlements were unresolved, the persisted selection failed validation and did not bind; later
      // accelerated-only turns would not bind either, so on card expiry (3402) the degradation was silently skipped
      // and the whole turn surfaced "highspeed card is invalid". The initiator knows the original model explicitly
      // here and must send it as the fallback target with the declaration (spec §2.2) instead of betting on runtime state.
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
    // Bug cause: scheduled tasks are background input turns and must not participate in the user-facing proactive
    // draw; the gate must look only at this turn's automationId and never read the sticky cronAutomationId on the
    // Task, otherwise manual input in the same session would also lose acceleration.
    if (params.automationId?.trim()) {
      return { kind: "fallback", reason: "automation", nextDrawAt: this.nextDrawAt };
    }

    const now = this.now();
    this.expireCard(now);
    // Bug root cause: the 1s budget once only wrapped the draw wait, while the gate checks (the model catalog must
    // wait for Provider Runtime initialization) and the accelerated auth resolution were separately awaited outside
    // the budget, so a send could hang indefinitely when the Registry was not ready or credential resolution stalled.
    // The budget starts on entering prepareTurn and all awaits share one deadline (spec §3 rule 12).
    const withinBudget = this.createSendBudget(now, params.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS);

    if (this.card) {
      return this.prepareWithCard(this.card, params, withinBudget);
    }
    if (this.nextDrawAt !== null && now < this.nextDrawAt) {
      return { kind: "fallback", reason: "cooldown", nextDrawAt: this.nextDrawAt };
    }

    // The draw body's provider contract is the Coding Plan builtin identity on the server whitelist
    // (builtin:zai-coding-plan / builtin:bigmodel-coding-plan); Start/Off-Peak/API Key/custom providers cannot
    // resolve to a whitelist value, so degrade directly rather than firing a request the server will surely reject.
    // Regression constraint: never pass the session selection's full providerId (e.g. account:bigmodel-team-coding-plan)
    // or the account Family (bigmodel) into the body — the whitelist rejects both with parameter error 3001.
    const drawProviderId = resolveHighspeedDrawProviderId(params.providerId);
    if (!drawProviderId) {
      return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
    }

    // The gate only blocks new draws; in-flight is a request legitimately started earlier and is not affected by the gate.
    if (!this.inFlightDraw) {
      const gate = await withinBudget(this.checkDrawGates(params.providerId, params.model));
      // A gate that exceeds the budget degrades as not-ready (rule 14) without drawing; the check itself is not
      // cancelled and warms the next round once it completes.
      if (gate.kind === "timeout") {
        return { kind: "fallback", reason: "unavailable", nextDrawAt: this.nextDrawAt };
      }
      if (gate.value) {
        return { kind: "fallback", reason: gate.value, nextDrawAt: this.nextDrawAt };
      }
    }

    const draw = this.inFlightDraw ?? this.startDraw(params, drawProviderId);
    const outcome = await withinBudget(draw);
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
   * Gates for a new draw: rule 14 model catalog and rule 11 Coding Plan support, evaluated in order, returning
   * the fallback reason, or null when all pass. Check exceptions are treated as failing; card, cooldown, and
   * in-flight state are unchanged. A stale (coding-plan provider, delisted model) combination recovered from a
   * session passes the provider whitelist as usual and must be stopped by the model catalog, keeping invalid
   * combinations or invalid credentials away from the draw endpoint.
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
   * The deadline is fixed when entering prepareTurn; the timer is created lazily on demand and only once, with
   * later awaits reusing it. Synchronous degradation paths such as automation / cooldown / off-whitelist never register a timer.
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
    // Auth resolution exceeded the budget: send normally this turn, reusing the draw-timeout semantics ("the card
    // could not become ready within the budget"); the card is kept and returned with the result, and acceleration
    // is reused directly once auth is ready next turn.
    if (auth.kind === "timeout") {
      return { kind: "fallback", reason: "draw-timeout", card, nextDrawAt: this.nextDrawAt };
    }
    // The fallback target is exactly the session selection submitted this time (provider / model / level): it is
    // independent of the card and does not depend on CLI runtime state.
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
