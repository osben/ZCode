import { describe, expect, it } from "vitest";
import {
  AcpAgentAccessConfig,
  isAcpAgentAccess,
  ModelConfigRules,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  parseProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
} from "../src/index.js";
import { createRegistryProviderConfig } from "../src/resolver.js";

const OPENCODE_ACCESS = {
  type: "acp-agent" as const,
  agentId: "opencode",
  command: "opencode",
  args: ["acp"],
};

/**
 * Complete config for the synthetic ACP pseudo-model. Mirrors the shape the
 * Settings UI will store: smart-type rule with every system leaf present,
 * a singular "auto" reasoning level and a no-op option map.
 */
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

describe("acp-agent access", () => {
  it("parses and round-trips through the access config class", () => {
    const config = parseProviderConfig({
      group: "standard-personal",
      access: OPENCODE_ACCESS,
      personalModelIds: ["opencode"],
    });
    expect(config.access).toBeInstanceOf(AcpAgentAccessConfig);
    expect(isAcpAgentAccess(config.access)).toBe(true);
    expect(config.access?.toJSON()).toEqual(OPENCODE_ACCESS);
  });

  it("requires command and agentId in the complete shape", () => {
    const incomplete = new AcpAgentAccessConfig({ agentId: "opencode", args: [] });
    const issues = incomplete.validateComplete(["access"]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((issue) => issue.path.join("."))).toContain("access.command");

    const complete = new AcpAgentAccessConfig({
      agentId: "opencode",
      command: "opencode",
      args: ["acp"],
    });
    expect(complete.validateComplete(["access"])).toEqual([]);
  });

  it("rejects unknown keys, invalid env names and non-string args", () => {
    expect(() => parseProviderConfig({ access: { ...OPENCODE_ACCESS, extra: 1 } })).toThrowError();
    expect(() =>
      parseProviderConfig({ access: { ...OPENCODE_ACCESS, env: { "1BAD": "x" } } }),
    ).toThrowError();
    expect(() =>
      parseProviderConfig({ access: { ...OPENCODE_ACCESS, args: ["ok", 42] } }),
    ).toThrowError();
  });

  it("overlays same-type configs field-wise", () => {
    const base = new AcpAgentAccessConfig({
      agentId: "opencode",
      command: "opencode",
      args: ["acp"],
      env: { MOCK_MARKER: "1" },
    });
    const next = new AcpAgentAccessConfig({ command: "/opt/opencode" });
    expect(base.overlay(next).toJSON()).toEqual({
      type: "acp-agent",
      agentId: "opencode",
      command: "/opt/opencode",
      args: ["acp"],
      env: { MOCK_MARKER: "1" },
    });
  });

  it("is accepted for personal providers and still blocked for account providers", () => {
    const personal = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          config: {
            group: "standard-personal",
            access: OPENCODE_ACCESS,
            personalModelIds: ["opencode"],
          },
        },
      ],
    });
    expect(personal.has("acp:opencode")).toBe(true);

    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [
          {
            providerId: "account:acp-test",
            config: { group: "standard-personal", access: OPENCODE_ACCESS },
          },
        ],
      }),
    ).toThrowError(/Access/);
  });
});

describe("acp provider resolution", () => {
  const buildResolution = (access: unknown) => {
    const personalProviders = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          providerName: "opencode (ACP)",
          enabled: true,
          config: { group: "standard-personal", access, personalModelIds: ["opencode"] },
        },
      ],
    });
    const personalModels = parsePersonalModelConfigRules({
      providerModelRules: [
        { providerId: "acp:opencode", modelId: "opencode", config: PSEUDO_MODEL_CONFIG },
      ],
      manualProviderModelRules: [],
    });
    return new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      personalProviders,
      zcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels,
      accountProviders: ProviderConfigMap.empty(),
    });
  };

  it("keeps the provider in Settings without issues, but out of the execution registry", () => {
    const resolution = buildResolution(OPENCODE_ACCESS);
    const provider = resolution.resolvedProviders.find(
      (item) => item.providerId === "acp:opencode",
    );
    expect(provider).toBeDefined();
    expect(provider?.providerIssues).toEqual([]);
    expect(provider?.models).toHaveLength(1);
    const model = provider?.models[0];
    expect(model?.modelId).toBe("opencode");
    expect(model?.enabled).toBe(true);
    // Published to the chat registry only once the execution path lands.
    expect(model?.executable).toBe(false);
    expect(model?.selectable).toBe(false);
    expect(resolution.registryProviders.map((item) => item.providerId)).not.toContain(
      "acp:opencode",
    );
  });

  it("reports a missing command as a provider issue", () => {
    const resolution = buildResolution({ type: "acp-agent", agentId: "opencode", args: ["acp"] });
    const provider = resolution.resolvedProviders.find(
      (item) => item.providerId === "acp:opencode",
    );
    expect(provider?.providerIssues.length).toBeGreaterThan(0);
    expect(provider?.providerIssues.some((issue) => issue.path.join(".").includes("command"))).toBe(
      true,
    );
    expect(provider?.models[0]?.executable).toBe(false);
  });

  it("reports provider-level issues for an ACP provider without a group", () => {
    const personalProviders = new ProviderConfigMap([
      [
        "acp:opencode",
        parseProviderConfig({ access: OPENCODE_ACCESS, personalModelIds: ["opencode"] }),
      ],
    ]);
    const personalModels = parsePersonalModelConfigRules({
      providerModelRules: [
        { providerId: "acp:opencode", modelId: "opencode", config: PSEUDO_MODEL_CONFIG },
      ],
      manualProviderModelRules: [],
    });
    const resolution = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      personalProviders,
      zcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels,
      accountProviders: ProviderConfigMap.empty(),
    });
    const provider = resolution.resolvedProviders.find(
      (item) => item.providerId === "acp:opencode",
    );
    expect(provider).toBeDefined();
    // The ACP branch validates the whole provider (api-less complete schema),
    // so a missing `group` is surfaced instead of silently passing.
    expect(provider?.providerIssues.some((issue) => issue.path.join(".").includes("group"))).toBe(
      true,
    );
    expect(provider?.models[0]?.executable).toBe(false);
  });

  it("keeps complete ACP configs out of the registry-complete schema", () => {
    const config = parseProviderConfig({
      group: "standard-personal",
      access: OPENCODE_ACCESS,
      personalModelIds: ["opencode"],
      api: { type: "anthropic-messages", baseUrl: "https://api.example/v1" },
    });
    const result = createRegistryProviderConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.join(".").includes("access"))).toBe(true);
    }
  });
});
