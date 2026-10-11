import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

/**
 * Reason an execution Selection falls back to the Session Selection. Declared by the initiator in
 * selectionFallback rules; the CLI only passes through the matched rule's reason and does not
 * interpret provider error codes on its own.
 */
export const modelExecutionSelectionFallbackReasonSchema = z.enum([
  "highspeed_card_expired",
  "highspeed_request_failed",
]);

/** Text and attachment sends share execution constraints; credentials belong to a single execution and are not part of Session configuration. */
export const modelExecutionSchema = z
  .object({
    memoryExtraction: z.literal("skip").optional(),
    selectionScope: z.literal("execution"),
    requestAuth: z
      .object({
        apiKey: z.string().min(1).optional(),
        apiKeyId: z.string().trim().min(1).optional(),
        accountScope: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        headers: z.record(z.string().min(1), z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        foregroundModel: z.literal("submission"),
        background: z.literal("deny"),
      })
      .strict()
      .optional(),
    /**
     * When this execution's Selection fails, fall back to the original model within the same Turn
     * and finish the turn, instead of failing the whole turn.
     * Trigger conditions are declared by the initiator: `providerId` restricts matching to the
     * provider this turn's execution Selection points at; `rules` match in declared order and the
     * first hit decides the fallback reason; an omitted `providerErrorCode` means any failure of
     * that provider (except user cancellation and context-window overflow). The CLI does not
     * hard-code provider id prefixes, model names, or error text.
     * The fallback target is `target` first (the submission selection at card-draw time, i.e. the
     * session's original model), then the runtime's resident session Selection: the execution
     * scope never rewrites the session selection, but the resident selection lives only in runtime
     * memory and may be unbound under cold-restore races, so the initiator must declare `target`
     * (docs/highspeed/highspeed-card-spec.md §2.2).
     */
    selectionFallback: z
      .object({
        providerId: z.string().min(1),
        rules: z
          .array(
            z
              .object({
                reason: modelExecutionSelectionFallbackReasonSchema,
                providerErrorCode: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1),
        target: modelSelectionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelExecution = z.infer<typeof modelExecutionSchema>;
export type ModelExecutionSelectionFallback = NonNullable<ModelExecution["selectionFallback"]>;
export type ModelExecutionSelectionFallbackRule = ModelExecutionSelectionFallback["rules"][number];
export type ModelExecutionSelectionFallbackReason = z.infer<
  typeof modelExecutionSelectionFallbackReasonSchema
>;
