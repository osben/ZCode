import { z } from "zod";

/** User's complete selection for a future model execution; does not represent an already-created Active Model. */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** Public parsing result. Pages may display an incomplete selection; execution entry points must also check selectionIssue. */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

/** Display value for the UI Picker/legacy CLI; not a reversible serialization format for ModelSelection. */
export function formatModelPickerValue(selection: ModelSelection | undefined): string {
  // Represent an unbound value as empty only at the display boundary; actual execution still validates the full ModelSelection.
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

/** Parse only Picker/legacy string boundaries; domain state and protocols must store ModelSelection directly. */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}
