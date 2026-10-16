import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildChatGptPlanAccountProviderId,
  isChatGptPlanAccountProviderId,
  isChatGptPlanProviderId,
  parseChatGptPlanAccountProviderId,
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountRefreshLockFileName,
  SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
} from "@zcode/shared";
import {
  ChatgptAccountAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
} from "../src/config/index.js";
import {
  createDerivedChatGptPlanConfigSource,
  deriveChatGptPlanAccountConfigSnapshot,
  type ProviderConfigSnapshot,
} from "../src/chatgpt-plan-account-derivation.js";

const BASE_ID = BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan;
const ACCOUNT_A = "a1b2c3d4e5f60718";
const ACCOUNT_B = "b1b2c3d4e5f60718";

function createBaseSnapshot(): ProviderConfigSnapshot {
  const providers = new ProviderConfigMap([
    {
      providerId: BASE_ID,
      providerName: "ChatGPT Plan",
      config: new ProviderConfig({
        access: new ChatgptAccountAccessConfig(),
        builtinModelIds: ["gpt-6.1-sol", "gpt-6-astra"],
      }),
    },
    ["custom-openai", new ProviderConfig({})] as const,
  ]);
  const modelRules = new ModelConfigRules([
    {
      type: "provider-model",
      providerId: BASE_ID,
      modelId: "gpt-6.1-sol",
      config: { enabled: true, properties: { contextWindow: 500000 } } as never,
    },
    {
      type: "template-model",
      templateId: "zai-api",
      modelId: "GLM-5.3",
      config: { enabled: true } as never,
    },
  ]);
  return {
    revision: "rev-1",
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: providers,
    zcodeBuiltinProviderTemplates: ProviderConfigMap.empty(),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: modelRules,
    personalModels: ModelConfigRules.empty(),
  };
}

describe("per-account chatgpt plan provider id helpers", () => {
  it("builds and parses per-account ids and rejects foreign ids", () => {
    const id = buildChatGptPlanAccountProviderId(ACCOUNT_A);
    expect(id).toBe(`account:chatgpt-plan:${ACCOUNT_A}`);
    expect(parseChatGptPlanAccountProviderId(id)).toBe(ACCOUNT_A);
    expect(parseChatGptPlanAccountProviderId(BASE_ID)).toBeNull();
    expect(parseChatGptPlanAccountProviderId("account:chatgpt-plan:not-hex!")).toBeNull();
    expect(isChatGptPlanAccountProviderId(id)).toBe(true);
    expect(isChatGptPlanAccountProviderId(BASE_ID)).toBe(false);
    expect(isChatGptPlanProviderId(BASE_ID)).toBe(true);
    expect(isChatGptPlanProviderId(id)).toBe(true);
    expect(isChatGptPlanProviderId("account:zai-start-plan")).toBe(false);
    expect(() => buildChatGptPlanAccountProviderId("short")).toThrow(/account key/u);
  });

  it("derives credential keys, the index key, and per-account lock file names", () => {
    expect(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY).toBe("oauth:chatgpt:accounts");
    const keys = buildSiwcAccountCredentialKeys(ACCOUNT_A);
    expect(keys.accessToken).toBe(`oauth:chatgpt:${ACCOUNT_A}:access_token`);
    expect(buildSiwcAccountRefreshLockFileName(ACCOUNT_A)).toBe(
      `siwc-chatgpt.${ACCOUNT_A}.refresh`,
    );
  });
});

