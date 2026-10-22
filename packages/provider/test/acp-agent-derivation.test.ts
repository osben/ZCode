import { describe, expect, it } from "vitest";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplateMap,
  buildAcpPseudoModelConfig,
  createDerivedAcpAgentConfigSource,
  deriveAcpAgentConfigSnapshot,
  describeForkAcpAgentLaunchProblem,
  extractInlineAcpAgentRecords,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  stripInlineAcpProviders,
  type ForkAcpAgentRecord,
  type ForkAcpAgentSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "../src/index.js";

const OPENCODE: ForkAcpAgentRecord = {
  agentId: "opencode",
  providerName: "opencode (ACP)",
  enabled: true,
  command: "/usr/local/bin/opencode",
  args: ["acp"],
  env: { OPENCODE_LOG: "1" },
};

function baseSnapshot(
  personalProviders = ProviderConfigMap.empty(),
  personalModels = ModelConfigRules.empty(),
): ProviderConfigSnapshot {
  return {
    revision: "base",
    zcodeBuiltinRevision: "builtin",
    personalRevision: "personal",
    zcodeBuiltinProviders: ProviderConfigMap.empty(),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders,
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels,
  };
}

const acp = (agents: readonly ForkAcpAgentRecord[]): ForkAcpAgentSnapshot => ({
  revision: "sidecar",
  agents,
});

function resolve(snapshot: ProviderConfigSnapshot) {
  return new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: snapshot.zcodeBuiltinProviders,
    personalProviders: snapshot.personalProviders,
    zcodeBuiltinModelRules: snapshot.zcodeBuiltinModelRules,
    personalModels: snapshot.personalModels,
    accountProviders: ProviderConfigMap.empty(),
  });
}

describe("ACP agents derived from the fork sidecar", () => {
  it("builds a complete pseudo-model config with per-agent context windows", () => {
    const opencode = buildAcpPseudoModelConfig("opencode");
    expect((opencode.properties as { contextWindow: number }).contextWindow).toBe(262144);
    expect(
      (buildAcpPseudoModelConfig("cursor").properties as { contextWindow: number }).contextWindow,
    ).toBe(200000);
    expect(opencode.optionSpecs).toMatchObject({
      reasoningLevel: { values: ["auto"], default: "auto", map: "{}" },
      maxOutputTokens: { max: 32000, map: "{}" },
    });
  });

  it("derives a resolvable, non-executable personal provider per record", () => {
    const derived = deriveAcpAgentConfigSnapshot(baseSnapshot(), acp([OPENCODE]));
    expect(derived.revision).toBe("base#acp:sidecar");
    // Personal CAS writes compare against the raw file revision.
    expect(derived.personalRevision).toBe("personal");
    expect(derived.personalProviders.get("acp:opencode")?.access?.toJSON()).toEqual({
      type: "acp-agent",
      agentId: "opencode",
      command: "/usr/local/bin/opencode",
      args: ["acp"],
      env: { OPENCODE_LOG: "1" },
    });

    const provider = resolve(derived).resolvedProviders.find(
      (item) => item.providerId === "acp:opencode",
    );
    expect(provider?.providerIssues).toEqual([]);
    expect(provider?.providerName).toBe("opencode (ACP)");
    expect(
      provider?.models.map((model) => [model.modelId, model.enabled, model.executable]),
    ).toEqual([["opencode", true, false]]);
  });

  it("keeps the record's enabled flag on the provider rule", () => {
    const derived = deriveAcpAgentConfigSnapshot(
      baseSnapshot(),
      acp([{ ...OPENCODE, enabled: false }]),
    );
    expect(derived.personalProviders.getRule("acp:opencode")?.enabled).toBe(false);
  });

  it("returns the source snapshot unchanged when the sidecar is empty", () => {
    const snapshot = baseSnapshot();
    expect(deriveAcpAgentConfigSnapshot(snapshot, acp([]))).toBe(snapshot);
  });

  it("lets a same-id non-ACP provider win (conflict stays visible as-is)", () => {
    const personal = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          providerName: "Someone else",
          config: { group: "standard-personal", access: { type: "api-key" } },
        },
      ],
    });
    const snapshot = baseSnapshot(personal);
    const derived = deriveAcpAgentConfigSnapshot(snapshot, acp([OPENCODE]));
    expect(derived).toBe(snapshot);
  });

  it("replaces a legacy inline acp-agent rule and its model rules with the sidecar record", () => {
    const personal = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          providerName: "old",
          config: {
            group: "standard-personal",
            access: { type: "acp-agent", agentId: "opencode", command: "old", args: [] },
            personalModelIds: ["opencode"],
          },
        },
      ],
    });
    const models = parsePersonalModelConfigRules({
      providerModelRules: [
        {
          providerId: "acp:opencode",
          modelId: "opencode",
          config: { enabled: false },
        },
      ],
      manualProviderModelRules: [],
    });
    const derived = deriveAcpAgentConfigSnapshot(baseSnapshot(personal, models), acp([OPENCODE]));
    expect(derived.personalProviders.getRule("acp:opencode")?.providerName).toBe("opencode (ACP)");
    expect(derived.personalModels.getExact("acp:opencode", "opencode")?.enabled).toBe(true);
    expect(
      derived.personalModels
        .rules()
        .filter((rule) => "providerId" in rule && rule.providerId === "acp:opencode"),
    ).toHaveLength(1);
  });

  it("forwards change events of both the config source and the sidecar store", async () => {
    const sourceListeners: Array<(reason: string) => void> = [];
    const storeListeners: Array<(reason: string) => void> = [];
    const source: ProviderSource<ProviderConfigSnapshot> = {
      read: async () => baseSnapshot(),
      onDidChange: (listener) => {
        sourceListeners.push(listener);
        return () => {};
      },
    };
    const store: ProviderSource<ForkAcpAgentSnapshot> = {
      read: async () => acp([OPENCODE]),
      onDidChange: (listener) => {
        storeListeners.push(listener);
        return () => {};
      },
    };
    const derived = createDerivedAcpAgentConfigSource(source, store);
    const reasons: string[] = [];
    derived.onDidChange((reason) => reasons.push(reason));
    sourceListeners[0]!("personal:updated");
    storeListeners[0]!("updated");
    expect(reasons).toEqual(["personal:updated", "acp-agents:updated"]);
    expect((await derived.read()).personalProviders.has("acp:opencode")).toBe(true);
  });

  it("reports launch-rule problems with the shared complete schema", () => {
    expect(describeForkAcpAgentLaunchProblem(OPENCODE)).toBeNull();
    expect(describeForkAcpAgentLaunchProblem({ ...OPENCODE, command: "a\nb" })).toMatch(/command/);
    expect(
      describeForkAcpAgentLaunchProblem({ ...OPENCODE, env: { NODE_OPTIONS: "--x" } }),
    ).toMatch(/env/);
  });
});

