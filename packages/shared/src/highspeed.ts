import { z } from "zod";
import {
  modelExecutionSelectionFallbackReasonSchema,
  type ModelExecutionSelectionFallback,
} from "./model-execution.js";
import type { ModelSelection } from "./model-selection.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";

/**
 * Business error code returned by the acceleration gateway when the card expires mid-turn
 * (HTTP 400 / provider_code=3402).
 * See docs/highspeed/highspeed-card-spec.md: on this code, keep the context and fall back to the
 * original model to finish the turn.
 */
export const HIGHSPEED_CARD_EXPIRED_PROVIDER_ERROR_CODE = "3402";

/**
 * Hidden Built-in Providers of the acceleration card; endpoints and model lists are provided by
 * the ZCode Built-in Provider Config (config/provider/zcode-builtin.json), and only the IDs
 * referenced across layers live here.
 * Split by account family under the same rule as Off-Peak: the card is an extraction of the
 * current account's Coding Plan entitlement and never migrates silently across families.
 */
export const HIGHSPEED_PROVIDER_IDS = {
  zai: "account:zai-highspeed-card",
  bigmodel: "account:bigmodel-highspeed-card",
} as const;

export function resolveHighspeedProviderId(
  family: "zai" | "bigmodel",
): (typeof HIGHSPEED_PROVIDER_IDS)[typeof family] {
  return HIGHSPEED_PROVIDER_IDS[family];
}

/**
 * Decide whether a Selection points at an acceleration-card provider. After the family split this
 * can no longer be compared against a single constant, otherwise a BigModel account's card would
 * be judged "not accelerated" during queue promotion and silently lose the card.
 */
export function isHighspeedProviderId(providerId: string | undefined): boolean {
  if (providerId === undefined) return false;
  return Object.values(HIGHSPEED_PROVIDER_IDS).some((id) => id === providerId);
}

/**
 * Provider contract values of the draw body: the server's highspeed allowlist only accepts the
 * Coding Plan builtin identities
 * (builtin:zai-coding-plan / builtin:bigmodel-coding-plan, confirmed with the server team on
 * 2026-09-17; the "zai" in design-doc examples is an abbreviation, not the production value).
 * Start Plan, Off-Peak, API Keys, and custom providers are outside the allowlist: they must
 * resolve to null and degrade; mapping-then-send is forbidden.
 */
export const HIGHSPEED_DRAW_PROVIDER_IDS = {
  zai: "builtin:zai-coding-plan",
  bigmodel: "builtin:bigmodel-coding-plan",
} as const;

const HIGHSPEED_DRAW_PROVIDER_ID_BY_PROVIDER_ID = new Map<string, string>([
  [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.zai],
  [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.zai],
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.bigmodel],
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, HIGHSPEED_DRAW_PROVIDER_IDS.bigmodel],
]);

/** Resolves the session-selected provider ID into the allowlisted provider value usable in the draw body; returns null on no match. */
export function resolveHighspeedDrawProviderId(providerId: string): string | null {
  return HIGHSPEED_DRAW_PROVIDER_ID_BY_PROVIDER_ID.get(providerId) ?? null;
}

export const highspeedCardSchema = z.object({
  card_id: z.string().min(1),
  task_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

/**
 * Protocol-level card snapshot written into message.data. The version field keeps future
 * extensions able to read old messages leniently.
 */
export const highspeedMessageMetaSchema = z
  .object({
    schemaVersion: z.literal(1),
    cardId: z.string().min(1),
    taskId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    /** Regular Pro/Max decode TPS sampled from the Coding Plan health check when this turn was sent. */
    regularTps: z.number().positive().optional(),
    /** Completion statistics; these fields are written atomically by a single CLI persistence update. */
    outputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    /** Card-level average completion TPS sampled from Highspeed healthy usage after the card expired. */
    highspeedTps: z.number().positive().optional(),
    savedDurationMs: z.number().nonnegative().optional(),
    /** Real duration split aggregated by the CLI from runtime events; when absent the client falls back to a 20/80 estimate. */
    modelDurationMs: z.number().nonnegative().optional(),
    toolDurationMs: z.number().nonnegative().optional(),
    otherDurationMs: z.number().nonnegative().optional(),
    /** When an in-turn accelerated request failed and fell back to the regular model; used only for the projected degradation hint, does not change share statistics. */
    fallbackAt: z.number().int().nonnegative().optional(),
    /** Fallback reason: card expiry or another accelerated request failure; the Renderer picks the hint copy from it, and legacy data without it is treated as card expiry. */
    fallbackReason: modelExecutionSelectionFallbackReasonSchema.optional(),
  })
  .strict();

export const highspeedDrawRequestSchema = z.object({
  task_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const highspeedDrawResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  data: z.object({
    card: highspeedCardSchema.nullable(),
    next_draw_at: z.number().int().nonnegative(),
  }),
});

export const highspeedHealthyResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  data: z.object({
    card_id: z.string().min(1),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    duration_seconds: z.number().int().nonnegative(),
  }),
});

