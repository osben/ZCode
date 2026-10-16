import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSharedZCodeCredentialStore,
  createSiwcAccountKey,
  listSiwcPlanAccounts,
  type SiwcTokenClient,
  type SiwcTokenResponse,
} from "@zcode/adapters/auth";
import {
  buildChatGptPlanAccountProviderId,
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountProviderAuthSourceKey,
  buildSiwcAccountProviderIdentityKey,
  SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
} from "@zcode/shared";
import { readStandaloneAccountProviderConfigSnapshot } from "../src/app/standalone-account-provider-runtime.js";
import { loginChatGptPlan, logoutChatGptPlan } from "../src/auth-login-chatgpt.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "chatgpt-login-test-secret",
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
    new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
};

const ISSUER = "https://auth.openai.com";
const ISSUED_CLIENT_ID = "oaiapp_issued-client";
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const FULL_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const SUB = "user-sub-1";
const ACCOUNT_KEY = createSiwcAccountKey(SUB);
const ACCOUNT_PROVIDER_ID = buildChatGptPlanAccountProviderId(ACCOUNT_KEY);
const ACCOUNT_KEYS = buildSiwcAccountCredentialKeys(ACCOUNT_KEY);

interface TestKey {
  jwk: Record<string, unknown>;
  sign: (content: string) => string;
}

function createTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    jwk: { ...jwk, kid: "test-key", kty: "RSA", alg: "RS256", use: "sig" },
    sign: (content: string) => {
      const signer = createSign("RSA-SHA256");
      signer.update(content, "ascii");
      return signer.sign(privateKey).toString("base64url");
    },
  };
}

function buildIdToken(
  key: TestKey,
  nonce: string,
  sub: string = SUB,
  aud: string = ISSUED_CLIENT_ID,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      iss: ISSUER,
      aud,
      exp: NOW_SECONDS + 600,
      iat: NOW_SECONDS,
      nonce,
      email: `${sub}@example.com`,
      email_verified: true,
      name: "Test User",
    }),
  ).toString("base64url");
  return `${header}.${payload}.${key.sign(`${header}.${payload}`)}`;
}

/** JWKS/discovery fetch for id-token verification (token + revocation go through the fake client). */
function createFakeAuthFetch(key: TestKey): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        jwks_uri: "https://auth.test/jwks",
        revocation_endpoint: "https://auth.test/revoke",
      });
    }
    if (url.endsWith("/jwks")) {
      return Response.json({ keys: [key.jwk] });
    }
    throw new Error(`unexpected auth fetch: ${url}`);
  };
}

interface FakeTokenClientOptions {
  readonly key: TestKey;
  readonly scope?: string;
  readonly sub?: string;
  readonly revoke?: { calls: string[]; failFirst?: boolean };
  /** Populated by onAuthorizeUrl so the minted id token carries this attempt's nonce. */
  readonly nonceRef: { value: string };
}

function createFakeTokenClient(options: FakeTokenClientOptions) {
  const exchangeCalls: { code: string; clientId: string }[] = [];
  const tokenClient: SiwcTokenClient = {
    async exchangeCode(input) {
      exchangeCalls.push({ code: input.code, clientId: input.clientId });
      const response: SiwcTokenResponse = {
        accessToken: "siwc-access-1",
        refreshToken: "siwc-refresh-1",
        idToken: buildIdToken(options.key, options.nonceRef.value, options.sub),
        tokenType: "bearer",
        expiresInSeconds: 3600,
        scope: options.scope ?? FULL_SCOPE,
        earliestRefreshAt: NOW_SECONDS + 1800,
      };
      return response;
    },
    async refresh() {
      throw new Error("refresh not exercised in login tests");
    },
    async revoke() {
      options.revoke?.calls.push("revoke");
      if (options.revoke?.failFirst && options.revoke.calls.length === 1) {
        const error = new Error("SIWC token revocation failed with HTTP 503") as Error & {
          httpStatus?: number;
        };
        error.httpStatus = 503;
        throw error;
      }
    },
  };
  return { exchangeCalls, tokenClient };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "chatgpt-login-"));
  tempDirs.push(dir);
  const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
  return { credentialStore, dir };
}

