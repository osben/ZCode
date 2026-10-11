import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  type ModelSelection,
  type ProviderRegistryServiceSnapshot,
} from "@zcode/provider";
import { legacyReasoningLevelRenames as renames } from "./legacy-reasoning-level-renames.js";

const oldRulesCache = new WeakMap<ModelConfigRules, ModelConfigRules>();

/** Restore known legacy Built-in value ranges only for historical Selections; do not migrate Personal config or relax execution-layer validation. */
export function resolveLegacyReasoningLevel(
  snapshot: ProviderRegistryServiceSnapshot,
  selection: ModelSelection,
): string | undefined {
  const oldLevel = selection.options?.reasoningLevel;
  if (oldLevel !== "off" && oldLevel !== "nothink") return undefined;
  const personal = snapshot.config.personalModels.getExactRule(
    selection.providerId,
    selection.modelId,
  );
  if (
    personal &&
    (personal.type === "manual-provider-model" ||
      personal.config.optionSpecs?.reasoningLevel?.values !== undefined ||
      personal.config.optionSpecs?.reasoningLevel?.map !== undefined)
  )
    return undefined;
  const provider = snapshot.resolution.effectiveProviders.get(selection.providerId);
  if (!provider) return undefined;
  const builtin = snapshot.config.zcodeBuiltinModelRules;
  let oldRules = oldRulesCache.get(builtin);
  if (!oldRules) {
    oldRules = new ModelConfigRules(
      builtin.rules().map((rule) => {
        // Must be the resolved original rule with no site/API restrictions; a newly added site rule with the same name must not inherit the legacy alias accidentally.
        const rename =
          rule.type === "model"
            ? renames.find((entry) => entry.modelMatch === rule.modelMatch)
            : undefined;
        const values = rule.config.optionSpecs?.reasoningLevel?.values;
        return rename && values?.includes("disabled")
          ? {
              ...rule,
              config: rule.config.overlay(
                new ModelConfig({
                  optionSpecs: new ModelOptionSpecsConfig({
                    reasoningLevel: {
                      values: values.map((value) =>
                        value === "disabled" ? rename.oldLevel : value,
                      ),
                    },
                  }),
                }),
              ),
            }
          : rule;
      }),
    );
    oldRulesCache.set(builtin, oldRules);
  }
  // Use the original rule engine for case, prefixes/suffixes, API/site rules, and later overrides; do not duplicate matching logic.
  const values = oldRules.resolve({
    providerId: selection.providerId,
    modelId: selection.modelId,
    templateId: snapshot.resolution.effectiveProviders.getRule(selection.providerId)?.templateId,
    apiType: provider.api?.type,
    baseUrl: provider.api?.baseUrl,
  }).optionSpecs?.reasoningLevel?.values;
  return values?.includes(oldLevel) ? "disabled" : undefined;
}
