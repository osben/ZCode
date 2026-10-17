import { createSign, generateKeyPairSync } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountProviderAuthSourceKey,
  buildSiwcAccountProviderIdentityKey,
  SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
  SIWC_ACCOUNTS_LOCK_FILE_NAME,
  SIWC_LEGACY_CREDENTIAL_KEYS,
} from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { withFileLock } from "@zcode/shared/node";
import { SiwcAuthService, createSiwcAccountKey } from "../src/oauth/siwc/siwcAuthService.js";
import { SIWC_ISSUER } from "../src/oauth/siwc/siwcOAuth.js";

const ISSUED_CLIENT_ID = "oaiapp_host_test_client";
const FULL_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const SUB = "user-sub-host-1";
const ACCOUNT_KEY = createSiwcAccountKey(SUB);
const ACCOUNT_KEYS = buildSiwcAccountCredentialKeys(ACCOUNT_KEY);

function createMemoryCredentialService(): ICredentialService & {
  dump(): Record<string, string>;
  writes: Array<[string, string]>;
} {
  const store = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  return {
    async load(key) {
      return store.get(key) ?? null;
    },
    async save(key, value) {
      writes.push([key, value]);
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    dump() {
      return Object.fromEntries(store);
    },
    writes,
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
    jwk: { ...jwk, kid: "host-test-key", kty: "RSA", alg: "RS256", use: "sig" },
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
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "host-test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      iss: SIWC_ISSUER,
      aud,
      exp: NOW_SECONDS + 600,
      nonce,
      email: `${sub}@example.com`,
      name: "Host Test User",
    }),
  ).toString("base64url");
  return `${header}.${payload}.${key.sign(`${header}.${payload}`)}`;
}

/** Fake OP: discovery + JWKS + token endpoint; exchanges any code for a token set. */
function createFakeAuthBackend(options: {
  key: TestKey;
  nonceRef: { value: string };
  scope?: string;
  sub?: string;
  refresh?: () => { accessToken: string; refreshToken: string };
}): { exchangeCalls: string[]; fetchFn: typeof fetch; refreshCalls: string[] } {
  const refreshCalls: string[] = [];
  const exchangeCalls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        jwks_uri: "https://auth.test/jwks",
        revocation_endpoint: "https://auth.test/revoke",
      });
    }
    if (url.endsWith("/jwks")) {
      return Response.json({ keys: [options.key.jwk] });
    }
    if (url.endsWith("/revoke")) {
      refreshCalls.push("revoke");
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("grant_type") === "authorization_code") {
        exchangeCalls.push(body.get("code") ?? "");
        return Response.json({
          access_token: "host-access-1",
          refresh_token: "host-refresh-1",
          id_token: buildIdToken(options.key, options.nonceRef.value, options.sub ?? SUB),
          expires_in: 3600,
          scope: options.scope ?? FULL_SCOPE,
          earliest_refresh_at: NOW_SECONDS + 1800,
        });
      }
      if (body.get("grant_type") === "refresh_token") {
        refreshCalls.push(body.get("refresh_token") ?? "");
        const next = options.refresh?.() ?? {
          accessToken: "host-access-2",
          refreshToken: "host-refresh-2",
        };
        return Response.json({
          access_token: next.accessToken,
          refresh_token: next.refreshToken,
          expires_in: 3600,
        });
      }
    }
    throw new Error(`unexpected auth fetch: ${url}`);
  };
  return { fetchFn, refreshCalls, exchangeCalls };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFixture(options: { scope?: string; sub?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "siwc-host-"));
  tempDirs.push(dir);
  const credentials = createMemoryCredentialService();
  const key = createTestKey();
  const nonceRef = { value: "" };
  const backend = createFakeAuthBackend({
    key,
    nonceRef,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.sub === undefined ? {} : { sub: options.sub }),
  });
  const service = new SiwcAuthService(credentials, {
    configDir: dir,
    fetchFn: backend.fetchFn,
    now: () => NOW_SECONDS * 1000,
  });
  return { backend, credentials, dir, key, nonceRef, service };
}