/** Drive the loopback callback the way the browser redirect would. */
async function runLoginWithBrowserRedirect(options: {
  credentialStore: ReturnType<typeof createSharedZCodeCredentialStore>;
  dir: string;
  env?: Record<string, string | undefined>;
  key: TestKey;
  scope?: string;
  sub?: string;
}): Promise<ReturnType<typeof loginChatGptPlan>> {
  const env = options.env ?? TEST_ENV;
  const nonceRef = { value: "" };
  const { exchangeCalls, tokenClient } = createFakeTokenClient({
    key: options.key,
    nonceRef,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.sub === undefined ? {} : { sub: options.sub }),
  });
  const loginPromise = loginChatGptPlan({
    credentialStore: options.credentialStore,
    env,
    noBrowser: true,
    fetchFn: createFakeAuthFetch(options.key),
    tokenClient,
    now: () => NOW_SECONDS * 1000,
    personalProviderConfigPath: join(options.dir, "provider_config.json"),
    onAuthorizeUrl: async (data) => {
      const url = new URL(data.authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
      expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(url.searchParams.get("agent_name_hint")).toBe("ZCode");
      expect(url.searchParams.get("scope")).toBe(FULL_SCOPE);
      expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
      expect(url.searchParams.get("nonce")).toMatch(/.+/u);
      nonceRef.value = url.searchParams.get("nonce") ?? "";
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      redirect.searchParams.set("code", "siwc-auth-code");
      redirect.searchParams.set("client_id", ISSUED_CLIENT_ID);
      const response = await fetch(redirect);
      if (!response.ok) throw new Error(`callback failed: ${response.status}`);
    },
  });
  const result = await loginPromise;
  expect(exchangeCalls).toEqual([{ code: "siwc-auth-code", clientId: ISSUED_CLIENT_ID }]);
  return result;
}

async function seedAccountSlot(
  store: ReturnType<typeof createSharedZCodeCredentialStore>,
  input: { accountKey: string; sub: string },
): Promise<void> {
  const keys = buildSiwcAccountCredentialKeys(input.accountKey);
  await store.saveMany({
    [keys.clientId]: ISSUED_CLIENT_ID,
    [keys.accessToken]: "siwc-access-1",
    [keys.refreshToken]: "siwc-refresh-1",
    [keys.scopes]: "openid chatgpt.tokens.use.direct",
    [keys.userInfo]: JSON.stringify({ sub: input.sub, email: `${input.sub}@example.com` }),
  });
  const raw = await store.load(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY);
  const records = raw ? (JSON.parse(raw) as unknown[]) : [];
  records.push({ accountKey: input.accountKey, sub: input.sub, email: null, name: null, addedAt: "" });
  await store.save(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY, JSON.stringify(records));
}

