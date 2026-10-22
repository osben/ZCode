import { describe, expect, it } from "vitest";
import { parsePersonalModelConfigRules, parsePersonalProviderConfigMap } from "@zcode/provider";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../src/provider-config-file-codec.js";

const ACCESS = {
  type: "acp-agent",
  agentId: "opencode",
  command: "opencode",
  args: ["acp"],
};

const PSEUDO_MODEL_CONFIG = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 262144,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["auto"], default: "auto", map: "{}" },
    maxOutputTokens: { max: 32000, map: "{}" },
  },
};

// The fork no longer writes acp-agent providers to provider_config.json (upstream rejects them;
// see acp-upstream-compat.test.ts). The fork codec must still decode files written by earlier
// fork builds so migrateInlineAcpProviders can move them into the fork sidecar.
describe("provider config file codec with legacy inline acp-agent providers", () => {
  it("still decodes an inline acp provider and its pseudo-model canonically", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          providerName: "opencode (ACP)",
          enabled: true,
          config: {
            group: "standard-personal",
            access: ACCESS,
            personalModelIds: ["opencode"],
          },
        },
      ],
    });
    const models = parsePersonalModelConfigRules({
      providerModelRules: [
        { providerId: "acp:opencode", modelId: "opencode", config: PSEUDO_MODEL_CONFIG },
      ],
      manualProviderModelRules: [],
    });

    const encoded = encodeProviderConfigFile({
      providers,
      models,
      providerOrder: ["acp:opencode"],
    });
    expect(encoded.schemaVersion).toBe(1);

    const decoded = decodeProviderConfigFile(encoded);
    expect(decoded.providers.get("acp:opencode")?.toJSON().access).toEqual(ACCESS);
    expect(decoded.models.getExact("acp:opencode", "opencode")?.toJSON()).toEqual(
      PSEUDO_MODEL_CONFIG,
    );
    expect(decoded.providerOrder).toEqual(["acp:opencode"]);
    // Canonical stability: re-encoding the decoded update reproduces the document.
    expect(encodeProviderConfigFile(decoded)).toEqual(encoded);
  });
});
