import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSiwcAccountCredentialKeys, SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY } from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import {
  SIWC_CODEX_CLIENT_ID,
  buildSiwcCodexCredentialKeys,
  readUsageSnapshotFromWhamPayload,
} from "../src/oauth/siwc/siwcCodexWire.js";
import { SiwcAuthService, createSiwcAccountKey } from "../src/oauth/siwc/siwcAuthService.js";
import { SIWC_ISSUER } from "../src/oauth/siwc/siwcOAuth.js";

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const SUB = "codex-usage-sub-1";
const ACCOUNT_KEY = createSiwcAccountKey(SUB);
const ACCOUNT_EMAIL = "work@example.com";
const CODEX_KEYS = buildSiwcCodexCredentialKeys(ACCOUNT_KEY);
const WHAM_PRIMARY_RESET = 1792237444;
const WHAM_SECONDARY_RESET = 1792649995;

function createMemoryCredentialService(): ICredentialService & {
  dump(): Record<string, string>;
} {
  const store = new Map<string, string>();
  return {
    async load(key) {
      return store.get(key) ?? null;
    },
    async save(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    dump() {
      return Object.fromEntries(store);
    },
  };
}

interface TestKey {
  jwk: Record<string, unknown>;
  sign: (content: string) => string;
}

function createTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    jwk: { ...jwk, kid: "codex-test-key", kty: "RSA", alg: "RS256", use: "sig" },
    sign: (content: string) => {
      const signer = createSign("RSA-SHA256");
      signer.update(content, "ascii");
      return signer.sign(privateKey).toString("base64url");
    },
  };
}

function buildCodexIdToken(key: TestKey, email: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "codex-test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "auth0-real-sub",
      iss: SIWC_ISSUER,
      aud: SIWC_CODEX_CLIENT_ID,
      exp: NOW_SECONDS + 600,
      chatgpt_account_id: "acct_test_routing",
      "https://api.openai.com/profile": { email },
    }),
  ).toString("base64url");
  return `${header}.${payload}.${key.sign(`${header}.${payload}`)}`;
}

const WHAM_PAYLOAD = {
  user_id: "user-x",
  email: ACCOUNT_EMAIL,
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 17,
      limit_window_seconds: 18000,
      reset_after_seconds: 13713,
      reset_at: WHAM_PRIMARY_RESET,
    },
    secondary_window: {
      used_percent: 74,
      limit_window_seconds: 604800,
      reset_after_seconds: 426264,
      reset_at: WHAM_SECONDARY_RESET,
    },
  },
};

interface WhamResponse {
  status: number;
  payload?: unknown;
}

interface FakeBackendOptions {
  key?: TestKey;
  idTokenEmail?: string;
  whamResponses?: WhamResponse[];
  exchangeRefreshToken?: { accessToken: string; refreshToken: string };
  refreshStatus?: number;
}

/**
 * Fake backend: OIDC discovery + JWKS (shared with SIWC), the codex /oauth/token endpoint,
 * the (unpinned) revoke endpoint, and a scripted wham/usage queue.
 */
