import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  createCodingPlanApiKeyResolver,
  createSiwcAccessTokenResolver,
  listSiwcPlanAccounts,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import { createConfig } from "@zcode/adapters/config";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import {
  createDerivedChatGptPlanConfigSource,
  ChatgptAccountAccessConfig,
  createAccountProviderConfigSnapshot,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildChatGptPlanAccountProviderId,
  isChatGptPlanAccountProviderId,
  type ProviderFamilyDomain,
} from "@zcode/shared";

// Registry revisions are process-local cache keys. A per-process HMAC key keeps account keys
// and display names out of the revision while preserving stability across this runtime's reads.
// It keys ONLY the process-local top-level derived `revision`; `zcodeBuiltinRevision`, the
// cross-process contract carried by account snapshots (`basedOnZCodeBuiltinRevision`), stays
// raw on every side and never embeds this fingerprint.
const chatGptPlanRevisionKey = randomBytes(32);

/** Builtin template provider id of the ChatGPT plan (SIWC) account provider family. */
export const CHATGPT_PLAN_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan;

export interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  readonly modelId: string;
  readonly providerId: string;
}

export async function readStandaloneCodingPlanProviders(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return (await readStandaloneCodingPlanCatalog(env)).providers;
}

/** Catalog entry of the ChatGPT plan provider (model ids come from the builtin catalog). */
export interface StandaloneChatGptPlanProvider {
  readonly modelId: string;
  readonly providerId: string;
}