async function runFullLogin(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: { startOptions?: { reauthAccountKey?: string } } = {},
) {
  const start = await fixture.service.startLogin(options.startOptions ?? {});
  const url = new URL(start.authorizeUrl);
  fixture.nonceRef.value = url.searchParams.get("nonce") ?? "";
  const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  redirect.searchParams.set("state", start.state);
  redirect.searchParams.set("code", "host-auth-code");
  redirect.searchParams.set("client_id", ISSUED_CLIENT_ID);
  const response = await fetch(redirect);
  if (!response.ok) throw new Error(`loopback callback failed: ${response.status}`);
  return { start, url };
}

async function completeBrowserError(
  start: {
    authorizeUrl: string;
    state: string;
  },
  error: string,
): Promise<void> {
  const url = new URL(start.authorizeUrl);
  const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  redirect.searchParams.set("state", start.state);
  redirect.searchParams.set("error", error);
  await fetch(redirect);
}

describe("SiwcAuthService (host side, multi-account)", () => {
  it("runs the full loopback login: PKCE URL, exchange, id-token verify, per-account persistence", async () => {
    const fixture = await createFixture();
    const start = await fixture.service.startLogin();
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("ZCode");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
    fixture.nonceRef.value = url.searchParams.get("nonce") ?? "";

    await expect(fixture.service.pollLogin()).resolves.toBeNull();
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("state", start.state);
    redirect.searchParams.set("code", "host-auth-code");
    redirect.searchParams.set("client_id", ISSUED_CLIENT_ID);
    await fetch(redirect);
    const completion = await fixture.service.pollLogin();
    expect(completion).toMatchObject({
      accountKey: ACCOUNT_KEY,
      newUser: true,
      planUsageEntitled: true,
      signedIn: true,
      user: { displayName: "Host Test User", email: "user-sub-host-1@example.com" },
    });

    const stored = fixture.credentials.dump();
    expect(stored[ACCOUNT_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(stored[ACCOUNT_KEYS.accessToken]).toBe("host-access-1");
    expect(stored[ACCOUNT_KEYS.refreshToken]).toBe("host-refresh-1");
    expect(stored[buildSiwcAccountProviderAuthSourceKey(ACCOUNT_KEY)]).toBe("oauth");
    expect(stored[buildSiwcAccountProviderIdentityKey(ACCOUNT_KEY)]).toBe(SUB);

    const status = await fixture.service.getStatus();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]).toMatchObject({
      accountKey: ACCOUNT_KEY,
      signedIn: true,
      planUsageEntitled: true,
    });
  });

  it("adds a second account and keeps both slots independently", async () => {
    const fixture = await createFixture();
    await runFullLogin(fixture);
    await fixture.service.pollLogin();

    const secondFixture = await createFixture({ sub: "user-sub-host-2" });
    // Reuse the SAME service/credentials so slots share the index.
    const secondBackend = createFakeAuthBackend({
      key: secondFixture.key,
      nonceRef: secondFixture.nonceRef,
      sub: "user-sub-host-2",
    });
    const service = new SiwcAuthService(fixture.credentials, {
      configDir: fixture.dir,
      fetchFn: secondBackend.fetchFn,
      now: () => NOW_SECONDS * 1000,
    });
    const start = await service.startLogin();
    fixture.nonceRef.value = secondFixture.nonceRef.value =
      new URL(start.authorizeUrl).searchParams.get("nonce") ?? "";
    // The second authorize URL must carry no hints even though an account is signed in.
    const url = new URL(start.authorizeUrl);
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("id_token_hint")).toBeNull();
    expect(url.searchParams.get("login_hint")).toBeNull();
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("state", start.state);
    redirect.searchParams.set("code", "host-auth-code-2");
    redirect.searchParams.set("client_id", ISSUED_CLIENT_ID);
    await fetch(redirect);
    const completion = await service.pollLogin();
    const secondKey = createSiwcAccountKey("user-sub-host-2");
    expect(completion).toMatchObject({ accountKey: secondKey, newUser: true });

    const status = await service.getStatus();
    expect(status.accounts.map((account) => account.accountKey).sort()).toEqual(
      [ACCOUNT_KEY, secondKey].sort(),
    );
    // The first account's tokens survive the second login.
    expect(fixture.credentials.dump()[ACCOUNT_KEYS.accessToken]).toBe("host-access-1");
  });

  it("re-auth mode sends the account's client id and hints", async () => {
    const fixture = await createFixture();
    await runFullLogin(fixture);
    await fixture.service.pollLogin();

    const start = await fixture.service.startLogin({ reauthAccountKey: ACCOUNT_KEY });
    const url = new URL(start.authorizeUrl);
    expect(url.searchParams.get("client_id")).toBe(ISSUED_CLIENT_ID);
    expect(url.searchParams.get("id_token_hint")).toBeTypeOf("string");
    expect(url.searchParams.get("login_hint")).toBe("user-sub-host-1@example.com");
    expect(url.searchParams.get("agent_name_hint")).toBeNull();
    await fixture.service.cancelLogin();
  });

  it("claims a completed login before exchanging its authorization code", async () => {
    const fixture = await createFixture();
    const start = await fixture.service.startLogin();
    fixture.nonceRef.value = new URL(start.authorizeUrl).searchParams.get("nonce") ?? "";
    const redirect = new URL(new URL(start.authorizeUrl).searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("state", start.state);
    redirect.searchParams.set("code", "host-auth-code");
    redirect.searchParams.set("client_id", ISSUED_CLIENT_ID);
    await fetch(redirect);

    const [first, second] = await Promise.all([
      fixture.service.pollLogin(),
      fixture.service.pollLogin(),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(fixture.backend.exchangeCalls).toEqual(["host-auth-code"]);
  });

  it("stops accepting callback connections before force-closing the remaining ones", async () => {
    const fixture = await createFixture();
    const start = await fixture.service.startLogin();
    fixture.nonceRef.value = new URL(start.authorizeUrl).searchParams.get("nonce") ?? "";
    const redirect = new URL(new URL(start.authorizeUrl).searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("state", start.state);
    redirect.searchParams.set("code", "host-auth-code");
    redirect.searchParams.set("client_id", ISSUED_CLIENT_ID);
    await fetch(redirect);
    const closeOrder: string[] = [];
    const close = Server.prototype.close;
    const closeAllConnections = Server.prototype.closeAllConnections;
    vi.spyOn(Server.prototype, "close").mockImplementation(function (callback) {
      closeOrder.push("close");
      return close.call(this, callback);
    });
    vi.spyOn(Server.prototype, "closeAllConnections").mockImplementation(function () {
      closeOrder.push("closeAllConnections");
      return closeAllConnections.call(this);
    });

    try {
      await fixture.service.pollLogin();
      expect(closeOrder).toEqual(["close", "closeAllConnections"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("closes the callback server and clears pending login when the callback rejects", async () => {
    const fixture = await createFixture();
    const start = await fixture.service.startLogin();
    await completeBrowserError(start, "access_denied");

    await expect(fixture.service.pollLogin()).rejects.toThrow();
    await expect(fixture.service.pollLogin()).resolves.toBeNull();
    const callbackUrl = new URL(new URL(start.authorizeUrl).searchParams.get("redirect_uri") ?? "");
    callbackUrl.searchParams.set("state", start.state);
    await expect(fetch(callbackUrl)).rejects.toThrow();
    await expect(fixture.service.startLogin()).resolves.toMatchObject({
      state: expect.any(String),
    });
    await fixture.service.cancelLogin();
  });

  it("reports identity-only sign-in when consent lacked the plan scope", async () => {
    const fixture = await createFixture({ scope: "openid profile email" });
    await runFullLogin(fixture);
    const completion = await fixture.service.pollLogin();
    expect(completion?.planUsageEntitled).toBe(false);
    expect(completion?.signedIn).toBe(true);
  });

  it("revokes and clears only the requested account on logout", async () => {
    const fixture = await createFixture();
    await runFullLogin(fixture);
    await fixture.service.pollLogin();
    // Sign the second account in through the index so the isolation check is real:
    // logout(ACCOUNT_KEY) must leave the other indexed account fully intact.
    const secondKey = createSiwcAccountKey("user-sub-host-2");
    const secondKeys = buildSiwcAccountCredentialKeys(secondKey);
    fixture.credentials.save(secondKeys.clientId, ISSUED_CLIENT_ID);
    fixture.credentials.save(secondKeys.accessToken, "host-access-b");
    fixture.credentials.save(secondKeys.refreshToken, "host-refresh-b");
    const indexRaw = await fixture.credentials.load(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY);
    fixture.credentials.save(
      SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
      JSON.stringify([
        ...(indexRaw ? (JSON.parse(indexRaw) as unknown[]) : []),
        { accountKey: secondKey, sub: "user-sub-host-2", email: null, name: null, addedAt: "" },
      ]),
    );

    const result = await fixture.service.logout(ACCOUNT_KEY);
    expect(result).toEqual({ accountCount: 1, revoked: true, signedOut: true });
    expect(fixture.backend.refreshCalls).toContain("revoke");
    const stored = fixture.credentials.dump();
    expect(stored[ACCOUNT_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(stored[ACCOUNT_KEYS.accessToken]).toBeUndefined();
    expect(stored[secondKeys.accessToken]).toBe("host-access-b");
    const status = await fixture.service.getStatus();
    expect(status.accounts.map((account) => account.accountKey)).toEqual([secondKey]);
  });

  it("logout without a key revokes every signed-in account", async () => {
    const fixture = await createFixture();
    await runFullLogin(fixture);
    await fixture.service.pollLogin();

    const result = await fixture.service.logout();
    expect(result).toEqual({ accountCount: 1, revoked: true, signedOut: true });
    const status = await fixture.service.getStatus();
    expect(status.accounts).toHaveLength(0);
  });

  it("migrates legacy flat credentials into the account slot", async () => {
    const fixture = await createFixture();
    const legacy = SIWC_LEGACY_CREDENTIAL_KEYS;
    fixture.credentials.save(legacy.clientId, ISSUED_CLIENT_ID);
    fixture.credentials.save(legacy.accessToken, "legacy-access");
    fixture.credentials.save(legacy.refreshToken, "legacy-refresh");
    fixture.credentials.save(legacy.scopes, FULL_SCOPE);
    fixture.credentials.save(
      legacy.userInfo,
      JSON.stringify({ sub: SUB, email: "legacy@example.com" }),
    );
    fixture.credentials.save(legacy.accessExpiresAt, String(NOW_SECONDS + 3600));

    const status = await fixture.service.getStatus();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]).toMatchObject({ accountKey: ACCOUNT_KEY, signedIn: true });
    const stored = fixture.credentials.dump();
    expect(stored[ACCOUNT_KEYS.accessToken]).toBe("legacy-access");
    expect(stored[legacy.accessToken]).toBeUndefined();
    expect(stored[legacy.clientId]).toBeUndefined();
    // The migrated token resolves through the standard per-account path.
    expect(await fixture.service.resolveAccessToken(ACCOUNT_KEY)).toBe("legacy-access");
  });

  it("records passively captured usage per account and surfaces it in getStatus", async () => {
    const fixture = await createFixture();
    fixture.credentials.save(
      SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
      JSON.stringify([{ accountKey: ACCOUNT_KEY, sub: SUB, email: null, name: null, addedAt: "" }]),
    );
    fixture.credentials.save(ACCOUNT_KEYS.accessToken, "host-access-1");
    fixture.credentials.save(ACCOUNT_KEYS.scopes, FULL_SCOPE);

    // Before any turn carried usage headers, no usage is reported.
    expect((await fixture.service.getStatus()).accounts[0]?.usage).toBeUndefined();

    const snapshot = {
      primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: "2026-10-15T18:00:00Z" },
      secondary: { usedPercent: 7 },
    };
    fixture.service.recordUsage(ACCOUNT_KEY, snapshot);
    expect((await fixture.service.getStatus()).accounts[0]?.usage).toEqual(snapshot);

    // Unknown or malformed account keys are ignored, never stored.
    fixture.service.recordUsage("not-an-account-key", snapshot);
    fixture.service.recordUsage("", snapshot);
    const status = await fixture.service.getStatus();
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0]?.usage).toEqual(snapshot);

    // Logout drops the account's in-memory usage with it.
    fixture.credentials.save(ACCOUNT_KEYS.clientId, ISSUED_CLIENT_ID);
    fixture.credentials.save(ACCOUNT_KEYS.refreshToken, "host-refresh-1");
    await fixture.service.logout(ACCOUNT_KEY);
    expect((await fixture.service.getStatus()).accounts).toHaveLength(0);
    // A stale post-logout event stores nothing visible while the account is gone: usage is
    // only surfaced for accounts present in the index.
    fixture.service.recordUsage(ACCOUNT_KEY, snapshot);
    const afterLogout = await fixture.service.getStatus();
    expect(afterLogout.accounts).toHaveLength(0);
  });

  it("replaces the previous registration's bundle instead of merging it", async () => {
    const fixture = await createFixture();
    await runFullLogin(fixture);
    await fixture.service.pollLogin();
    // Same subject re-registered: fresh client id, access token, but NO refresh token.
    const second = await createFixture();
    const reauthBackend = createFakeAuthBackend({
      key: second.key,
      nonceRef: second.nonceRef,
      refresh: undefined,
    });
    const service = new SiwcAuthService(fixture.credentials, {
      configDir: fixture.dir,
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/oauth/token")) {
          const body = new URLSearchParams(String(init?.body ?? ""));
          if (body.get("grant_type") === "authorization_code") {
            // Fresh registration: new client id pair, access-only grant.
            return Response.json({
              access_token: "new-access",
              id_token: buildIdToken(second.key, second.nonceRef.value, SUB, "oaiapp_new_client"),
              expires_in: 3600,
              scope: FULL_SCOPE,
            });
          }
        }
        return reauthBackend.fetchFn(input, init);
      },
      now: () => NOW_SECONDS * 1000,
    });
    const start = await service.startLogin();
    second.nonceRef.value = new URL(start.authorizeUrl).searchParams.get("nonce") ?? "";
    const redirect = new URL(new URL(start.authorizeUrl).searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("state", start.state);
    redirect.searchParams.set("code", "reauth-code");
    redirect.searchParams.set("client_id", "oaiapp_new_client");
    await fetch(redirect);
    const completion = await service.pollLogin();
    expect(completion).toMatchObject({ accountKey: ACCOUNT_KEY, newUser: false });

    const stored = fixture.credentials.dump();
    expect(stored[ACCOUNT_KEYS.clientId]).toBe("oaiapp_new_client");
    expect(stored[ACCOUNT_KEYS.accessToken]).toBe("new-access");
    // The previous registration's refresh token must NOT survive next to the new client id.
    expect(stored[ACCOUNT_KEYS.refreshToken]).toBeUndefined();
  });

  it("waits for an in-flight refresh lock before replacing the slot", async () => {
    const fixture = await createFixture();
    fixture.credentials.save(ACCOUNT_KEYS.clientId, ISSUED_CLIENT_ID);
    fixture.credentials.save(ACCOUNT_KEYS.accessToken, "stale-access");
    fixture.credentials.save(ACCOUNT_KEYS.refreshToken, "stale-refresh");

    // Hold the per-account refresh lock the way an in-flight refresh would.
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHeld = withFileLock(
      join(fixture.dir, `siwc-chatgpt.${ACCOUNT_KEY}.refresh`),
      () => locked,
    );
    const loginPromise = (async () => {
      await runFullLogin(fixture);
      return fixture.service.pollLogin();
    })();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Login completed on the wire, but the slot must not be replaced while the lock is held.
    expect(fixture.credentials.dump()[ACCOUNT_KEYS.accessToken]).toBe("stale-access");
    releaseLock();
    await lockHeld;
    const completion = await loginPromise;
    expect(completion).toMatchObject({ accountKey: ACCOUNT_KEY });
    expect(fixture.credentials.dump()[ACCOUNT_KEYS.accessToken]).toBe("host-access-1");
  });

  it("completes an interrupted migration instead of losing the refresh token", async () => {
    const fixture = await createFixture();
    const legacy = SIWC_LEGACY_CREDENTIAL_KEYS;
    await fixture.credentials.save(legacy.clientId, ISSUED_CLIENT_ID);
    await fixture.credentials.save(legacy.accessToken, "legacy-access");
    await fixture.credentials.save(legacy.refreshToken, "legacy-refresh");
    await fixture.credentials.save(
      legacy.userInfo,
      JSON.stringify({ sub: SUB, email: "legacy@example.com" }),
    );
    // Partial first attempt: only clientId + accessToken landed in the slot before a crash.
    await fixture.credentials.save(ACCOUNT_KEYS.clientId, ISSUED_CLIENT_ID);
    await fixture.credentials.save(ACCOUNT_KEYS.accessToken, "legacy-access");

    const status = await fixture.service.getStatus();
    expect(status.accounts).toHaveLength(1);
    const stored = fixture.credentials.dump();
    expect(stored[ACCOUNT_KEYS.refreshToken]).toBe("legacy-refresh");
    expect(stored[legacy.refreshToken]).toBeUndefined();
  });

  it("waits for an in-flight refresh lock before clearing on logout", async () => {
    const fixture = await createFixture();
    await runFullLogin(fixture);
    await fixture.service.pollLogin();
    // Hold the per-account refresh lock the way an in-flight refresh would.
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHeld = withFileLock(
      join(fixture.dir, `siwc-chatgpt.${ACCOUNT_KEY}.refresh`),
      () => locked,
    );
    const logoutPromise = fixture.service.logout();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Logout is queued behind the lock: the slot must not be cleared yet.
    expect(fixture.credentials.dump()[ACCOUNT_KEYS.accessToken]).toBe("host-access-1");
    releaseLock();
    await lockHeld;
    const result = await logoutPromise;
    expect(result).toEqual({ accountCount: 1, revoked: true, signedOut: true });
    expect(fixture.credentials.dump()[ACCOUNT_KEYS.accessToken]).toBeUndefined();
  });

  it("reports revoked=false and clears an access-only slot on logout", async () => {
    const fixture = await createFixture();
    await runFullLogin(fixture);
    await fixture.service.pollLogin();
    // Access-only registration: no refresh token, so no revocation can be attempted.
    fixture.credentials.delete(ACCOUNT_KEYS.refreshToken);
    const result = await fixture.service.logout();
    expect(result).toEqual({ accountCount: 1, revoked: false, signedOut: true });
    const stored = fixture.credentials.dump();
    expect(stored[ACCOUNT_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(stored[ACCOUNT_KEYS.accessToken]).toBeUndefined();
    expect((await fixture.service.getStatus()).accounts).toHaveLength(0);
  });

  it("waits for an in-flight refresh lock before migrating the legacy bundle", async () => {
    const fixture = await createFixture();
    const legacy = SIWC_LEGACY_CREDENTIAL_KEYS;
    fixture.credentials.save(legacy.clientId, ISSUED_CLIENT_ID);
    fixture.credentials.save(legacy.accessToken, "legacy-access");
    fixture.credentials.save(legacy.refreshToken, "legacy-refresh");
    fixture.credentials.save(legacy.userInfo, JSON.stringify({ sub: SUB }));
    // Hold the destination account's per-account refresh lock the way login/refresh would.
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHeld = withFileLock(
      join(fixture.dir, `siwc-chatgpt.${ACCOUNT_KEY}.refresh`),
      () => locked,
    );
    const statusPromise = fixture.service.getStatus();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The migration must not copy into the slot while the refresh lock is held.
    expect(fixture.credentials.dump()[ACCOUNT_KEYS.accessToken]).toBeUndefined();
    releaseLock();
    await lockHeld;
    const status = await statusPromise;
    expect(status.accounts).toHaveLength(1);
    expect(fixture.credentials.dump()[ACCOUNT_KEYS.accessToken]).toBe("legacy-access");
  });

  it("resolves a time-valid access token without refresh and rotates near expiry", async () => {
    const fixture = await createFixture();
    fixture.credentials.save(ACCOUNT_KEYS.clientId, ISSUED_CLIENT_ID);
    fixture.credentials.save(ACCOUNT_KEYS.accessToken, "host-access-1");
    fixture.credentials.save(ACCOUNT_KEYS.refreshToken, "host-refresh-1");
    fixture.credentials.save(ACCOUNT_KEYS.scopes, FULL_SCOPE);
    fixture.credentials.save(ACCOUNT_KEYS.accessExpiresAt, String(NOW_SECONDS + 3600));

    expect(await fixture.service.resolveAccessToken(ACCOUNT_KEY)).toBe("host-access-1");
    expect(fixture.backend.refreshCalls).not.toContain("host-refresh-1");

    // Expire the stored token; the resolver must refresh and persist rotation.
    fixture.credentials.save(ACCOUNT_KEYS.accessExpiresAt, String(NOW_SECONDS - 10));
    fixture.credentials.writes.length = 0;
    expect(await fixture.service.resolveAccessToken(ACCOUNT_KEY)).toBe("host-access-2");
    expect(fixture.backend.refreshCalls).toContain("host-refresh-1");
    const stored = fixture.credentials.dump();
    expect(stored[ACCOUNT_KEYS.accessToken]).toBe("host-access-2");
    expect(stored[ACCOUNT_KEYS.refreshToken]).toBe("host-refresh-2");
    expect(fixture.credentials.writes.slice(0, 2).map(([key]) => key)).toEqual([
      ACCOUNT_KEYS.refreshToken,
      ACCOUNT_KEYS.accessToken,
    ]);
  });

  it("does not take the accounts lock for host token resolution without legacy credentials", async () => {
    const fixture = await createFixture();
    await fixture.credentials.save(ACCOUNT_KEYS.clientId, ISSUED_CLIENT_ID);
    await fixture.credentials.save(ACCOUNT_KEYS.accessToken, "host-access-valid");
    await fixture.credentials.save(ACCOUNT_KEYS.refreshToken, "host-refresh-valid");
    await fixture.credentials.save(ACCOUNT_KEYS.accessExpiresAt, String(NOW_SECONDS + 3600));

    await expect(fixture.service.resolveAccessToken(ACCOUNT_KEY)).resolves.toBe(
      "host-access-valid",
    );
    await expect(access(join(fixture.dir, SIWC_ACCOUNTS_LOCK_FILE_NAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cancels a pending login and reports no accounts afterwards", async () => {
    const fixture = await createFixture();
    await fixture.service.startLogin();
    await fixture.service.cancelLogin();
    await expect(fixture.service.pollLogin()).resolves.toBeNull();
    expect((await fixture.service.getStatus()).accounts).toHaveLength(0);
  });
});
