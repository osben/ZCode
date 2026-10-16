import { createHash } from "node:crypto";
import {
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountProviderAuthSourceKey,
  buildSiwcAccountProviderIdentityKey,
  isChatGptPlanAccountKey,
  SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
  SIWC_LEGACY_CREDENTIAL_KEYS,
  type SiwcStoredAccountRecord,
} from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";

type SiwcAccountStore = Pick<SharedZCodeCredentialStore, "loadMany" | "saveMany" | "deleteIfValues">;

/**
 * Stable per-account slot key: sha256(sub) prefix. Contains no PII, so it is safe in
 * provider ids, credential keys, and logs. Mirrored by the Desktop host implementation
 * (`packages/services/src/oauth/siwc/`); both are pinned by identical test vectors.
 */
export function createSiwcAccountKey(sub: string): string {
  const normalized = sub.trim();
  if (!normalized) throw new Error("SIWC account subject is empty");
  return createHash("sha256") // codeql[js/insufficient-password-hash] — slot id, not password storage
    .update(normalized, "utf-8")
    .digest("hex")
    .slice(0, 16);
}

function requireValidAccountKey(accountKey: string): string {
  const normalized = accountKey.trim();
  if (!isChatGptPlanAccountKey(normalized)) {
    throw new Error(`Invalid ChatGPT plan account key: ${normalized}`);
  }
  return normalized;
}

function parseAccountRecord(input: unknown): SiwcStoredAccountRecord | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Partial<SiwcStoredAccountRecord>;
  if (
    typeof candidate.accountKey !== "string" ||
    !isChatGptPlanAccountKey(candidate.accountKey) ||
    typeof candidate.sub !== "string" ||
    !candidate.sub.trim()
  ) {
    return null;
  }
  return {
    accountKey: candidate.accountKey.trim(),
    sub: candidate.sub.trim(),
    email: typeof candidate.email === "string" && candidate.email.trim() ? candidate.email : null,
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name : null,
    addedAt:
      typeof candidate.addedAt === "string" && candidate.addedAt.trim() ? candidate.addedAt : "",
  };
}

/** Read and validate the persisted account index; malformed entries are dropped. */
export async function readSiwcAccountIndex(
  store: SiwcAccountStore,
): Promise<readonly SiwcStoredAccountRecord[]> {
  const raw = await store.loadMany([SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY]);
  const value = raw[SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY];
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const record = parseAccountRecord(entry);
      return record ? [record] : [];
    });
  } catch {
    return [];
  }
}

/** Persist the full account index (no secrets; sub/email/name only). */
export async function writeSiwcAccountIndex(
  store: SiwcAccountStore,
  records: readonly SiwcStoredAccountRecord[],
): Promise<void> {
  await store.saveMany({
    [SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY]: JSON.stringify(records),
  });
}

/** Insert or update one account descriptor, preserving record order. */
export async function upsertSiwcAccountRecord(
  store: SiwcAccountStore,
  record: SiwcStoredAccountRecord,
): Promise<readonly SiwcStoredAccountRecord[]> {
  const key = requireValidAccountKey(record.accountKey);
  const existing = await readSiwcAccountIndex(store);
  const next: SiwcStoredAccountRecord[] = [];
  let replaced = false;
  for (const item of existing) {
    if (item.accountKey === key) {
      next.push({ ...record, accountKey: key, addedAt: item.addedAt || record.addedAt });
      replaced = true;
    } else {
      next.push(item);
    }
  }
  if (!replaced) next.push({ ...record, accountKey: key });
  await writeSiwcAccountIndex(store, next);
  return next;
}

/** Remove one account descriptor from the index (its slot keys must already be cleared). */
export async function removeSiwcAccountRecord(
  store: SiwcAccountStore,
  accountKey: string,
): Promise<readonly SiwcStoredAccountRecord[]> {
  const key = requireValidAccountKey(accountKey);
  const next = (await readSiwcAccountIndex(store)).filter((item) => item.accountKey !== key);
  await writeSiwcAccountIndex(store, next);
  return next;
}