function createFakeBackend(options: FakeBackendOptions & { key: TestKey }) {
  const state = {
    exchangeCodes: [] as string[],
    refreshCalls: [] as string[],
    revokeCalls: 0,
    revokedTokens: [] as string[],
    whamCalls: 0,
    whamHeaders: [] as Array<{ authorization: string; userAgent: string; accountId: string }>,
    authorizationBodies: [] as Array<Record<string, string>>,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ jwks_uri: "https://auth.test/jwks" });
    }
    if (url.endsWith("/jwks")) {
      return Response.json({ keys: [options.key.jwk] });
    }
    if (url.endsWith("/oauth/revoke")) {
      state.revokeCalls += 1;
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      state.revokedTokens.push(body.token ?? "");
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/oauth/token")) {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      if (body.grant_type === "authorization_code") {
        state.exchangeCodes.push(body.code ?? "");
        state.authorizationBodies.push(body);
        return Response.json({
          access_token: "codex-access-1",
          refresh_token: "codex-refresh-1",
          id_token: buildCodexIdToken(options.key, options.idTokenEmail ?? ACCOUNT_EMAIL),
          expires_in: 10 * 24 * 60 * 60,
        });
      }
      if (body.grant_type === "refresh_token") {
        state.refreshCalls.push(body.refresh_token ?? "");
        if (options.refreshStatus !== undefined && options.refreshStatus !== 200) {
          return Response.json(
            { error: "invalid_grant", error_description: "refresh token revoked" },
            { status: options.refreshStatus },
          );
        }
        const next = options.exchangeRefreshToken ?? {
          accessToken: "codex-access-2",
          refreshToken: "codex-refresh-2",
        };
        return Response.json({
          access_token: next.accessToken,
          refresh_token: next.refreshToken,
          expires_in: 10 * 24 * 60 * 60,
        });
      }
    }
    if (url.endsWith("/wham/usage")) {
      const index = Math.min(state.whamCalls, (options.whamResponses?.length ?? 1) - 1);
      state.whamCalls += 1;
      state.whamHeaders.push({
        authorization: String(new Headers(init?.headers).get("authorization") ?? ""),
        userAgent: String(new Headers(init?.headers).get("user-agent") ?? ""),
        accountId: String(new Headers(init?.headers).get("chatgpt-account-id") ?? ""),
      });
      const scripted = options.whamResponses?.[index] ?? { status: 200, payload: WHAM_PAYLOAD };
      if (scripted.status === 200) return Response.json(scripted.payload);
      return Response.json({ error: { message: "Unauthorized" } }, { status: scripted.status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchFn, state };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createService(options: FakeBackendOptions & { seedAccount?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "siwc-codex-"));
  tempDirs.push(dir);
  const credentials = createMemoryCredentialService();
  const key = options.key ?? createTestKey();
  // key last: createFakeBackend requires it, and an explicitly-passed undefined must not override.
  const backend = createFakeBackend({ ...options, key });
  const service = new SiwcAuthService(credentials, {
    configDir: dir,
    fetchFn: backend.fetchFn,
    now: () => NOW_SECONDS * 1000,
    codexUsageCallbackPort: 0,
  });
  if (options.seedAccount !== false) {
    // Signed-in SIWC slot (scopes carry the plan grant) + account index record.
    const slotKeys = buildSiwcAccountCredentialKeys(ACCOUNT_KEY);
    await credentials.save(slotKeys.accessToken, "siwc-access");
    await credentials.save(
      slotKeys.scopes,
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    await credentials.save(
      `oauth:chatgpt:${ACCOUNT_KEY}:user_info`,
      JSON.stringify({ sub: SUB, email: ACCOUNT_EMAIL, name: "Work" }),
    );
    await credentials.save(
      SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
      JSON.stringify([
        { accountKey: ACCOUNT_KEY, sub: SUB, email: ACCOUNT_EMAIL, name: "Work", addedAt: "t" },
      ]),
    );
  }
  return { credentials, backend, service };
}

describe("SiwcCodexUsageService", () => {
  it("shapes the codex authorize URL with the pinned client, prompt=login, and login_hint", async () => {
    const { service } = await createService();
    const start = await service.startUsageLink(ACCOUNT_KEY);
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/localhost:\d+\/auth\/callback$/,
    );
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("login_hint")).toBe(ACCOUNT_EMAIL);
  });

  it("rejects the link for an account without a signed-in slot", async () => {
    const { service } = await createService({ seedAccount: false });
    await expect(service.startUsageLink(ACCOUNT_KEY)).rejects.toThrow(/signed-in/i);
  });

  it("links the grant, persists tokens, and probes usage immediately", async () => {
    const { backend, credentials, service } = await createService();
    const start = await service.startUsageLink(ACCOUNT_KEY);
    const redirect = new URL(new URL(start.authorizeUrl).searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", start.state);
    redirect.searchParams.set("code", "codex-auth-code");
    const callback = await fetch(redirect);
    expect(callback.ok).toBe(true);

    const completion = await service.pollUsageLink();
    expect(completion).toEqual({ accountKey: ACCOUNT_KEY });
    expect(backend.state.authorizationBodies[0]?.client_id).toBe(SIWC_CODEX_CLIENT_ID);
    expect(backend.state.authorizationBodies[0]?.code_verifier).toBeTruthy();
    expect(credentials.dump()[CODEX_KEYS.accessToken]).toBe("codex-access-1");
    expect(credentials.dump()[CODEX_KEYS.refreshToken]).toBe("codex-refresh-1");
    expect(credentials.dump()[CODEX_KEYS.accountId]).toBe("acct_test_routing");
    expect(Number(credentials.dump()[CODEX_KEYS.accessExpiresAt])).toBeGreaterThan(NOW_SECONDS);

    const status = await service.getStatus();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]?.usageLinked).toBe(true);
    expect(status.accounts[0]?.usage?.primary).toEqual({
      usedPercent: 17,
      windowMinutes: 300,
      resetsAt: new Date(WHAM_PRIMARY_RESET * 1000).toISOString(),
    });
    expect(status.accounts[0]?.usage?.secondary?.usedPercent).toBe(74);
    // The probe rides the codex identity: pinned user agent, bearer auth, account routing.
    expect(backend.state.whamHeaders[0]?.authorization).toBe("Bearer codex-access-1");
    expect(backend.state.whamHeaders[0]?.userAgent).toBe("codex_cli_rs");
    expect(backend.state.whamHeaders[0]?.accountId).toBe("acct_test_routing");
  });

  it("revokes only the just-exchanged grant on mismatch and keeps the pre-linked slot", async () => {
    const { backend, credentials, service } = await createService({
      idTokenEmail: "someone-else@example.com",
    });
    // Pre-linked codex slot: a wrong-account authorization (stale UI or non-UI caller) must
    // revoke the new grant at OpenAI without destroying the existing link.
    await credentials.save(CODEX_KEYS.accessToken, "codex-access-existing");
    await credentials.save(CODEX_KEYS.refreshToken, "codex-refresh-existing");
    const start = await service.startUsageLink(ACCOUNT_KEY);
    const redirect = new URL(new URL(start.authorizeUrl).searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", start.state);
    redirect.searchParams.set("code", "codex-auth-code");
    await fetch(redirect);

    await expect(service.pollUsageLink()).rejects.toThrow(/different ChatGPT account/i);
    expect(backend.state.revokedTokens).toEqual(["codex-refresh-1"]);
    const dump = credentials.dump();
    expect(dump[CODEX_KEYS.accessToken]).toBe("codex-access-existing");
    expect(dump[CODEX_KEYS.refreshToken]).toBe("codex-refresh-existing");
  });

  it("probes lazily on status reads with the proactive refresh and throttles repeats", async () => {
    const { backend, credentials, service } = await createService();
    // A linked slot whose access token is inside the 24 h refresh margin.
    await credentials.save(CODEX_KEYS.accessToken, "codex-access-stale");
    await credentials.save(CODEX_KEYS.refreshToken, "codex-refresh-stale");
    await credentials.save(CODEX_KEYS.accessExpiresAt, String(NOW_SECONDS + 3600));

    const status = await service.getStatus();
    expect(status.accounts[0]?.usage?.primary.usedPercent).toBe(17);
    expect(backend.state.refreshCalls).toEqual(["codex-refresh-stale"]);
    expect(credentials.dump()[CODEX_KEYS.refreshToken]).toBe("codex-refresh-2");
    expect(credentials.dump()[CODEX_KEYS.accessToken]).toBe("codex-access-2");
    expect(backend.state.whamCalls).toBe(1);

    // Second immediate status read: throttled, no extra probe or refresh.
    await service.getStatus();
    expect(backend.state.whamCalls).toBe(1);
  });

  it("retries once after a probe 401 by refreshing, then records usage", async () => {
    const { backend, credentials, service } = await createService({
      whamResponses: [{ status: 401 }, { status: 200, payload: WHAM_PAYLOAD }],
    });
    await credentials.save(CODEX_KEYS.accessToken, "codex-access-live");
    await credentials.save(CODEX_KEYS.refreshToken, "codex-refresh-live");
    // Fresh expiry: no proactive refresh — the 401 must drive the single refresh+retry.
    await credentials.save(CODEX_KEYS.accessExpiresAt, String(NOW_SECONDS + 5 * 24 * 60 * 60));

    const status = await service.getStatus();
    expect(backend.state.refreshCalls).toEqual(["codex-refresh-live"]);
    expect(backend.state.whamCalls).toBe(2);
    expect(status.accounts[0]?.usage?.primary.usedPercent).toBe(17);
  });

  it("clears the codex slot when a refresh is terminally rejected so usage can be linked again", async () => {
    const { backend, credentials, service } = await createService({ refreshStatus: 400 });
    await credentials.save(CODEX_KEYS.accessToken, "codex-access-stale");
    await credentials.save(CODEX_KEYS.refreshToken, "codex-refresh-stale");
    await credentials.save(CODEX_KEYS.accessExpiresAt, String(NOW_SECONDS + 3600));

    const status = await service.getStatus();
    expect(backend.state.refreshCalls).toEqual(["codex-refresh-stale"]);
    const dump = credentials.dump();
    expect(dump[CODEX_KEYS.accessToken]).toBeUndefined();
    expect(dump[CODEX_KEYS.refreshToken]).toBeUndefined();
    expect(dump[CODEX_KEYS.accessExpiresAt]).toBeUndefined();
    expect(status.accounts[0]?.usageLinked).toBeUndefined();
  });

  it("keeps the codex slot when a refresh fails transiently (429)", async () => {
    const { backend, credentials, service } = await createService({ refreshStatus: 429 });
    await credentials.save(CODEX_KEYS.accessToken, "codex-access-stale");
    await credentials.save(CODEX_KEYS.refreshToken, "codex-refresh-stale");
    await credentials.save(CODEX_KEYS.accessExpiresAt, String(NOW_SECONDS + 3600));

    const status = await service.getStatus();
    expect(backend.state.refreshCalls).toEqual(["codex-refresh-stale"]);
    expect(credentials.dump()[CODEX_KEYS.refreshToken]).toBe("codex-refresh-stale");
    expect(status.accounts[0]?.usageLinked).toBe(true);
  });

  it("clears the codex slot on logout (best-effort revoke, keys removed)", async () => {
    const { backend, credentials, service } = await createService();
    await credentials.save(CODEX_KEYS.accessToken, "codex-access-1");
    await credentials.save(CODEX_KEYS.refreshToken, "codex-refresh-1");
    await credentials.save(CODEX_KEYS.idToken, "codex-id-1");

    const result = await service.logout(ACCOUNT_KEY);
    expect(result.signedOut).toBe(true);
    const dump = credentials.dump();
    expect(dump[CODEX_KEYS.accessToken]).toBeUndefined();
    expect(dump[CODEX_KEYS.refreshToken]).toBeUndefined();
    expect(dump[CODEX_KEYS.idToken]).toBeUndefined();
    expect(backend.state.revokeCalls).toBe(1);
    const status = await service.getStatus();
    expect(status.accounts).toHaveLength(0);
  });
});

