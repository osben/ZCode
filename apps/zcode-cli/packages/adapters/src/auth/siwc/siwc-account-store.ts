import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import {
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountProviderAuthSourceKey,
  buildSiwcAccountProviderIdentityKey,
  buildSiwcAccountRefreshLockFileName,
  isChatGptPlanAccountKey,
  SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY,
  SIWC_ACCOUNTS_LOCK_FILE_NAME,
  SIWC_LEGACY_CREDENTIAL_KEYS,
  type SiwcStoredAccountRecord,
} from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";

type SiwcAccountStore = Pick<
  SharedZCodeCredentialStore,
  "filePath" | "loadMany" | "saveMany" | "deleteIfValues"
>;

const ACCOUNTS_LOCK_MAX_WAIT_MS = 45_000;

/**
 * Serialize shared account-file mutations (migration, index read-merge-write) across the
 * CLI and the Desktop host; both write the same credentials file with the same lock name.
 */
function withSiwcAccountsLock<T>(store: SiwcAccountStore, operation: () => Promise<T>): Promise<T> {
  return withFileLock(join(dirname(store.filePath), SIWC_ACCOUNTS_LOCK_FILE_NAME), operation, {
    lockMaxWaitMs: ACCOUNTS_LOCK_MAX_WAIT_MS,
  });
}

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
  store: Pick<SharedZCodeCredentialStore, "loadMany">,
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

/**
 * Insert or update one account descriptor, preserving record order. The whole
 * read-merge-write runs under the cross-process accounts lock: the Desktop host performs
 * the same mutation against the shared file, and an unlocked interleaving would drop one
 * side's addition.
 */
export async function upsertSiwcAccountRecord(
  store: SiwcAccountStore,
  record: SiwcStoredAccountRecord,
): Promise<readonly SiwcStoredAccountRecord[]> {
  const key = requireValidAccountKey(record.accountKey);
  return withSiwcAccountsLock(store, async () => {
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
  });
}

/** Remove one account descriptor from the index (its slot keys must already be cleared). */
export async function removeSiwcAccountRecord(
  store: SiwcAccountStore,
  accountKey: string,
): Promise<readonly SiwcStoredAccountRecord[]> {
  const key = requireValidAccountKey(accountKey);
  return withSiwcAccountsLock(store, async () => {
    const next = (await readSiwcAccountIndex(store)).filter((item) => item.accountKey !== key);
    await writeSiwcAccountIndex(store, next);
    return next;
  });
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
 * account's per-account slot. Idempotent: absent legacy keys are a no-op. The whole
 * read-copy-write runs under the cross-process locks (the Desktop host migrates the same
 * file), and an already-initialized destination slot is preserved: a delayed second
 * migrator replaying consumed legacy tokens over a freshly rotated slot would otherwise
 * trip refresh_token_reused and invalidate the login.
 *
 * Lock order (shared with the Desktop host): the per-account refresh lock FIRST, then the
 * accounts lock. The migration writes the destination slot, so it must serialize with
 * login/refresh slot writes; otherwise a login that replaced the slot without its index
 * record committed yet could be overwritten by the legacy bundle here.
 */
export async function migrateLegacySiwcCredentials(
  store: SiwcAccountStore,
): Promise<readonly SiwcStoredAccountRecord[]> {
  const legacyKeys = SIWC_LEGACY_CREDENTIAL_KEYS;
  const triggers = await store.loadMany([
    legacyKeys.clientId,
    legacyKeys.refreshToken,
    legacyKeys.userInfo,
  ]);
  if (
    !triggers[legacyKeys.clientId]?.trim() &&
    !triggers[legacyKeys.refreshToken]?.trim() &&
    triggers[legacyKeys.userInfo] === null
  ) {
    return readSiwcAccountIndex(store);
  }
  const migrate = () =>
    withSiwcAccountsLock(store, () => migrateLegacySiwcCredentialsLocked(store));
  // Same account-key formula the migration itself uses, so the refresh lock covers the exact
  // slot the copy would land in. Without a derivable key the migration is a no-op: keep the
  // accounts-lock-only path.
  const candidateSub =
    readUserJsonField(triggers[legacyKeys.userInfo], "sub")?.trim() ||
    triggers[legacyKeys.clientId]?.trim() ||
    "";
  if (!candidateSub) return migrate();
  return withFileLock(
    join(
      dirname(store.filePath),
      buildSiwcAccountRefreshLockFileName(createSiwcAccountKey(candidateSub)),
    ),
    migrate,
    { lockMaxWaitMs: ACCOUNTS_LOCK_MAX_WAIT_MS },
  );
}

async function migrateLegacySiwcCredentialsLocked(
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
  // Commit protocol (interruption-safe, shared with the Desktop host): the index record is
  // the commit marker. An absent record means the migration never completed (the host saves
  // keys sequentially and may stop mid-bundle), so the full legacy bundle is re-copied —
  // including over a partial slot copy, whose values come from the same source. A record
  // present means the slot was fully migrated or written by a later login/refresh; replaying
  // consumed legacy values over it would corrupt the token family, so only the legacy keys go.
  const mapped: Record<string, string> = {};
  const existing = await readSiwcAccountIndex(store);
  const indexed = existing.some((item) => item.accountKey === accountKey);
  if (!indexed) {
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
    if (record) {
      mapped[SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY] = JSON.stringify([...existing, record]);
    }
  }
  if (Object.keys(mapped).length > 0) await store.saveMany(mapped);
  // Delete the flat keys only while their values are still the migrated ones, so a login
  // racing the migration cannot lose freshly written state. Deletion happens even when the
  // slot was preserved: the legacy values are stale by definition in that case.
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