export type HighspeedCardApi = z.infer<typeof highspeedCardSchema>;
export type HighspeedMessageMeta = z.infer<typeof highspeedMessageMetaSchema>;
export type HighspeedDrawRequest = z.infer<typeof highspeedDrawRequestSchema>;
export type HighspeedDrawResponse = z.infer<typeof highspeedDrawResponseSchema>;
export type HighspeedHealthyResponse = z.infer<typeof highspeedHealthyResponseSchema>;

export interface HighspeedCardUsage {
  cardId: string;
  promptTokens: number;
  completionTokens: number;
  durationSeconds: number;
}

export interface HighspeedCardSnapshot {
  cardId: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
}

export type HighspeedPrepareFallbackReason =
  | "automation"
  | "cooldown"
  | "draw-miss"
  | "draw-timeout"
  | "expired"
  | "foreign-card"
  | "no-coding-plan"
  | "unavailable";

export interface HighspeedPrepareTurnParams {
  taskId: string;
  /**
   * Provider ID of the session's model selection. The draw body's provider contract is the
   * allowlisted Coding Plan builtin identity
   * (builtin:zai-coding-plan / builtin:bigmodel-coding-plan), resolved by the service layer before
   * sending; callers must not pass the allowlisted value directly or forward the full providerId
   * up the wire (the server allowlist rejects it with the 3001 parameter error).
   */
  providerId: string;
  /**
   * The session's currently selected model. Beyond the provider allowlist, the model must also
   * belong to the selected Coding Plan provider's model catalog (a Built-in Provider Config
   * projection) before a new draw is issued; a stale (coding-plan provider, retired model) pair
   * degrades to unavailable (spec §3 rule 14).
   */
  model: string;
  /**
   * The session's active reasoning level. Acceleration swaps the endpoint, not the model, so the
   * card's modelSelection must carry the same reasoningLevel as the session; otherwise the CLI
   * Registry judges the execution selection reasoning-level-missing for lacking a level and throws
   * "Reasoning level is required", failing the whole turn send.
   * Omit when the model has no reasoning levels (no options written).
   */
  reasoningLevel?: string;
  /** Marks only that this turn was dispatched by Automation; the Task's sticky cronAutomationId must not be substituted. */
  automationId?: string;
  waitBudgetMs?: number;
}

/**
 * Per-turn accelerated execution material. Static facts (endpoint, API shape, model capabilities)
 * come from the Built-in Provider Config; this carries only "which model this turn selected" and
 * "the dynamic auth of this execution". Re-delivering provider definitions is forbidden.
 */
export interface HighspeedTurnExecution {
  modelSelection: ModelSelection;
  requestAuth: { apiKey: string; headers: Record<string, string> };
  /**
   * On any accelerated-request failure, fall back to the original model to finish the turn; card
   * expiry (3402) and other failures get different reasons per the rules.
   * The fallback `target` is the committed selection at draw time (the session's original model +
   * level); the CLI prefers it and only falls back to the session's resident selection when absent.
   */
  selectionFallback: ModelExecutionSelectionFallback;
}

export type HighspeedPrepareTurnResult =
  | {
      kind: "accelerated";
      card: HighspeedCardSnapshot;
      nextDrawAt: number;
      /** Mocks keep only the acceleration business semantics; omitting this field keeps using the session's regular inference routing. */
      execution?: HighspeedTurnExecution;
    }
  | {
      kind: "fallback";
      reason: HighspeedPrepareFallbackReason;
      card?: HighspeedCardSnapshot;
      nextDrawAt: number | null;
    };

export interface HighspeedServiceSnapshot {
  card: HighspeedCardSnapshot | null;
  nextDrawAt: number | null;
  drawing: boolean;
}

export type HighspeedMockScenario =
  | "hit-fast"
  | "miss"
  | "hit-after-timeout"
  | "existing-foreign-task-card"
  | "expired-card";
