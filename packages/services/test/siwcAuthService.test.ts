import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICredentialService } from "../src/credential/credential.js";
import { SiwcAuthService } from "../src/oauth/siwc/siwcAuthService.js";
import { SIWC_CREDENTIAL_KEYS, SIWC_ISSUER } from "../src/oauth/siwc/siwcOAuth.js";

const ISSUED_CLIENT_ID = "oaiapp_host_test_client";
const FULL_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const NOW_SECONDS = Math.floor(Date.now() / 1000);

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

function buildIdToken(key: TestKey, nonce: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "host-test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "user-sub-host-1",
      iss: SIWC_ISSUER,
      aud: ISSUED_CLIENT_ID,
      exp: NOW_SECONDS + 600,
      nonce,
      email: "user@example.com",
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
          id_token: buildIdToken(options.key, options.nonceRef.value),
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

async function createFixture(options: { scope?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "siwc-host-"));
  tempDirs.push(dir);
  const credentials = createMemoryCredentialService();
  const key = createTestKey();
  const nonceRef = { value: "" };
  const backend = createFakeAuthBackend({ key, nonceRef, ...options });
  const service = new SiwcAuthService(credentials, {
    configDir: dir,
    fetchFn: backend.fetchFn,
    now: () => NOW_SECONDS * 1000,
  });
  return { backend, credentials, dir, key, nonceRef, service };
}

async function completeBrowserRedirect(start: {
  authorizeUrl: string;
  state: string;
}): Promise<void> {
  const url = new URL(start.authorizeUrl);
  const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  redirect.searchParams.set("state", start.state);
  redirect.searchParams.set("code", "host-auth-code");
  redirect.searchParams.set("client_id", ISSUED_CLIENT_ID);
  const response = await fetch(redirect);
  if (!response.ok) throw new Error(`loopback callback failed: ${response.status}`);
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

describe("SiwcAuthService (host side)", () => {
  it("runs the full loopback login: PKCE URL, exchange, id-token verify, persistence", async () => {
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
    await completeBrowserRedirect(start);
    const completion = await fixture.service.pollLogin();
    expect(completion).toMatchObject({
      newUser: true,
      planUsageEntitled: true,
      signedIn: true,
      user: { displayName: "Host Test User", email: "user@example.com" },
    });

    const stored = fixture.credentials.dump();
    expect(stored[SIWC_CREDENTIAL_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(stored[SIWC_CREDENTIAL_KEYS.accessToken]).toBe("host-access-1");
    expect(stored[SIWC_CREDENTIAL_KEYS.refreshToken]).toBe("host-refresh-1");
    expect(stored["account-provider:account:chatgpt-plan:auth-source"]).toBe("oauth");

    const status = await fixture.service.getStatus();
    expect(status).toMatchObject({ signedIn: true, planUsageEntitled: true });
  });

  it("claims a completed login before exchanging its authorization code", async () => {
    const fixture = await createFixture();
    const start = await fixture.service.startLogin();
    fixture.nonceRef.value = new URL(start.authorizeUrl).searchParams.get("nonce") ?? "";
    await completeBrowserRedirect(start);

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
    await completeBrowserRedirect(start);
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
    const start = await fixture.service.startLogin();
    fixture.nonceRef.value = new URL(start.authorizeUrl).searchParams.get("nonce") ?? "";
    await completeBrowserRedirect(start);
    const completion = await fixture.service.pollLogin();
    expect(completion?.planUsageEntitled).toBe(false);
    expect(completion?.signedIn).toBe(true);
  });

  it("revokes and clears tokens on logout while retaining the client id", async () => {
    const fixture = await createFixture();
    const start = await fixture.service.startLogin();
    fixture.nonceRef.value = new URL(start.authorizeUrl).searchParams.get("nonce") ?? "";
    await completeBrowserRedirect(start);
    await fixture.service.pollLogin();

    const result = await fixture.service.logout();
    expect(result).toEqual({ revoked: true, signedOut: true });
    expect(fixture.backend.refreshCalls).toContain("revoke");
    const stored = fixture.credentials.dump();
    expect(stored[SIWC_CREDENTIAL_KEYS.clientId]).toBe(ISSUED_CLIENT_ID);
    expect(stored[SIWC_CREDENTIAL_KEYS.accessToken]).toBeUndefined();
    expect(await fixture.service.getStatus()).toMatchObject({ signedIn: false });
  });

  it("resolves a time-valid access token without refresh and rotates near expiry", async () => {
    const fixture = await createFixture();
    fixture.credentials.save(SIWC_CREDENTIAL_KEYS.clientId, ISSUED_CLIENT_ID);
    fixture.credentials.save(SIWC_CREDENTIAL_KEYS.accessToken, "host-access-1");
    fixture.credentials.save(SIWC_CREDENTIAL_KEYS.refreshToken, "host-refresh-1");
    fixture.credentials.save(SIWC_CREDENTIAL_KEYS.scopes, FULL_SCOPE);
    fixture.credentials.save(SIWC_CREDENTIAL_KEYS.accessExpiresAt, String(NOW_SECONDS + 3600));

    expect(await fixture.service.resolveAccessToken()).toBe("host-access-1");
    expect(fixture.backend.refreshCalls).not.toContain("host-refresh-1");

    // Expire the stored token; the resolver must refresh and persist rotation.
    fixture.credentials.save(SIWC_CREDENTIAL_KEYS.accessExpiresAt, String(NOW_SECONDS - 10));
    fixture.credentials.writes.length = 0;
    expect(await fixture.service.resolveAccessToken()).toBe("host-access-2");
    expect(fixture.backend.refreshCalls).toContain("host-refresh-1");
    const stored = fixture.credentials.dump();
    expect(stored[SIWC_CREDENTIAL_KEYS.accessToken]).toBe("host-access-2");
    expect(stored[SIWC_CREDENTIAL_KEYS.refreshToken]).toBe("host-refresh-2");
    expect(fixture.credentials.writes.slice(0, 2).map(([key]) => key)).toEqual([
      SIWC_CREDENTIAL_KEYS.refreshToken,
      SIWC_CREDENTIAL_KEYS.accessToken,
    ]);
  });

  it("cancels a pending login and reports not signed in afterwards", async () => {
    const fixture = await createFixture();
    await fixture.service.startLogin();
    await fixture.service.cancelLogin();
    await expect(fixture.service.pollLogin()).resolves.toBeNull();
    expect(await fixture.service.getStatus()).toMatchObject({ signedIn: false });
  });
});
