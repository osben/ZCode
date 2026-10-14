import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  createSiwcAccessTokenResolver,
  isSiwcPlanEntitled,
  SIWC_CREDENTIAL_KEYS,
  SiwcReloginRequiredError,
  type SiwcTokenClient,
  type SiwcTokenResponse,
} from "../src/auth/siwc/index.js";

const TEST_ENV = { ZCODE_CREDENTIAL_SECRET: "resolver-test-secret" };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "siwc-resolver-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
}

function seedTokens(
  store: ReturnType<typeof createSharedZCodeCredentialStore>,
  input: { accessToken: string; expiresAt: number; refreshToken: string },
): Promise<void> {
  return store.saveMany({
    [SIWC_CREDENTIAL_KEYS.clientId]: "oaiapp_issued",
    [SIWC_CREDENTIAL_KEYS.accessToken]: input.accessToken,
    [SIWC_CREDENTIAL_KEYS.refreshToken]: input.refreshToken,
    [SIWC_CREDENTIAL_KEYS.scopes]:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    [SIWC_CREDENTIAL_KEYS.userInfo]: JSON.stringify({ sub: "user-sub-1", email: "u@example.com" }),
    [SIWC_CREDENTIAL_KEYS.accessExpiresAt]: String(input.expiresAt),
  });
}

const NOW_SECONDS = 1_770_000_000;

function createFakeTokenClient(responses: SiwcTokenResponse[]) {
  const refreshCalls: { clientId: string; refreshToken: string }[] = [];
  const tokenClient: SiwcTokenClient = {
    async exchangeCode() {
      throw new Error("exchange not expected in resolver tests");
    },
    async refresh(input) {
      refreshCalls.push({ clientId: input.clientId, refreshToken: input.refreshToken });
      const next = responses.shift();
      if (!next) throw new Error("unexpected refresh call");
      return next;
    },
    async revoke() {
      throw new Error("revoke not expected in resolver tests");
    },
  };
  return { refreshCalls, tokenClient };
}

