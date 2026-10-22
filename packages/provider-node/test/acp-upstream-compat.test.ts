import { describe, expect, it } from "vitest";
import {
  ModelConfigRules,
  ProviderConfigMap,
  buildAcpPseudoModelConfig,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
} from "@zcode/provider";
import { encodeProviderConfigFile } from "../src/provider-config-file-codec.js";
import { decodeWithUpstreamSchemas } from "./fixtures/upstream-3.16.1/upstream-decoder.js";

// specs/acp-agent-runtime.md "Storage and upstream compatibility": the upstream build shares
// provider_config.json, so everything the fork writes there must pass upstream's strict schemas.

const ACP_ACCESS = { type: "acp-agent", agentId: "opencode", command: "opencode", args: ["acp"] };

function inlineAcpFile() {
  return encodeProviderConfigFile({
    providers: parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          providerName: "opencode (ACP)",
          enabled: true,
          config: {
            group: "standard-personal",
            access: ACP_ACCESS,
            personalModelIds: ["opencode"],
          },
        },
      ],
    }),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
}

function pseudoModelFile() {
  return encodeProviderConfigFile({
    providers: ProviderConfigMap.empty(),
    models: parsePersonalModelConfigRules({
      providerModelRules: [
        {
          providerId: "custom-1",
          modelId: "opencode",
          config: buildAcpPseudoModelConfig("opencode"),
        },
      ],
      manualProviderModelRules: [],
    }),
    providerOrder: [],
  });
}

function apiKeyFile() {
  return encodeProviderConfigFile({
    providers: parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "custom-1",
          providerName: "Mine",
          enabled: true,
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "test-key" },
            api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
            personalModelIds: ["m"],
          },
        },
      ],
    }),
    models: ModelConfigRules.empty(),
    providerOrder: ["custom-1"],
  });
}

describe("upstream 3.16.1 decoder against fork-written provider_config.json", () => {
  it("accepts an ordinary personal provider (fixture sanity check)", () => {
    expect(() => decodeWithUpstreamSchemas(apiKeyFile())).not.toThrow();
  });

  it("rejects the whole file when a provider uses the fork-only acp-agent access", () => {
    expect(() => decodeWithUpstreamSchemas(inlineAcpFile())).toThrow(/discriminator|type/i);
  });

  it("the shared file never carries the ACP pseudo-model reasoningLevel.default", () => {
    const encoded = pseudoModelFile();

    expect(JSON.stringify(encoded)).not.toContain('"default"');
    expect(() => decodeWithUpstreamSchemas(encoded)).not.toThrow();
  });
});
