import { z } from "zod";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";

const complete = completeModelConfigDataSchema.shape;
// Manual mode freezes only leaves explicitly exposed by the product; newly added system fields are not part of personal manual config by default.
export const manualModelConfigSchema = completeModelConfigDataSchema
  .pick({ enabled: true })
  .extend({
    enabled: modelConfigDataSchema.shape.enabled,
    properties: complete.properties
      .pick({
        contextWindow: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: true,
        supportsMidConversationSystem: true,
      })
      .extend({
        inputFormat: complete.properties.shape.inputFormat.pick({
          supportsImage: true,
          supportsVideo: true,
          supportsPdf: true,
        }),
      }),
    optionSpecs: complete.optionSpecs.pick({ reasoningLevel: true }).extend({
      maxOutputTokens: complete.optionSpecs.shape.maxOutputTokens.pick({ max: true }),
    }),
  });

export type ManualModelConfig = z.infer<typeof manualModelConfigSchema>;

/** Draft/legacy complete-rule extraction reuses the schema structure to avoid maintaining a second editable-field list. */
export function extractManualModelConfig(input: unknown): ManualModelConfig {
  return manualModelConfigSchema.parse(pickSchemaFields(manualModelConfigSchema, input));
}

/** Preserve standalone enabled and system leaves; restoring intelligent config and rule merging both use the same field ownership. */
export function clearManualModelConfig(input: z.infer<typeof modelConfigDataSchema>) {
  const cleared = modelConfigDataSchema.parse(
    omitSchemaFields(manualModelConfigSchema.omit({ enabled: true }), input),
  );
  // reasoningLevel.default is catalog-owned, not an editable leaf: keep the inherited value so a manual rule overlays on it.
  // EnumOptionSpecConfig.overlay still drops it when the rule's own values no longer include it.
  const inheritedDefault = input.optionSpecs?.reasoningLevel?.default;
  if (inheritedDefault === undefined) return cleared;
  return modelConfigDataSchema.parse({
    ...cleared,
    optionSpecs: {
      ...cleared.optionSpecs,
      reasoningLevel: { ...cleared.optionSpecs?.reasoningLevel, default: inheritedDefault },
    },
  });
}

/**
 * reasoningLevel.default is fork-only and catalog-owned. Upstream's strict shared-file schema rejects the whole
 * provider_config.json when it is present, so personal model rules drop it on both parse and serialize.
 */
export function omitCatalogOwnedOptionFields(input: unknown): unknown {
  if (!isRecord(input)) return input;
  return {
    ...input,
    ...(Array.isArray(input.providerModelRules)
      ? { providerModelRules: input.providerModelRules.map(omitRuleDefault) }
      : {}),
    ...(Array.isArray(input.manualProviderModelRules)
      ? { manualProviderModelRules: input.manualProviderModelRules.map(omitRuleDefault) }
      : {}),
  };
}

function omitRuleDefault(rule: unknown): unknown {
  if (!isRecord(rule) || !isRecord(rule.config)) return rule;
  const optionSpecs = rule.config.optionSpecs;
  if (!isRecord(optionSpecs) || !isRecord(optionSpecs.reasoningLevel)) return rule;
  if (!("default" in optionSpecs.reasoningLevel)) return rule;
  const { default: _catalogDefault, ...reasoningLevel } = optionSpecs.reasoningLevel;
  return {
    ...rule,
    config: { ...rule.config, optionSpecs: { ...optionSpecs, reasoningLevel } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitSchemaFields(schema: z.ZodObject, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const child = schema.shape[key];
      if (!child) return [[key, value]];
      if (!(child instanceof z.ZodObject) || value == null) return [];
      const remaining = omitSchemaFields(child, value);
      return remaining && typeof remaining === "object" && Object.keys(remaining).length
        ? [[key, remaining]]
        : [];
    }),
  );
}

function pickSchemaFields(schema: z.ZodObject, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(schema.shape).flatMap(([key, child]) => {
      if (!(key in source)) return [];
      return [
        [key, child instanceof z.ZodObject ? pickSchemaFields(child, source[key]) : source[key]],
      ];
    }),
  );
}
