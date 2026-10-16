import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildChatGptPlanAccountProviderId,
  isChatGptPlanAccountKey,
} from "@zcode/shared/model-provider-types";
import { ModelConfigRules, ProviderConfigMap } from "./config/index.js";
import type { ProviderConfigSnapshot, ProviderSource } from "./sources.js";

/** One signed-in ChatGPT plan account to expose as a derived provider entry. */
export interface DerivedChatGptPlanAccount {
  /** Slot key (sha256(sub) prefix); also the provider id suffix. */
  readonly accountKey: string;
  /** Picker group label (the account's email or name fallback). */
  readonly providerName: string;
}

/**
 * Derive per-account ChatGPT plan provider entries from the builtin catalog template rule.
 *
 * The base builtin entry (`account:chatgpt-plan`) is dropped and replaced by one entry per
 * signed-in account (`account:chatgpt-plan:<accountKey>`), cloning the template's api config,
 * model list, and exact provider-model rules (rules match by exact provider id, so the clones
 * must exist or the derived models lose `enabled` / `contextWindow`). The snapshot revisions
 * gain an account-set suffix: the registry deduplicates by revision, so a changed account set
 * must produce a different revision or derived entries would never republish.
 */
export function deriveChatGptPlanAccountConfigSnapshot(
  snapshot: ProviderConfigSnapshot,
  accounts: readonly DerivedChatGptPlanAccount[],
): ProviderConfigSnapshot {
  const baseId = BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan;
  const validAccounts = dedupeByAccountKey(
    accounts.filter((account) => isChatGptPlanAccountKey(account.accountKey)),
  );

  // Registry deduplication is revision-based, so a changed account set must produce a
  // different revision or derived entries would never republish. With zero accounts the
  // raw revision is kept: the snapshot then only drops the template entry, and consumers
  // comparing against the builtin revision (recovery, fail-closed start) stay consistent.
  const accountSuffix = validAccounts.length
    ? `#chatgpt:${validAccounts
        .map((account) => buildChatGptPlanAccountProviderId(account.accountKey))
        .sort()
        .join(",")}`
    : "";

  const providers = new ProviderConfigMap(
    snapshot.zcodeBuiltinProviders.rules().flatMap((rule) => {
      if (rule.providerId !== baseId) return [rule];
      return validAccounts.flatMap((account) => [
        {
          providerId: buildChatGptPlanAccountProviderId(account.accountKey),
          providerName: account.providerName,
          ...(rule.templateId !== undefined ? { templateId: rule.templateId } : {}),
          ...(rule.enabled !== undefined ? { enabled: rule.enabled } : {}),
          config: rule.config,
        },
      ]);
    }),
  );

  const modelRules = new ModelConfigRules(
    snapshot.zcodeBuiltinModelRules.rules().flatMap((rule) => {
      // Only exact provider-model rules carry a providerId; template/match rules keep as-is.
      if (!("providerId" in rule) || rule.providerId !== baseId) return [rule];
      return validAccounts.flatMap((account) => [
        { ...rule, providerId: buildChatGptPlanAccountProviderId(account.accountKey) },
      ]);
    }),
  );

  return Object.freeze({
    ...snapshot,
    revision: `${snapshot.revision}${accountSuffix}`,
    zcodeBuiltinRevision: `${snapshot.zcodeBuiltinRevision}${accountSuffix}`,
    zcodeBuiltinProviders: providers,
    zcodeBuiltinModelRules: modelRules,
  });
}

function dedupeByAccountKey(
  accounts: readonly DerivedChatGptPlanAccount[],
): readonly DerivedChatGptPlanAccount[] {
  const seen = new Set<string>();
  const result: DerivedChatGptPlanAccount[] = [];
  for (const account of accounts) {
    const key = account.accountKey.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key === account.accountKey ? account : { ...account, accountKey: key });
  }
  return result;
}

/**
 * Wrap a provider config source so every read derives per-account ChatGPT plan entries.
 * Change events of the wrapped source are forwarded as-is; account-set changes republish
 * through the reader's own refresh cycle (the account layer re-reads on credential changes).
 * Account enumeration failures degrade to "no chatgpt entries" — an unreadable credential
 * store must not take down the whole provider registry (the account layer surfaces the
 * auth problem through its own refresh).
 */
export function createDerivedChatGptPlanConfigSource(
  source: ProviderSource<ProviderConfigSnapshot>,
  listAccounts: () => Promise<readonly DerivedChatGptPlanAccount[]>,
): ProviderSource<ProviderConfigSnapshot> {
  return {
    async read() {
      const [snapshot, accounts] = await Promise.all([
        source.read(),
        listAccounts().catch(() => [] as const),
      ]);
      return deriveChatGptPlanAccountConfigSnapshot(snapshot, accounts);
    },
    onDidChange(listener) {
      return source.onDidChange(listener);
    },
  };
}