describe("legacy inline acp-agent providers (migration helpers)", () => {
  const inline = {
    providers: parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          providerName: "opencode (ACP)",
          enabled: false,
          config: {
            group: "standard-personal",
            access: { type: "acp-agent", agentId: "opencode", command: "oc", args: ["acp"] },
            personalModelIds: ["opencode"],
          },
        },
        {
          providerId: "custom-1",
          providerName: "Mine",
          config: { group: "standard-personal", access: { type: "api-key" } },
        },
      ],
    }),
    models: parsePersonalModelConfigRules({
      providerModelRules: [
        {
          providerId: "acp:opencode",
          modelId: "opencode",
          config: buildAcpPseudoModelConfig("opencode"),
        },
      ],
      manualProviderModelRules: [],
    }),
    providerOrder: ["acp:opencode", "custom-1"],
  };

  it("extracts sidecar records from inline rules", () => {
    expect(extractInlineAcpAgentRecords(inline)).toEqual([
      {
        agentId: "opencode",
        providerName: "opencode (ACP)",
        enabled: false,
        command: "oc",
        args: ["acp"],
      },
    ]);
  });

  it("strips the rules, their model rules and their order entries", () => {
    const ids = new Set(["opencode"]);
    const stripped = stripInlineAcpProviders(inline, ids);
    expect(stripped.providers.keys()).toEqual(["custom-1"]);
    expect(stripped.models.rules()).toHaveLength(0);
    expect(stripped.providerOrder).toEqual(["custom-1"]);
    expect(stripInlineAcpProviders(stripped, ids)).toBe(stripped);
  });

  it("keeps acp-agent rules the sidecar does not hold", () => {
    expect(stripInlineAcpProviders(inline, new Set())).toBe(inline);
    expect(stripInlineAcpProviders(inline, new Set(["cursor"]))).toBe(inline);
  });
});