describe("ChatGPT plan login (SIWC)", () => {
  it("signs in, verifies the id token, persists per-account credentials, and selects the default model", async () => {
    const { credentialStore, dir } = await createWorkspace();
    const key = createTestKey();
    const result = await runLoginWithBrowserRedirect({ credentialStore, dir, key });

    expect(result.planUsageEntitled).toBe(true);
    expect(result.user).toMatchObject({ sub: SUB, email: "user-sub-1@example.com" });
    expect(result.accountKey).toBe(ACCOUNT_KEY);
    expect(result.accountProviderId).toBe(ACCOUNT_PROVIDER_ID);
    expect(result.model).toBe(`${ACCOUNT_PROVIDER_ID}/gpt-6.1-sol`);
    expect(result.providerId).toBe("chatgpt");

    const stored = await credentialStore.loadMany([
      ACCOUNT_KEYS.clientId,
      ACCOUNT_KEYS.accessToken,
      ACCOUNT_KEYS.refreshToken,
      ACCOUNT_KEYS.scopes,
      ACCOUNT_KEYS.accessExpiresAt,
      buildSiwcAccountProviderIdentityKey(ACCOUNT_KEY),
      buildSiwcAccountProviderAuthSourceKey(ACCOUNT_KEY),
    ]);
    expect(stored[ACCOUNT_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(stored[ACCOUNT_KEYS.accessToken]).toBe("siwc-access-1");
    expect(stored[ACCOUNT_KEYS.refreshToken]).toBe("siwc-refresh-1");
    expect(stored[ACCOUNT_KEYS.scopes]).toBe(FULL_SCOPE);
    expect(stored[buildSiwcAccountProviderIdentityKey(ACCOUNT_KEY)]).toBe(SUB);
    expect(stored[buildSiwcAccountProviderAuthSourceKey(ACCOUNT_KEY)]).toBe("oauth");

    const accounts = await listSiwcPlanAccounts(credentialStore);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ accountKey: ACCOUNT_KEY, entitled: true });

    const config = JSON.parse(await readFile(join(dir, "provider_config.json"), "utf-8")) as {
      config?: { defaultModelSelection?: { providerId?: string; modelId?: string } };
    };
    expect(config.config?.defaultModelSelection?.providerId).toBe(ACCOUNT_PROVIDER_ID);
    expect(config.config?.defaultModelSelection?.modelId).toBe("gpt-6.1-sol");
  });

  it("adds a second account without hints and keeps both slots", async () => {
    const { credentialStore, dir } = await createWorkspace();
    const key = createTestKey();
    await runLoginWithBrowserRedirect({ credentialStore, dir, key });

    const secondSub = "user-sub-2";
    const secondKey = createSiwcAccountKey(secondSub);
    await runLoginWithBrowserRedirect({ credentialStore, dir, key, sub: secondSub });

    const accounts = await listSiwcPlanAccounts(credentialStore);
    expect(accounts.map((account) => account.accountKey).sort()).toEqual(
      [ACCOUNT_KEY, secondKey].sort(),
    );
    // The first account's tokens are untouched by the second login.
    const first = await credentialStore.load(ACCOUNT_KEYS.accessToken);
    expect(first).toBe("siwc-access-1");
  });

  it("replaces the previous registration's bundle when the new grant has no refresh token", async () => {
    const { credentialStore, dir } = await createWorkspace();
    const key = createTestKey();
    await runLoginWithBrowserRedirect({ credentialStore, dir, key });

    // Same subject returns a fresh registration without a refresh token.
    const nonceRef = { value: "" };
    const tokenClient = {
      async exchangeCode() {
        return {
          accessToken: "new-access",
          idToken: buildIdToken(key, nonceRef.value, SUB, "oaiapp_new_client"),
          tokenType: "bearer" as const,
          expiresInSeconds: 3600,
          scope: FULL_SCOPE,
        };
      },
      async refresh() {
        throw new Error("refresh not exercised");
      },
      async revoke() {
        throw new Error("revoke not exercised");
      },
    };
    await loginChatGptPlan({
      credentialStore,
      env: TEST_ENV,
      noBrowser: true,
      fetchFn: createFakeAuthFetch(key),
      tokenClient: tokenClient as never,
      now: () => NOW_SECONDS * 1000,
      personalProviderConfigPath: join(dir, "provider_config2.json"),
      onAuthorizeUrl: async (data) => {
        const url = new URL(data.authorizeUrl);
        nonceRef.value = url.searchParams.get("nonce") ?? "";
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        redirect.searchParams.set("code", "reauth-code");
        redirect.searchParams.set("client_id", "oaiapp_new_client");
        await fetch(redirect);
      },
    });

    const stored = await credentialStore.loadMany([
      ACCOUNT_KEYS.clientId,
      ACCOUNT_KEYS.accessToken,
      ACCOUNT_KEYS.refreshToken,
    ]);
    expect(stored[ACCOUNT_KEYS.clientId]).toBe("oaiapp_new_client");
    expect(stored[ACCOUNT_KEYS.accessToken]).toBe("new-access");
    expect(stored[ACCOUNT_KEYS.refreshToken]).toBeNull();
  });

  it("stores the host id beside an injected credential store even when env points elsewhere", async () => {
    const { credentialStore, dir } = await createWorkspace();
    const otherBaseDir = await mkdtemp(join(tmpdir(), "chatgpt-login-other-base-"));
    tempDirs.push(otherBaseDir);
    const key = createTestKey();

    await runLoginWithBrowserRedirect({
      credentialStore,
      dir,
      env: { ...TEST_ENV, ZCODE_DATA_BASE_DIR: otherBaseDir },
      key,
    });

    const hostId = (
      await readFile(join(dirname(credentialStore.filePath), "siwc-host-id.txt"), "utf8")
    ).trim();
    expect(hostId).toMatch(/^urn:uuid:/u);
  });

  it("reports identity-only sign-in when consent lacked the plan scope", async () => {
    const { credentialStore, dir } = await createWorkspace();
    const key = createTestKey();
    const result = await runLoginWithBrowserRedirect({
      credentialStore,
      dir,
      key,
      scope: "openid profile email",
    });
    expect(result.planUsageEntitled).toBe(false);
    const snapshot = await readStandaloneAccountProviderConfigSnapshot(credentialStore, TEST_ENV);
    expect(snapshot.providers.get(ACCOUNT_PROVIDER_ID)?.access?.entitled).toBe(false);
  });

  it("marks the account entitled in the standalone account snapshot only with tokens and the plan scope", async () => {
    const { credentialStore } = await createWorkspace();
    const without = await readStandaloneAccountProviderConfigSnapshot(credentialStore, TEST_ENV);
    expect(without.providers.get(ACCOUNT_PROVIDER_ID)).toBeUndefined();

    await seedAccountSlot(credentialStore, { accountKey: ACCOUNT_KEY, sub: SUB });
    const entitled = await readStandaloneAccountProviderConfigSnapshot(credentialStore, TEST_ENV);
    expect(entitled.providers.get(ACCOUNT_PROVIDER_ID)?.access?.entitled).toBe(true);
  });

  it("revokes the refresh token before clearing tokens and retains the client id", async () => {
    const { credentialStore } = await createWorkspace();
    await seedAccountSlot(credentialStore, { accountKey: ACCOUNT_KEY, sub: SUB });
    const revoke = { calls: [] as string[], failFirst: true };
    const result = await logoutChatGptPlan({
      credentialStore,
      env: TEST_ENV,
      tokenClient: createFakeTokenClient({ key: createTestKey(), revoke, nonceRef: { value: "" } })
        .tokenClient,
    });
    expect(result.signedOut).toBe(true);
    expect(result.revoked).toBe(true);
    expect(result.accountCount).toBe(1);
    expect(revoke.calls).toHaveLength(2); // 503 then success

    const after = await credentialStore.loadMany([
      ACCOUNT_KEYS.clientId,
      ACCOUNT_KEYS.accessToken,
      ACCOUNT_KEYS.refreshToken,
    ]);
    expect(after[ACCOUNT_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(after[ACCOUNT_KEYS.accessToken]).toBeNull();
    expect(after[ACCOUNT_KEYS.refreshToken]).toBeNull();
    expect(await listSiwcPlanAccounts(credentialStore)).toHaveLength(0);
  });

  it("logout loops over every signed-in account and clears all slots", async () => {
    const { credentialStore } = await createWorkspace();
    const secondSub = "user-sub-2";
    const secondKey = createSiwcAccountKey(secondSub);
    const secondKeys = buildSiwcAccountCredentialKeys(secondKey);
    await seedAccountSlot(credentialStore, { accountKey: ACCOUNT_KEY, sub: SUB });
    await seedAccountSlot(credentialStore, { accountKey: secondKey, sub: secondSub });

    const result = await logoutChatGptPlan({
      credentialStore,
      env: TEST_ENV,
      tokenClient: createFakeTokenClient({ key: createTestKey(), nonceRef: { value: "" } })
        .tokenClient,
    });
    expect(result.accountCount).toBe(2);
    const after = await credentialStore.loadMany([
      ACCOUNT_KEYS.accessToken,
      secondKeys.accessToken,
    ]);
    expect(after[ACCOUNT_KEYS.accessToken]).toBeNull();
    expect(after[secondKeys.accessToken]).toBeNull();
  });

  it("rejects with auth_timeout (no uncaught exception) when the browser never returns", async () => {
    const { credentialStore, dir } = await createWorkspace();
    const key = createTestKey();
    const nonceRef = { value: "" };
    // No browser redirect is ever performed; the tiny timeout must surface as a clean
    // auth_timeout rejection and close the loopback server.
    const login = loginChatGptPlan({
      credentialStore,
      env: TEST_ENV,
      noBrowser: true,
      fetchFn: createFakeAuthFetch(key),
      tokenClient: createFakeTokenClient({ key, nonceRef }).tokenClient,
      now: () => NOW_SECONDS * 1000,
      personalProviderConfigPath: join(dir, "provider_config.json"),
      onAuthorizeUrl: () => undefined,
      timeoutMs: 150,
    });
    const error = await login.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_timeout", name: "ZCodeCliLoginError" });
  });

  it("logout is a no-op when never signed in", async () => {
    const { credentialStore } = await createWorkspace();
    const result = await logoutChatGptPlan({
      credentialStore,
      env: TEST_ENV,
      tokenClient: createFakeTokenClient({ key: createTestKey(), nonceRef: { value: "" } })
        .tokenClient,
    });
    expect(result.signedOut).toBe(false);
  });
});