describe("readUsageSnapshotFromWhamPayload", () => {
  it("maps both windows and skips a secondary-only reading", () => {
    expect(readUsageSnapshotFromWhamPayload(WHAM_PAYLOAD)).toEqual({
      primary: {
        usedPercent: 17,
        windowMinutes: 300,
        resetsAt: new Date(WHAM_PRIMARY_RESET * 1000).toISOString(),
      },
      secondary: {
        usedPercent: 74,
        windowMinutes: 10080,
        resetsAt: new Date(WHAM_SECONDARY_RESET * 1000).toISOString(),
      },
    });
    expect(
      readUsageSnapshotFromWhamPayload({
        rate_limit: { secondary_window: WHAM_PAYLOAD.rate_limit.secondary_window },
      }),
    ).toBeNull();
  });

  it("returns null for malformed payloads and out-of-range percentages", () => {
    expect(readUsageSnapshotFromWhamPayload(null)).toBeNull();
    expect(readUsageSnapshotFromWhamPayload({})).toBeNull();
    expect(
      readUsageSnapshotFromWhamPayload({ rate_limit: { primary_window: { used_percent: 140 } } }),
    ).toBeNull();
    expect(
      readUsageSnapshotFromWhamPayload({ rate_limit: { primary_window: { used_percent: "17" } } }),
    ).toBeNull();
  });
});