describe("SIWC access token resolver", () => {
  it("returns a usable token without refreshing", async () => {
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-1",
      expiresAt: NOW_SECONDS + 3600,
      refreshToken: "refresh-1",
    });
    const { refreshCalls, tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const resolved = await resolver.resolve({ providerId: "account:chatgpt-plan" });
    expect(resolved.apiKey).toBe("access-1");
    expect(resolved.accountScope).toMatch(/^[0-9a-f]{64}$/u);
    expect(refreshCalls).toHaveLength(0);
  });

  it("refreshes near expiry with the issued client id and persists rotation atomically", async () => {
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-1",
      expiresAt: NOW_SECONDS + 60,
      refreshToken: "refresh-1",
    });
    const { refreshCalls, tokenClient } = createFakeTokenClient([
      {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresInSeconds: 3600,
        earliestRefreshAt: NOW_SECONDS + 1800,
      },
    ]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const resolved = await resolver.resolve({ providerId: "account:chatgpt-plan" });
    expect(resolved.apiKey).toBe("access-2");
    expect(refreshCalls).toEqual([{ clientId: "oaiapp_issued", refreshToken: "refresh-1" }]);
    const after = await store.loadMany([
      SIWC_CREDENTIAL_KEYS.accessToken,
      SIWC_CREDENTIAL_KEYS.refreshToken,
      SIWC_CREDENTIAL_KEYS.accessExpiresAt,
      SIWC_CREDENTIAL_KEYS.earliestRefreshAt,
    ]);
    expect(after[SIWC_CREDENTIAL_KEYS.accessToken]).toBe("access-2");
    expect(after[SIWC_CREDENTIAL_KEYS.refreshToken]).toBe("refresh-2");
    expect(after[SIWC_CREDENTIAL_KEYS.accessExpiresAt]).toBe(String(NOW_SECONDS + 3600));
    expect(after[SIWC_CREDENTIAL_KEYS.earliestRefreshAt]).toBe(String(NOW_SECONDS + 1800));
  });

  it("coalesces concurrent resolves into a single refresh", async () => {
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-1",
      expiresAt: NOW_SECONDS - 10,
      refreshToken: "refresh-1",
    });
    const { refreshCalls, tokenClient } = createFakeTokenClient([
      { accessToken: "access-2", refreshToken: "refresh-2", expiresInSeconds: 3600 },
    ]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const [a, b, c] = await Promise.all([
      resolver.resolve({ providerId: "account:chatgpt-plan" }),
      resolver.resolve({ providerId: "account:chatgpt-plan" }),
      resolver.resolve({ providerId: "account:chatgpt-plan" }),
    ]);
    expect(a.apiKey).toBe("access-2");
    expect(b.apiKey).toBe("access-2");
    expect(c.apiKey).toBe("access-2");
    expect(refreshCalls).toHaveLength(1);
  });

  it("clears tokens but retains the client id on terminal refresh errors", async () => {
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-1",
      expiresAt: NOW_SECONDS - 10,
      refreshToken: "refresh-1",
    });
    const tokenClient: SiwcTokenClient = {
      async exchangeCode() {
        throw new Error("unused");
      },
      async refresh() {
        const error = new Error("SIWC OAuth error refresh_token_reused") as Error & {
          error: string;
        };
        error.error = "refresh_token_reused";
        throw error;
      },
      async revoke() {
        throw new Error("unused");
      },
    };
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const error = await resolver
      .resolve({ providerId: "account:chatgpt-plan" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SiwcReloginRequiredError);
    const after = await store.loadMany([
      SIWC_CREDENTIAL_KEYS.clientId,
      SIWC_CREDENTIAL_KEYS.accessToken,
      SIWC_CREDENTIAL_KEYS.refreshToken,
      SIWC_CREDENTIAL_KEYS.scopes,
    ]);
    // Retention rule shared with logout: keep the issued client id, drop tokens.
    expect(after[SIWC_CREDENTIAL_KEYS.clientId]).toBe("oaiapp_issued");
    expect(after[SIWC_CREDENTIAL_KEYS.accessToken]).toBeNull();
    expect(after[SIWC_CREDENTIAL_KEYS.refreshToken]).toBeNull();
    expect(after[SIWC_CREDENTIAL_KEYS.scopes]).toBeNull();
    expect(await isSiwcPlanEntitled(store)).toBe(false);
  });

  it("requires sign-in when no credentials exist", async () => {
    const store = await createStore();
    const { tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    await expect(resolver.resolve({ providerId: "account:chatgpt-plan" })).rejects.toMatchObject({
      name: "SiwcReloginRequiredError",
      reason: "not_signed_in",
    });
  });

  it("refreshes through the DEFAULT token client in production wiring (no injected client)", async () => {
    // Regression: refreshLocked previously ignored the defaulted client, so the production
    // construction (credential store only) could never refresh.
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-1",
      expiresAt: NOW_SECONDS - 10,
      refreshToken: "refresh-1",
    });
    const tokenRequests: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      tokenRequests.push(String(init?.body ?? ""));
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    };
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      fetchFn,
      now: () => NOW_SECONDS * 1000,
    });
    const resolved = await resolver.resolve({ providerId: "account:chatgpt-plan" });
    expect(resolved.apiKey).toBe("access-2");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toContain("grant_type=refresh_token");
    expect(tokenRequests[0]).toContain("client_id=oaiapp_issued");
    expect(await store.load(SIWC_CREDENTIAL_KEYS.refreshToken)).toBe("refresh-2");
  });

  it("keeps the account scope stable across token rotation (account-switch fingerprint only)", async () => {
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-1",
      expiresAt: NOW_SECONDS + 3600,
      refreshToken: "refresh-1",
    });
    const { tokenClient } = createFakeTokenClient([
      { accessToken: "access-2", refreshToken: "refresh-2", expiresInSeconds: 3600 },
    ]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const before = await resolver.resolve({ providerId: "account:chatgpt-plan" });
    // Simulate expiry + rotation.
    await store.save(SIWC_CREDENTIAL_KEYS.accessExpiresAt, String(NOW_SECONDS + 60));
    const { tokenClient: second } = createFakeTokenClient([
      { accessToken: "access-3", refreshToken: "refresh-3", expiresInSeconds: 3600 },
    ]);
    const resolverAfterRotation = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient: second,
      now: () => NOW_SECONDS * 1000,
    });
    const after = await resolverAfterRotation.resolve({ providerId: "account:chatgpt-plan" });
    expect(after.apiKey).toBe("access-3");
    expect(after.accountScope).toBe(before.accountScope);
  });

  it("forceRefresh rotates even a time-valid token (401 retry must not resend it)", async () => {
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-rejected",
      expiresAt: NOW_SECONDS + 3600,
      refreshToken: "refresh-1",
    });
    const { refreshCalls, tokenClient } = createFakeTokenClient([
      { accessToken: "access-fresh", refreshToken: "refresh-2", expiresInSeconds: 3600 },
    ]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const resolved = await resolver.resolve({
      providerId: "account:chatgpt-plan",
      forceRefresh: true,
    });
    expect(resolved.apiKey).toBe("access-fresh");
    expect(refreshCalls).toEqual([{ clientId: "oaiapp_issued", refreshToken: "refresh-1" }]);
  });

  it("keeps the current token before earliest_refresh_at", async () => {
    const store = await createStore();
    await seedTokens(store, {
      accessToken: "access-1",
      expiresAt: NOW_SECONDS + 60,
      refreshToken: "refresh-1",
    });
    await store.save(SIWC_CREDENTIAL_KEYS.earliestRefreshAt, String(NOW_SECONDS + 120));
    const { refreshCalls, tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const resolved = await resolver.resolve({ providerId: "account:chatgpt-plan" });
    expect(resolved.apiKey).toBe("access-1");
    expect(refreshCalls).toHaveLength(0);
  });
});