interface LegacySiwcCredentials {
  readonly clientId: string | null;
  readonly refreshToken: string | null;
  readonly userInfo: string | null;
  readonly values: Record<string, string>;
}

async function loadLegacyCredentials(store: SiwcAccountStore): Promise<LegacySiwcCredentials> {
  const keys = SIWC_LEGACY_CREDENTIAL_KEYS;
  const values = await store.loadMany([
    keys.clientId,
    keys.accessToken,
    keys.refreshToken,
    keys.idToken,
    keys.userInfo,
    keys.scopes,
    keys.accessExpiresAt,
    keys.earliestRefreshAt,
    keys.providerIdentity,
    keys.providerAuthSource,
  ]);
  const present = Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
  );
  return {
    clientId: values[keys.clientId]?.trim() || null,
    refreshToken: values[keys.refreshToken]?.trim() || null,
    userInfo: values[keys.userInfo] ?? null,
    values: present,
  };
}

/**
 * One-time migration of the pre-multi-account flat credential keys into the signed-in
 * account's per-account slot. Idempotent: absent legacy keys are a no-op. Concurrent
 * migrations copy identical values, so the outcome converges without coordination.
 * Always call before reading the account index.
 */
export async function migrateLegacySiwcCredentials(
  store: SiwcAccountStore,
): Promise<readonly SiwcStoredAccountRecord[]> {
  const legacy = await loadLegacyCredentials(store);
  if (!legacy.clientId && !legacy.refreshToken && !legacy.userInfo) {
    return readSiwcAccountIndex(store);
  }
  const sub = readUserJsonField(legacy.userInfo, "sub") ?? legacy.clientId ?? "";
  if (!sub.trim()) {
    return readSiwcAccountIndex(store);
  }
  const accountKey = createSiwcAccountKey(sub);
  const legacyKeys = SIWC_LEGACY_CREDENTIAL_KEYS;
  const accountKeys = buildSiwcAccountCredentialKeys(accountKey);
  const mapping: ReadonlyArray<readonly [string, string]> = [
    [legacyKeys.clientId, accountKeys.clientId],
    [legacyKeys.accessToken, accountKeys.accessToken],
    [legacyKeys.refreshToken, accountKeys.refreshToken],
    [legacyKeys.idToken, accountKeys.idToken],
    [legacyKeys.userInfo, accountKeys.userInfo],
    [legacyKeys.scopes, accountKeys.scopes],
    [legacyKeys.accessExpiresAt, accountKeys.accessExpiresAt],
    [legacyKeys.earliestRefreshAt, accountKeys.earliestRefreshAt],
    [legacyKeys.providerIdentity, buildSiwcAccountProviderIdentityKey(accountKey)],
    [legacyKeys.providerAuthSource, buildSiwcAccountProviderAuthSourceKey(accountKey)],
  ];
  const mapped: Record<string, string> = {};
  for (const [legacyKey, accountKeyDestination] of mapping) {
    const value = legacy.values[legacyKey];
    if (value !== undefined) mapped[accountKeyDestination] = value;
  }

  const record = parseAccountRecord({
    accountKey,
    sub: sub.trim(),
    email: readUserJsonField(legacy.userInfo, "email"),
    name: readUserJsonField(legacy.userInfo, "name"),
    addedAt: new Date().toISOString(),
  });
  const existing = await readSiwcAccountIndex(store);
  if (record && !existing.some((item) => item.accountKey === accountKey)) {
    mapped[SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY] = JSON.stringify([...existing, record]);
  }
  if (Object.keys(mapped).length > 0) await store.saveMany(mapped);
  // Delete the flat keys only while their values are still the migrated ones, so a login
  // racing the migration cannot lose freshly written state.
  await store.deleteIfValues(legacy.values);
  return readSiwcAccountIndex(store);
}

function readUserJsonField(userInfoRaw: string | null, field: string): string | null {
  if (!userInfoRaw) return null;
  try {
    const parsed = JSON.parse(userInfoRaw) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}