describe("deriveChatGptPlanAccountConfigSnapshot", () => {
  it("replaces the base entry with per-account entries and clones model rules", () => {
    const snapshot = deriveChatGptPlanAccountConfigSnapshot(createBaseSnapshot(), [
      { accountKey: ACCOUNT_A, providerName: "work@example.com" },
      { accountKey: ACCOUNT_B, providerName: "home@example.com" },
    ]);
    const providers = snapshot.zcodeBuiltinProviders;
    expect(providers.get(BASE_ID)).toBeUndefined();
    const ruleA = providers.getRule(buildChatGptPlanAccountProviderId(ACCOUNT_A));
    expect(ruleA?.providerName).toBe("work@example.com");
    expect(ruleA?.config.access?.type).toBe("chatgpt-account");
    expect(ruleA?.config.builtinModelIds).toContain("gpt-6.1-sol");
    expect(providers.get("custom-openai")).toBeDefined();

    const rules = snapshot.zcodeBuiltinModelRules.rules();
    const exact = rules.filter((rule) => rule.type === "provider-model");
    expect(exact).toHaveLength(2);
    for (const rule of exact) {
      expect(rule.providerId).not.toBe(BASE_ID);
      expect(rule.modelId).toBe("gpt-6.1-sol");
    }
    // Template rules survive untouched.
    expect(rules.some((rule) => rule.type === "template-model")).toBe(true);
  });

  it("suffixes the dedup revision with the account set and keeps the builtin revision raw", () => {
    const base = createBaseSnapshot();
    const accounts = [{ accountKey: ACCOUNT_A, providerName: "work@example.com" }];
    const first = deriveChatGptPlanAccountConfigSnapshot(base, accounts);
    const same = deriveChatGptPlanAccountConfigSnapshot(base, accounts);
    expect(first.revision).toBe(same.revision);
    // The builtin revision is the cross-process contract (account snapshots carry it as
    // basedOnZCodeBuiltinRevision), so it must stay the raw builtin revision.
    expect(first.zcodeBuiltinRevision).toBe(base.zcodeBuiltinRevision);
    const added = deriveChatGptPlanAccountConfigSnapshot(base, [
      ...accounts,
      { accountKey: ACCOUNT_B, providerName: "home@example.com" },
    ]);
    expect(added.revision).not.toBe(first.revision);
    expect(added.zcodeBuiltinRevision).toBe(base.zcodeBuiltinRevision);
    // Account order must not matter for the revision.
    const reordered = deriveChatGptPlanAccountConfigSnapshot(base, [
      { accountKey: ACCOUNT_B, providerName: "home@example.com" },
      { accountKey: ACCOUNT_A, providerName: "work@example.com" },
    ]);
    expect(reordered.revision).toBe(added.revision);
  });

  it("drops the chatgpt family entirely with zero accounts", () => {
    const snapshot = deriveChatGptPlanAccountConfigSnapshot(createBaseSnapshot(), []);
    expect(snapshot.zcodeBuiltinProviders.get(BASE_ID)).toBeUndefined();
    expect(
      [...snapshot.zcodeBuiltinProviders.keys()].some((id) => isChatGptPlanAccountProviderId(id)),
    ).toBe(false);
  });

  it("deduplicates repeated account keys and ignores invalid keys", () => {
    const snapshot = deriveChatGptPlanAccountConfigSnapshot(createBaseSnapshot(), [
      { accountKey: ACCOUNT_A, providerName: "one@example.com" },
      { accountKey: ACCOUNT_A, providerName: "two@example.com" },
      { accountKey: "not-hex-at-all!!", providerName: "bad@example.com" },
    ]);
    const derivedIds = [...snapshot.zcodeBuiltinProviders.keys()].filter((id) =>
      isChatGptPlanAccountProviderId(id),
    );
    expect(derivedIds).toEqual([buildChatGptPlanAccountProviderId(ACCOUNT_A)]);
  });

  it("degrades to no chatgpt entries when account enumeration fails", async () => {
    const source = {
      async read() {
        return createBaseSnapshot();
      },
      onDidChange() {
        return () => {};
      },
    };
    const derived = createDerivedChatGptPlanConfigSource(source, async () => {
      throw new Error("credential store unavailable");
    });
    const snapshot = await derived.read();
    expect(snapshot.zcodeBuiltinProviders.get(BASE_ID)).toBeUndefined();
    expect(snapshot.zcodeBuiltinRevision).toBe("builtin-1");
  });

  it("forwards change events and derives on every read", async () => {
    let accounts: { accountKey: string; providerName: string }[] = [];
    const listeners = new Set<() => void>();
    const source = {
      async read() {
        return createBaseSnapshot();
      },
      onDidChange(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const derived = createDerivedChatGptPlanConfigSource(source, async () => accounts);
    let seen = 0;
    const dispose = derived.onDidChange(() => {
      seen += 1;
    });
    accounts = [{ accountKey: ACCOUNT_A, providerName: "work@example.com" }];
    const first = await derived.read();
    expect(
      first.zcodeBuiltinProviders.get(buildChatGptPlanAccountProviderId(ACCOUNT_A)),
    ).toBeDefined();
    accounts = [];
    const second = await derived.read();
    expect(
      second.zcodeBuiltinProviders.get(buildChatGptPlanAccountProviderId(ACCOUNT_A)),
    ).toBeUndefined();
    listeners.forEach((listener) => listener());
    expect(seen).toBe(1);
    dispose();
  });
});
