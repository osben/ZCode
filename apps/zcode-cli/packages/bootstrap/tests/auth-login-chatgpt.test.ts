import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore, SIWC_CREDENTIAL_KEYS } from "@zcode/adapters/auth";
import type { SiwcTokenClient, SiwcTokenResponse } from "@zcode/adapters/auth";
import {
  CHATGPT_PLAN_PROVIDER_ID,
  readStandaloneAccountProviderConfigSnapshot,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountIdentityCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";
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

function buildIdToken(key: TestKey, nonce: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-sub-1",
      iss: ISSUER,
      aud: ISSUED_CLIENT_ID,
      exp: NOW_SECONDS + 600,
      iat: NOW_SECONDS,
      nonce,
      email: "user@example.com",
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
        idToken: buildIdToken(options.key, options.nonceRef.value),
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
}): Promise<ReturnType<typeof loginChatGptPlan>> {
  const env = options.env ?? TEST_ENV;
  const nonceRef = { value: "" };
  const { exchangeCalls, tokenClient } = createFakeTokenClient({
    key: options.key,
    nonceRef,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
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

describe("ChatGPT plan login (SIWC)", () => {
  it("signs in, verifies the id token, persists credentials, and selects the default model", async () => {
    const { credentialStore, dir } = await createWorkspace();
    const key = createTestKey();
    const result = await runLoginWithBrowserRedirect({ credentialStore, dir, key });

    expect(result.planUsageEntitled).toBe(true);
    expect(result.user).toMatchObject({ sub: "user-sub-1", email: "user@example.com" });
    expect(result.model).toBe(`${CHATGPT_PLAN_PROVIDER_ID}/gpt-6.1-sol`);
    expect(result.providerId).toBe("chatgpt");

    const stored = await credentialStore.loadMany([
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.accessToken,
      SIWC_CREDENTIAL_KEYS.refreshToken,
      SIWC_CREDENTIAL_KEYS.scopes,
      SIWC_CREDENTIAL_KEYS.accessExpiresAt,
      standaloneAccountIdentityCredentialKey(CHATGPT_PLAN_PROVIDER_ID),
      standaloneAccountAuthSourceCredentialKey(CHATGPT_PLAN_PROVIDER_ID),
    ]);
    expect(stored[SIWC_CREDENTIAL_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(stored[SIWC_CREDENTIAL_KEYS.accessToken]).toBe("siwc-access-1");
    expect(stored[SIWC_CREDENTIAL_KEYS.refreshToken]).toBe("siwc-refresh-1");
    expect(stored[SIWC_CREDENTIAL_KEYS.scopes]).toBe(FULL_SCOPE);
    expect(stored[standaloneAccountIdentityCredentialKey(CHATGPT_PLAN_PROVIDER_ID)]).toBe(
      "user-sub-1",
    );
    expect(stored[standaloneAccountAuthSourceCredentialKey(CHATGPT_PLAN_PROVIDER_ID)]).toBe(
      "oauth",
    );

    const config = JSON.parse(await readFile(join(dir, "provider_config.json"), "utf-8")) as {
      config?: { defaultModelSelection?: { providerId?: string; modelId?: string } };
    };
    expect(config.config?.defaultModelSelection?.providerId).toBe(CHATGPT_PLAN_PROVIDER_ID);
    expect(config.config?.defaultModelSelection?.modelId).toBe("gpt-6.1-sol");
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

    const hostId = (await readFile(join(dirname(credentialStore.filePath), "siwc-host-id.txt"), "utf8")).trim();
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
    expect(
      (await readStandaloneAccountProviderConfigSnapshot(credentialStore, TEST_ENV)).providers.get(
        CHATGPT_PLAN_PROVIDER_ID,
      )?.access?.entitled,
    ).toBe(false);
  });

  it("marks the provider entitled in the standalone account snapshot only with tokens and the plan scope", async () => {
    const { credentialStore } = await createWorkspace();
    const without = await readStandaloneAccountProviderConfigSnapshot(credentialStore, TEST_ENV);
    expect(without.providers.get(CHATGPT_PLAN_PROVIDER_ID)?.access?.entitled).toBe(false);

    await credentialStore.saveMany({
      [SIWC_CREDENTIAL_KEYS.clientId]: ISSUED_CLIENT_ID,
      [SIWC_CREDENTIAL_KEYS.accessToken]: "siwc-access-1",
      [SIWC_CREDENTIAL_KEYS.refreshToken]: "siwc-refresh-1",
      [SIWC_CREDENTIAL_KEYS.scopes]: "openid chatgpt.tokens.use.direct",
    });
    const entitled = await readStandaloneAccountProviderConfigSnapshot(credentialStore, TEST_ENV);
    expect(entitled.providers.get(CHATGPT_PLAN_PROVIDER_ID)?.access?.entitled).toBe(true);
  });

  it("revokes the refresh token before clearing tokens and retains the client id", async () => {
    const { credentialStore } = await createWorkspace();
    await credentialStore.saveMany({
      [SIWC_CREDENTIAL_KEYS.clientId]: ISSUED_CLIENT_ID,
      [SIWC_CREDENTIAL_KEYS.accessToken]: "siwc-access-1",
      [SIWC_CREDENTIAL_KEYS.refreshToken]: "siwc-refresh-1",
      [SIWC_CREDENTIAL_KEYS.scopes]: "openid chatgpt.tokens.use.direct",
    });
    const revoke = { calls: [] as string[], failFirst: true };
    const result = await logoutChatGptPlan({
      credentialStore,
      env: TEST_ENV,
      tokenClient: createFakeTokenClient({ key: createTestKey(), revoke, nonceRef: { value: "" } })
        .tokenClient,
    });
    expect(result.signedOut).toBe(true);
    expect(result.revoked).toBe(true);
    expect(revoke.calls).toHaveLength(2); // 503 then success

    const after = await credentialStore.loadMany([
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.accessToken,
      SIWC_CREDENTIAL_KEYS.refreshToken,
    ]);
    expect(after[SIWC_CREDENTIAL_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(after[SIWC_CREDENTIAL_KEYS.accessToken]).toBeNull();
    expect(after[SIWC_CREDENTIAL_KEYS.refreshToken]).toBeNull();
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
