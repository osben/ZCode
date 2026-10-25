import { describe, expect, it } from "vitest";
import { ModelConfig, ModelConfigRules, parsePersonalModelConfigRules } from "../src/index.js";

// specs/fork-provider-config-upstream-compat.md: reasoningLevel.default is catalog-owned and must
// never be persisted to the shared provider_config.json.

const GPT_LEVELS = ["low", "medium", "high"];

function catalogRules() {
  return new ModelConfigRules([
    {
      type: "model",
      modelMatch: ".*gpt-5\\.6.*",
      config: ModelConfig.fromData({
        optionSpecs: { reasoningLevel: { values: GPT_LEVELS, default: "high", map: "{}" } },
      }),
    },
  ]);
}

// Every editable manual leaf is required on a manual rule; only reasoningLevel varies per case.
function manualConfig(reasoningLevel: Record<string, unknown>) {
  return {
    properties: {
      contextWindow: 1234,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
      inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
    },
    optionSpecs: {
      reasoningLevel: { values: GPT_LEVELS, map: "{}", ...reasoningLevel },
      maxOutputTokens: { max: 128 },
    },
  };
}

function manualRule(reasoningLevel: Record<string, unknown>) {
  return { providerId: "p", modelId: "gpt-5.6", config: manualConfig(reasoningLevel) };
}

function resolveWith(personal: ModelConfigRules) {
  const effective = ModelConfigRules.composeEffective(catalogRules(), personal);
  return effective.resolve({ providerId: "p", modelId: "gpt-5.6" }).optionSpecs?.reasoningLevel
    ?.default;
}

describe("catalog-owned reasoning default", () => {
  it("manual rule without a default keeps the catalog default", () => {
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [],
      manualProviderModelRules: [manualRule({})],
    });

    expect(resolveWith(personal)).toBe("high");
  });

  it("manual rule whose values exclude the catalog default resolves without one", () => {
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [],
      manualProviderModelRules: [manualRule({ values: ["low", "medium"] })],
    });

    expect(resolveWith(personal)).toBeUndefined();
  });

  it("toPersonalJSON never emits reasoningLevel.default in either rule list", () => {
    const rules = new ModelConfigRules([
      {
        type: "manual-provider-model",
        providerId: "p",
        modelId: "gpt-5.6",
        config: ModelConfig.fromData(manualConfig({ default: "high" })),
      },
      {
        type: "provider-model",
        providerId: "p",
        modelId: "smart",
        config: ModelConfig.fromData({
          optionSpecs: { reasoningLevel: { values: GPT_LEVELS, default: "medium", map: "{}" } },
        }),
      },
    ]);

    const json = rules.toPersonalJSON();

    expect(json.manualProviderModelRules[0]?.config.optionSpecs?.reasoningLevel).toEqual({
      values: GPT_LEVELS,
      map: "{}",
    });
    expect(json.manualProviderModelRules[0]?.config.optionSpecs?.maxOutputTokens).toEqual({
      max: 128,
    });
    expect(json.providerModelRules[0]?.config.optionSpecs?.reasoningLevel).toEqual({
      values: GPT_LEVELS,
      map: "{}",
    });
  });

  it("parsePersonalModelConfigRules drops a stored default and keeps other leaves", () => {
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [
        {
          providerId: "p",
          modelId: "smart",
          config: { optionSpecs: { reasoningLevel: { values: GPT_LEVELS, default: null } } },
        },
      ],
      manualProviderModelRules: [manualRule({ default: "low" })],
    });

    expect(
      personal.getExactRule("p", "smart")?.config.optionSpecs?.reasoningLevel?.toJSON(),
    ).toEqual({ values: GPT_LEVELS });
    expect(
      personal.getExactRule("p", "gpt-5.6")?.config.optionSpecs?.reasoningLevel?.toJSON(),
    ).toEqual({ values: GPT_LEVELS, map: "{}" });
  });
});
