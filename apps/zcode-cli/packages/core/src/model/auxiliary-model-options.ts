import type { Model, ModelOptions } from "@zcode/contracts";

const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;

/**
 * Auxiliary calls use the lowest publicly available tier and limit the output budget consistently. Tier ordering comes from Model Config;
 * do not infer protocol behavior from names such as disabled/off.
 */
export function auxiliaryModelOptions(model: Model): Required<ModelOptions> {
  return {
    reasoningLevel: model.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, model.optionSpecs.maxOutputTokens.max),
  };
}