export async function resolveStandaloneChatGptPlanProvider(
  env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneChatGptPlanProvider> {
  const matches = (await readStandaloneCodingPlanCatalog(env)).chatgptPlan;
  if (!matches) {
    throw new Error("ZCode Built-in Config must declare the account:chatgpt-plan provider");
  }
  return matches;
}

async function readStandaloneCodingPlanCatalog(
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<{
  readonly zcodeBuiltinRevision: string;
  readonly providers: readonly StandaloneCodingPlanProvider[];
  readonly chatgptPlan?: StandaloneChatGptPlanProvider;
}> {
  if (config)
    return {
      zcodeBuiltinRevision: config.revision,
      providers: config.providers.entries().flatMap(([providerId, provider]) => {
        const access = provider.access;
        const modelId = provider.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
        return access?.type === "zhipu-account" &&
          access.mode === "individual-coding-plan" &&
          access.accountType &&
          modelId
          ? [{ family: access.accountType, modelId, providerId }]
          : [];
      }),
      chatgptPlan: readChatGptPlanProvider(config.providers),
    };
  const filePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(`${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required for login`);
  }
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  try {
    const snapshot = await source.read();
    return readStandaloneCodingPlanCatalog(env, snapshot);
  } finally {
    source.dispose();
  }
}

function readChatGptPlanProvider(
  providers: Pick<ProviderConfigLayerSnapshot, "providers">["providers"],
): StandaloneChatGptPlanProvider | undefined {
  // With per-account derivation active the base template entry is replaced by derived
  // entries; any chatgpt-account entry carries the same template config and model list.
  const provider =
    providers.get(CHATGPT_PLAN_PROVIDER_ID) ?? firstChatGptAccountProvider(providers);
  const modelId = provider?.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
  if (!provider || provider.access?.type !== "chatgpt-account" || !modelId) return undefined;
  return { modelId, providerId: CHATGPT_PLAN_PROVIDER_ID };
}

function firstChatGptAccountProvider(
  providers: Pick<ProviderConfigLayerSnapshot, "providers">["providers"],
): ProviderConfig | undefined {
  for (const [, provider] of providers.entries()) {
    if (provider.access?.type === "chatgpt-account") return provider;
  }
  return undefined;
}

export async function resolveStandaloneCodingPlanProvider(
  family: ProviderFamilyDomain,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneCodingPlanProvider> {
  const matches = (await readStandaloneCodingPlanProviders(env)).filter(
    (provider) => provider.family === family,
  );
  if (matches.length !== 1) {
    throw new Error(
      `ZCode Built-in Config 必须为 ${family} 声明唯一 Individual Coding Plan Provider`,
    );
  }
  return matches[0]!;
}

export function standaloneAccountIdentityCredentialKey(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) throw new Error("Standalone Account Provider ID 不能为空");
  return `account-provider:${normalized}:identity`;
}

export function standaloneAccountAuthSourceCredentialKey(providerId: string): string {
  return `account-provider:${providerId}:auth-source`;
}
function oauthCredentialKey(family: ProviderFamilyDomain): string {
  return family === "zai"
    ? SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken
    : SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken;
}

/** Private Standalone Credential Store key; it must not enter Provider Config, Model, or Protocol. */
export function standaloneAccountProviderCredentialKey(input: {
  readonly providerId: string;
  readonly accountIdentity: string;
}): string {
  const providerId = input.providerId.trim();
  const accountIdentity = input.accountIdentity.trim();
  if (!providerId) throw new Error("Standalone Account Provider ID 不能为空");
  if (!accountIdentity) throw new Error("Standalone Account Identity 不能为空");
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

/** Manual Key sign-ins without an account Profile use a stable, irreversible connection identity. */
export function createStandaloneAccountIdentityFromSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new Error("Standalone Account Secret 不能为空");
  // Fork note: the display connection identity (truncated digest) is derived from the high-entropy API key; this is not password storage and the original cannot be brute-forced offline.
  // codeql[js/insufficient-password-hash]
  return `key-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

/** Credential store capabilities the account snapshot needs: reads plus the legacy-key migration writes. */
type StandaloneAccountCredentialStore = Pick<
  SharedZCodeCredentialStore,
  "loadMany" | "saveMany" | "deleteIfValues"
>;

export async function readStandaloneAccountProviderConfigSnapshot(
  credentialStore: StandaloneAccountCredentialStore,
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<AccountProviderConfigSnapshot> {
  const catalog = await readStandaloneCodingPlanCatalog(env, config);
  const configuredProviders = catalog.providers;
  const identityKeys = configuredProviders.map(({ providerId }) =>
    standaloneAccountIdentityCredentialKey(providerId),
  );
  const identities = await credentialStore.loadMany(identityKeys);
  const candidates = configuredProviders.flatMap(({ family, providerId }) => {
    const accountIdentity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    if (!accountIdentity) return [];
    const credentialKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity,
    });
    return [{ accountIdentity, credentialKey, family, providerId }] as const;
  });
  const sources = await credentialStore.loadMany(
    candidates.map(({ providerId }) => standaloneAccountAuthSourceCredentialKey(providerId)),
  );
  // Choose the read scope by source first; OAuth does not decrypt the old key, and manual mode does not depend on unrelated OAuth ciphertext.
  const credentials = await credentialStore.loadMany(
    candidates.map(({ credentialKey, providerId, family }) =>
      sources[standaloneAccountAuthSourceCredentialKey(providerId)] === "manual"
        ? credentialKey
        : oauthCredentialKey(family),
    ),
  );
  const candidateByProviderId = new Map(
    candidates.map((candidate) => [candidate.providerId, candidate]),
  );
  let providers = new ProviderConfigMap(
    configuredProviders.map(({ family, providerId }) => {
      const candidate = candidateByProviderId.get(providerId);
      const source = sources[standaloneAccountAuthSourceCredentialKey(providerId)];
      const requestCredentialKey =
        source === "manual" ? candidate?.credentialKey : oauthCredentialKey(family);
      const authorized = Boolean(requestCredentialKey && credentials[requestCredentialKey]?.trim());
      if (!candidate || !authorized) {
        // Bug root cause: A missing account Overlay member means "do not override" and cannot represent a disconnected
        // account. Set entitled=false explicitly so the built-in account Provider leaves the Registry
        // after its credentials are deleted.
        return [
          providerId,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: false }),
          }),
        ] as const;
      }
      return [
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
        }),
      ] as const;
    }),
  );
  if (catalog.chatgptPlan) {
    // Consent gating per account: each signed-in slot is entitled only with stored tokens AND
    // the plan-usage scope; an identity-only account stays visible-but-inert (entitled=false
    // hides it from the regular registry until consent is granted).
    const accounts = await listSiwcPlanAccounts(credentialStore).catch(() => []);
    for (const account of accounts) {
      providers = providers.set(
        buildChatGptPlanAccountProviderId(account.accountKey),
        new ProviderConfig({
          access: new ChatgptAccountAccessConfig({ entitled: account.entitled }),
        }),
      );
    }
  }
  return createAccountProviderConfigSnapshot(catalog.zcodeBuiltinRevision, providers);
}

/**
 * Config-source wrapper deriving per-account ChatGPT plan provider entries for the process
 * registry (template rule + model rules cloned per signed-in account; base entry dropped).
 */
export function createStandaloneChatGptPlanConfigSourceWrapper(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
): (source: ProviderSource<ProviderConfigSnapshot>) => ProviderSource<ProviderConfigSnapshot> {
  return (source) =>
    createDerivedChatGptPlanConfigSource(source, async () => {
      const accounts = await listSiwcPlanAccounts(credentialStore);
      return accounts.map((account) => {
        const providerName = account.email ?? account.name ?? account.accountKey;
        return {
          accountKey: account.accountKey,
          providerName,
          // Key the account+presentation fingerprint so neither account keys nor email/name
          // values can be recovered from the logged registry revision.
          revisionKey: createHmac("sha256", chatGptPlanRevisionKey)
            .update(JSON.stringify([account.accountKey, providerName]), "utf-8")
            .digest("hex")
            .slice(0, 32),
        };
      });
    });
}

export async function hasStandaloneCodingPlanAccess(
  credentialStore: StandaloneAccountCredentialStore,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return (await readStandaloneAccountProviderConfigSnapshot(credentialStore, env)).providers
    .entries()
    .some(([, provider]) =>
      provider.access?.type === "zhipu-account" ? provider.access.entitled === true : false,
    );
}

export function createStandaloneProviderRuntimeHeadersPort(
  credentialStore: Pick<
    SharedZCodeCredentialStore,
    "filePath" | "load" | "loadMany" | "save" | "delete" | "saveMany" | "deleteIfValues"
  >,
  env: Readonly<Record<string, string | undefined>>,
  injectedResolver?: ReturnType<typeof createCodingPlanApiKeyResolver>,
): ProviderRuntimeHeadersPort & {
  clearProjectTokens(): void;
  invalidateChangedCredentials(): Promise<void>;
} {
  const config = createConfig({ env }).config;
  const resolver =
    injectedResolver ??
    createCodingPlanApiKeyResolver({
      httpClient: createNodeHttpClientAdapter({
        env,
        proxyUrl: config.network.httpProxy,
        noProxy: config.network.noProxy,
        caCertFile: config.network.caCertFile,
        timeoutMs: config.network.timeout,
      }),
      locationStore: credentialStore,
      observe: (event) => console.warn("[project-access-token]", event),
    });
  const authSnapshots = new Map<string, string>();
  // ChatGPT plan (SIWC): request-time access-token lifecycle with rotation-safe single-flight
  // refresh and terminal-failure clearing, independent of the zhipu project-token resolver.
  const siwcResolver = createSiwcAccessTokenResolver({ credentialStore });
  return {
    clearProjectTokens() {
      authSnapshots.clear();
      resolver.clear();
    },
    async invalidateChangedCredentials() {
      const values = await credentialStore.loadMany([...authSnapshots.keys()]);
      if ([...authSnapshots].some(([key, value]) => values[key]?.trim() !== value)) {
        authSnapshots.clear();
        resolver.clear();
      }
    },
    shouldRefreshBeforeModelRequest() {
      return true;
    },
    async refreshBeforeModelRequest(input) {
      input.abortSignal?.throwIfAborted();
      const providerId = input.providerId.trim();
      if (isChatGptPlanAccountProviderId(providerId)) {
        const resolved = await siwcResolver.resolve({
          providerId,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          // After a 401 rejection the retry must not resend the rejected token; a scope
          // mismatch (real account switch) is still refused below.
          ...(input.rejectedProjectTokenFingerprint ? { forceRefresh: true } : {}),
        });
        if (input.expectedAccountScope && input.expectedAccountScope !== resolved.accountScope) {
          throw new Error("siwc_account_scope_invalidated");
        }
        return {
          headersApplied: true,
          requestAuth: {
            apiKey: resolved.apiKey,
            accountScope: resolved.accountScope,
          },
        };
      }
      const access = input.accountAccess;
      if (!access || access.mode !== "individual-coding-plan") {
        throw new Error(`Standalone Account Provider 请求身份无效: ${providerId}`);
      }
      const currentIdentity = (
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
      )?.trim();
      if (!currentIdentity)
        throw new Error(`Standalone Account Provider 凭据已经失效: ${providerId}`);
      const family = access.accountType;
      if (!family) throw new Error("project_token_account_required");
      const sourceKey = standaloneAccountAuthSourceCredentialKey(providerId);
      const source = await credentialStore.load(sourceKey);
      const oauthKey = oauthCredentialKey(family);
      const oauth =
        source === "manual" ? undefined : (await credentialStore.load(oauthKey))?.trim();
      const useOAuth = source === "oauth" || (source !== "manual" && Boolean(oauth));
      let apiKey: string | undefined;
      let apiKeyId: string | undefined;
      let accountScope: string | undefined;
      if (useOAuth) {
        if (!oauth) {
          resolver.clear();
          throw new Error("project_token_login_required");
        }
        // Fork note: this is the account scope fingerprint (compared for equality with expectedAccountScope to detect
        // account switching), not password storage — it needs a fast deterministic digest rather than a KDF; oauth is only an input and is not leaked.
        accountScope = createHash("sha256")
          .update(
            // codeql[js/insufficient-password-hash]
            JSON.stringify([providerId, family, currentIdentity, oauth]),
          )
          .digest("hex");
        if (
          (input.expectedAccountScope && input.expectedAccountScope !== accountScope) ||
          (input.rejectedProjectTokenFingerprint && !input.expectedAccountScope)
        )
          throw new Error("project_token_scope_invalidated");
        if (source !== "oauth") await credentialStore.save(sourceKey, "oauth");
        authSnapshots.set(oauthKey, oauth);
        authSnapshots.set(standaloneAccountIdentityCredentialKey(providerId), currentIdentity);
        authSnapshots.set(sourceKey, "oauth");
        const material = await resolver.resolveMaterial(
          {
            family,
            accessToken: oauth,
            accountIdentity: currentIdentity,
            rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint,
            trace: input.traceContext,
          },
          { signal: input.abortSignal },
        );
        apiKey = material.token;
        apiKeyId = material.apiKeyId;
        // Deliver only the current account's token during the request; a late issuance must not overwrite a logged-out or switched login state.
        if (
          (await credentialStore.load(oauthKey))?.trim() !== oauth ||
          (
            await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
          )?.trim() !== currentIdentity ||
          (await credentialStore.load(sourceKey)) !== "oauth"
        ) {
          resolver.clear();
          throw new Error("project_token_scope_invalidated");
        }
      } else if (source === "manual") {
        if (input.expectedAccountScope || input.rejectedProjectTokenFingerprint)
          throw new Error("project_token_scope_invalidated");
        apiKey = (
          await credentialStore.load(
            standaloneAccountProviderCredentialKey({
              providerId,
              accountIdentity: currentIdentity,
            }),
          )
        )?.trim();
      }
      if (!useOAuth && source !== "manual") {
        // The legacy format cannot distinguish manual from OAuth-derived keys; without a login state, require re-selecting the login method — no guessing fallback.
        resolver.clear();
        throw new Error("project_token_login_required");
      }
      input.abortSignal?.throwIfAborted();
      if (!apiKey) {
        throw new Error(`Standalone Account Provider 缺少请求凭据: ${providerId}`);
      }
      return {
        headersApplied: true,
        requestAuth: {
          apiKey,
          ...(apiKeyId ? { apiKeyId } : {}),
          ...(accountScope ? { accountScope } : {}),
        },
      };
    },
  };
}
