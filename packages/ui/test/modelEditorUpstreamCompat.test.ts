import { ModelConfig, ModelConfigRules } from "@zcode/provider";
import { describe, expect, it } from "vitest";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import { updateModelDraft } from "@/settings/model-provider-section/ProviderModelDraftState.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { personalModelConfigRulesSchema as upstreamPersonalModelConfigRulesSchema } from "../../provider-node/test/fixtures/upstream-3.16.1/rule-data-schema.js";

// specs/fork-provider-config-upstream-compat.md: the Model editor emits the catalog-owned
// reasoningLevel.default for a manual built-in model; the personal write boundary must drop it so
// upstream 3.16.1 still accepts provider_config.json.

const BUILTIN_CONFIG = {
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 128_000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: {
      values: ["low", "medium", "high", "max"],
      default: "high",
      map: "{'reasoning_effort': reasoningLevel}",
    },
    maxOutputTokens: { max: 32_000, map: "{'max_completion_tokens': maxOutputTokens}" },
  },
};

function builtinModelWithCatalogDefault(): ProviderSettingsFormModel {
  return {
    kind: "candidate",
    modelId: "gpt-5.6",
    builtin: true,
    inheritedConfig: { enabled: true, ...structuredClone(BUILTIN_CONFIG) },
    personalConfig: {},
    hasPersonalConfig: false,
    executable: true,
    selectable: true,
    config: structuredClone(BUILTIN_CONFIG),
  };
}

function commitEditorSave(useRecommendedConfig: boolean) {
  const model = builtinModelWithCatalogDefault();
  const draft = updateModelDraft(
    createProviderModelDraftValues(model),
    { useRecommendedConfigValue: useRecommendedConfig, contextWindowValue: "64000" },
    model,
  );
  const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
  if (result.status !== "commit") throw new Error(`editor did not commit: ${result.status}`);
  return result.model;
}

describe("Model editor save stays readable by upstream 3.16.1", () => {
  it("manual save of a built-in model with a catalog default writes rules upstream accepts", () => {
    const committed = commitEditorSave(false);
    // The editor freezes the inherited default into the manual config; the hazard input is real.
    expect(committed.personalConfig.optionSpecs?.reasoningLevel?.default).toBe("high");

    const rules = ModelConfigRules.empty().setExact(
      "openai",
      "gpt-5.6",
      ModelConfig.fromData(committed.personalConfig),
      false,
    );
    const written = rules.toPersonalJSON();

    expect(written.manualProviderModelRules).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain('"default"');
    expect(() => upstreamPersonalModelConfigRulesSchema.parse(written)).not.toThrow();
  });

  it("smart save of the same model writes rules upstream accepts", () => {
    const committed = commitEditorSave(true);

    const written = ModelConfigRules.empty()
      .setExact("openai", "gpt-5.6", ModelConfig.fromData(committed.personalConfig), true)
      .toPersonalJSON();

    expect(JSON.stringify(written)).not.toContain('"default"');
    expect(() => upstreamPersonalModelConfigRulesSchema.parse(written)).not.toThrow();
  });
});
