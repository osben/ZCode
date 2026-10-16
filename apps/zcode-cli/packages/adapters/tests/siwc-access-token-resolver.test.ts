import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildChatGptPlanAccountProviderId,
  buildSiwcAccountCredentialKeys,
  SIWC_ACCOUNTS_LOCK_FILE_NAME,
  SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
  SIWC_LEGACY_CREDENTIAL_KEYS,
} from "@zcode/shared";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  createSiwcAccessTokenResolver,
  createSiwcAccountKey,
  isSiwcPlanEntitled,
  listSiwcPlanAccounts,
  migrateLegacySiwcCredentials,
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

const SUB_1 = "user-sub-1";
const ACCOUNT_KEY_1 = createSiwcAccountKey(SUB_1);
const PROVIDER_ID_1 = buildChatGptPlanAccountProviderId(ACCOUNT_KEY_1);
const KEYS_1 = buildSiwcAccountCredentialKeys(ACCOUNT_KEY_1);
const FULL_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

async function seedAccount(
  store: ReturnType<typeof createSharedZCodeCredentialStore>,
  input: {
    accountKey: string;
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
    sub?: string;
    email?: string;
  },
): Promise<void> {
  const keys = buildSiwcAccountCredentialKeys(input.accountKey);
  const sub = input.sub ?? SUB_1;
  await store.saveMany({
    [keys.clientId]: "oaiapp_issued",
    [keys.accessToken]: input.accessToken,
    [keys.refreshToken]: input.refreshToken,
    [keys.scopes]: FULL_SCOPES,
    [keys.userInfo]: JSON.stringify({
      sub,
      ...(input.email ? { email: input.email } : {}),
    }),
    [keys.accessExpiresAt]: String(input.expiresAt),
  });
  const index = await store.load(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY);
  const records = index ? (JSON.parse(index) as unknown[]) : [];
  const record = { accountKey: input.accountKey, sub, email: input.email ?? null, name: null, addedAt: "" };
  const next = records.filter(
    (entry) => (entry as { accountKey?: string }).accountKey !== input.accountKey,
  );
  next.push(record);
  await store.save(SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY, JSON.stringify(next));
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

describe("SIWC access token resolver (per-account)", () => {
  it("returns a usable token without refreshing", async () => {
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
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
    const resolved = await resolver.resolve({ providerId: PROVIDER_ID_1 });
    expect(resolved.apiKey).toBe("access-1");
    expect(resolved.accountScope).toMatch(/^[0-9a-f]{64}$/u);
    expect(refreshCalls).toHaveLength(0);
  });

  it("rejects provider ids that are not per-account entries", async () => {
    const store = await createStore();
    const { tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    await expect(
      resolver.resolve({ providerId: "account:chatgpt-plan" }),
    ).rejects.toThrow(/per-account/u);
  });

  it("refreshes near expiry with the issued client id and persists rotation atomically", async () => {
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
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
    const resolved = await resolver.resolve({ providerId: PROVIDER_ID_1 });
    expect(resolved.apiKey).toBe("access-2");
    expect(refreshCalls).toEqual([{ clientId: "oaiapp_issued", refreshToken: "refresh-1" }]);
    const after = await store.loadMany([
      KEYS_1.accessToken,
      KEYS_1.refreshToken,
      KEYS_1.accessExpiresAt,
      KEYS_1.earliestRefreshAt,
    ]);
    expect(after[KEYS_1.accessToken]).toBe("access-2");
    expect(after[KEYS_1.refreshToken]).toBe("refresh-2");
    expect(after[KEYS_1.accessExpiresAt]).toBe(String(NOW_SECONDS + 3600));
    expect(after[KEYS_1.earliestRefreshAt]).toBe(String(NOW_SECONDS + 1800));
  });

  it("coalesces concurrent resolves into a single refresh", async () => {
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
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
      resolver.resolve({ providerId: PROVIDER_ID_1 }),
      resolver.resolve({ providerId: PROVIDER_ID_1 }),
      resolver.resolve({ providerId: PROVIDER_ID_1 }),
    ]);
    expect(a.apiKey).toBe("access-2");
    expect(b.apiKey).toBe("access-2");
    expect(c.apiKey).toBe("access-2");
    expect(refreshCalls).toHaveLength(1);
  });

  it("refreshes two accounts independently without cross-slot writes", async () => {
    const store = await createStore();
    const accountKey2 = createSiwcAccountKey("user-sub-2");
    const providerId2 = buildChatGptPlanAccountProviderId(accountKey2);
    const keys2 = buildSiwcAccountCredentialKeys(accountKey2);
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
      accessToken: "access-a1",
      expiresAt: NOW_SECONDS + 3600,
      refreshToken: "refresh-a1",
    });
    await seedAccount(store, {
      accountKey: accountKey2,
      accessToken: "access-b1",
      expiresAt: NOW_SECONDS - 10,
      refreshToken: "refresh-b1",
      sub: "user-sub-2",
      email: "b@example.com",
    });
    const { refreshCalls, tokenClient } = createFakeTokenClient([
      { accessToken: "access-b2", refreshToken: "refresh-b2", expiresInSeconds: 3600 },
    ]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const resolvedB = await resolver.resolve({ providerId: providerId2 });
    expect(resolvedB.apiKey).toBe("access-b2");
    expect(refreshCalls).toEqual([{ clientId: "oaiapp_issued", refreshToken: "refresh-b1" }]);
    const values = await store.loadMany([KEYS_1.accessToken, keys2.accessToken]);
    // Account A untouched by account B's refresh.
    expect(values[KEYS_1.accessToken]).toBe("access-a1");
    expect(values[keys2.accessToken]).toBe("access-b2");
  });

  it("clears only the failing account's tokens on terminal refresh errors", async () => {
    const store = await createStore();
    const accountKey2 = createSiwcAccountKey("user-sub-2");
    const providerId2 = buildChatGptPlanAccountProviderId(accountKey2);
    const keys2 = buildSiwcAccountCredentialKeys(accountKey2);
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
      accessToken: "access-a1",
      expiresAt: NOW_SECONDS + 3600,
      refreshToken: "refresh-a1",
    });
    await seedAccount(store, {
      accountKey: accountKey2,
      accessToken: "access-b1",
      expiresAt: NOW_SECONDS - 10,
      refreshToken: "refresh-b1",
      sub: "user-sub-2",
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
    const error = await resolver.resolve({ providerId: providerId2 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SiwcReloginRequiredError);
    const after = await store.loadMany([
      KEYS_1.accessToken,
      KEYS_1.refreshToken,
      keys2.clientId,
      keys2.accessToken,
      keys2.refreshToken,
      keys2.scopes,
    ]);
    // Retention rule shared with logout: keep the issued client id, drop that account's tokens.
    expect(after[KEYS_1.accessToken]).toBe("access-a1");
    expect(after[KEYS_1.refreshToken]).toBe("refresh-a1");
    expect(after[keys2.clientId]).toBe("oaiapp_issued");
    expect(after[keys2.accessToken]).toBeNull();
    expect(after[keys2.refreshToken]).toBeNull();
    expect(after[keys2.scopes]).toBeNull();
    expect(await isSiwcPlanEntitled(store, ACCOUNT_KEY_1)).toBe(true);
    expect(await isSiwcPlanEntitled(store, accountKey2)).toBe(false);
  });

  it("requires sign-in when no credentials exist for the account", async () => {
    const store = await createStore();
    const { tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    await expect(resolver.resolve({ providerId: PROVIDER_ID_1 })).rejects.toMatchObject({
      name: "SiwcReloginRequiredError",
      reason: "not_signed_in",
    });
  });

  it("does not take the accounts lock for token resolution without legacy credentials", async () => {
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
      accessToken: "access-valid",
      expiresAt: NOW_SECONDS + 3600,
      refreshToken: "refresh-valid",
    });
    const { tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });

    await expect(resolver.resolve({ providerId: PROVIDER_ID_1 })).resolves.toMatchObject({
      apiKey: "access-valid",
    });
    await expect(
      access(join(dirname(store.filePath), SIWC_ACCOUNTS_LOCK_FILE_NAME)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy flat credentials into the account slot and deletes them", async () => {
    const store = await createStore();
    await store.saveMany({
      [SIWC_LEGACY_CREDENTIAL_KEYS.clientId]: "oaiapp_legacy",
      [SIWC_LEGACY_CREDENTIAL_KEYS.accessToken]: "access-legacy",
      [SIWC_LEGACY_CREDENTIAL_KEYS.refreshToken]: "refresh-legacy",
      [SIWC_LEGACY_CREDENTIAL_KEYS.scopes]: FULL_SCOPES,
      [SIWC_LEGACY_CREDENTIAL_KEYS.userInfo]: JSON.stringify({
        sub: SUB_1,
        email: "u@example.com",
      }),
      [SIWC_LEGACY_CREDENTIAL_KEYS.accessExpiresAt]: String(NOW_SECONDS + 3600),
    });
    const records = await migrateLegacySiwcCredentials(store);
    expect(records).toHaveLength(1);
    expect(records[0]!.accountKey).toBe(ACCOUNT_KEY_1);
    const keys = buildSiwcAccountCredentialKeys(ACCOUNT_KEY_1);
    const migrated = await store.loadMany([keys.clientId, keys.accessToken, keys.refreshToken]);
    expect(migrated[keys.clientId]).toBe("oaiapp_legacy");
    expect(migrated[keys.accessToken]).toBe("access-legacy");
    expect(migrated[keys.refreshToken]).toBe("refresh-legacy");
    const legacy = await store.loadMany([
      SIWC_LEGACY_CREDENTIAL_KEYS.clientId,
      SIWC_LEGACY_CREDENTIAL_KEYS.accessToken,
    ]);
    expect(legacy[SIWC_LEGACY_CREDENTIAL_KEYS.clientId]).toBeNull();
    expect(legacy[SIWC_LEGACY_CREDENTIAL_KEYS.accessToken]).toBeNull();
    // Idempotent: a second migration is a no-op that keeps the same slot.
    const again = await migrateLegacySiwcCredentials(store);
    expect(again).toHaveLength(1);
    // The migrated account resolves through the standard per-account path.
    const { tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const resolved = await resolver.resolve({ providerId: PROVIDER_ID_1 });
    expect(resolved.apiKey).toBe("access-legacy");
  });

  it("completes an interrupted migration (partial slot copy, index absent)", async () => {
    const store = await createStore();
    const keys = buildSiwcAccountCredentialKeys(ACCOUNT_KEY_1);
    // Simulate a Desktop-host migration that saved part of the bundle sequentially and died
    // before the refresh token and the index record (the commit marker).
    await store.saveMany({
      [SIWC_LEGACY_CREDENTIAL_KEYS.clientId]: "oaiapp_legacy",
      [SIWC_LEGACY_CREDENTIAL_KEYS.accessToken]: "access-legacy",
      [SIWC_LEGACY_CREDENTIAL_KEYS.refreshToken]: "refresh-legacy",
      [SIWC_LEGACY_CREDENTIAL_KEYS.scopes]: FULL_SCOPES,
      [SIWC_LEGACY_CREDENTIAL_KEYS.userInfo]: JSON.stringify({ sub: SUB_1 }),
    });
    await store.saveMany({
      [keys.clientId]: "oaiapp_legacy",
      [keys.accessToken]: "access-legacy",
    });

    const records = await migrateLegacySiwcCredentials(store);
    expect(records).toHaveLength(1);
    const after = await store.loadMany([
      keys.refreshToken,
      keys.scopes,
      SIWC_LEGACY_CREDENTIAL_KEYS.refreshToken,
    ]);
    // The full bundle was re-copied from the source values and the legacy keys removed.
    expect(after[keys.refreshToken]).toBe("refresh-legacy");
    expect(after[keys.scopes]).toBe(FULL_SCOPES);
    expect(after[SIWC_LEGACY_CREDENTIAL_KEYS.refreshToken]).toBeNull();
  });

  it("lists an access-only slot (login without a refresh token stays executable)", async () => {
    const store = await createStore();
    const keys2 = buildSiwcAccountCredentialKeys(ACCOUNT_KEY_1);
    await store.saveMany({
      [keys2.clientId]: "oaiapp_issued",
      [keys2.accessToken]: "access-only",
      [keys2.scopes]: FULL_SCOPES,
      [keys2.userInfo]: JSON.stringify({ sub: SUB_1 }),
    });
    await store.save(
      SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
      JSON.stringify([
        { accountKey: ACCOUNT_KEY_1, sub: SUB_1, email: null, name: null, addedAt: "" },
      ]),
    );
    const accounts = await listSiwcPlanAccounts(store);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ accountKey: ACCOUNT_KEY_1, entitled: true });
  });

  it("lists accounts with per-account consent state", async () => {
    const store = await createStore();
    const accountKey2 = createSiwcAccountKey("user-sub-2");
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
      accessToken: "access-a1",
      expiresAt: NOW_SECONDS + 3600,
      refreshToken: "refresh-a1",
    });
    const keys2 = buildSiwcAccountCredentialKeys(accountKey2);
    await store.saveMany({
      [keys2.clientId]: "oaiapp_issued",
      [keys2.accessToken]: "access-b1",
      [keys2.refreshToken]: "refresh-b1",
      [keys2.scopes]: "openid profile email",
      [keys2.userInfo]: JSON.stringify({ sub: "user-sub-2" }),
      [keys2.accessExpiresAt]: String(NOW_SECONDS + 3600),
    });
    await store.save(
      SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
      JSON.stringify([
        { accountKey: ACCOUNT_KEY_1, sub: SUB_1, email: "u@example.com", name: null, addedAt: "" },
        { accountKey: accountKey2, sub: "user-sub-2", email: null, name: null, addedAt: "" },
      ]),
    );
    const accounts = await listSiwcPlanAccounts(store);
    expect(accounts).toHaveLength(2);
    const byKey = new Map(accounts.map((account) => [account.accountKey, account]));
    expect(byKey.get(ACCOUNT_KEY_1)!.entitled).toBe(true);
    expect(byKey.get(accountKey2)!.entitled).toBe(false);
  });

  it("refreshes through the DEFAULT token client in production wiring (no injected client)", async () => {
    // Regression: refreshLocked previously ignored the defaulted client, so the production
    // construction (credential store only) could never refresh.
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
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
    const resolved = await resolver.resolve({ providerId: PROVIDER_ID_1 });
    expect(resolved.apiKey).toBe("access-2");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toContain("grant_type=refresh_token");
    expect(tokenRequests[0]).toContain("client_id=oaiapp_issued");
    expect(await store.load(KEYS_1.refreshToken)).toBe("refresh-2");
  });

  it("keeps the account scope stable across token rotation (account-switch fingerprint only)", async () => {
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
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
    const before = await resolver.resolve({ providerId: PROVIDER_ID_1 });
    // Simulate expiry + rotation.
    await store.save(KEYS_1.accessExpiresAt, String(NOW_SECONDS + 60));
    const { tokenClient: second } = createFakeTokenClient([
      { accessToken: "access-3", refreshToken: "refresh-3", expiresInSeconds: 3600 },
    ]);
    const resolverAfterRotation = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient: second,
      now: () => NOW_SECONDS * 1000,
    });
    const after = await resolverAfterRotation.resolve({ providerId: PROVIDER_ID_1 });
    expect(after.apiKey).toBe("access-3");
    expect(after.accountScope).toBe(before.accountScope);
  });

  it("forceRefresh rotates even a time-valid token (401 retry must not resend it)", async () => {
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
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
      providerId: PROVIDER_ID_1,
      forceRefresh: true,
    });
    expect(resolved.apiKey).toBe("access-fresh");
    expect(refreshCalls).toEqual([{ clientId: "oaiapp_issued", refreshToken: "refresh-1" }]);
  });

  it("keeps the current token before earliest_refresh_at", async () => {
    const store = await createStore();
    await seedAccount(store, {
      accountKey: ACCOUNT_KEY_1,
      accessToken: "access-1",
      expiresAt: NOW_SECONDS + 60,
      refreshToken: "refresh-1",
    });
    await store.save(KEYS_1.earliestRefreshAt, String(NOW_SECONDS + 120));
    const { refreshCalls, tokenClient } = createFakeTokenClient([]);
    const resolver = createSiwcAccessTokenResolver({
      credentialStore: store,
      tokenClient,
      now: () => NOW_SECONDS * 1000,
    });
    const resolved = await resolver.resolve({ providerId: PROVIDER_ID_1 });
    expect(resolved.apiKey).toBe("access-1");
    expect(refreshCalls).toHaveLength(0);
  });
});
