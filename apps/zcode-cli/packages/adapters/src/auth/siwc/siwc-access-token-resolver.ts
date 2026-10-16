import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import {
  buildSiwcAccountCredentialKeys,
  buildSiwcAccountRefreshLockFileName,
  parseChatGptPlanAccountProviderId,
  type SiwcStoredAccountRecord,
} from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import {
  SIWC_TERMINAL_REFRESH_ERROR_CODES,
  createSiwcTokenClient,
  isSiwcPlanUsageEntitled,
  parseSiwcScopes,
  type SiwcTokenClient,
} from "./index.js";
import { migrateLegacySiwcCredentials, readSiwcAccountIndex } from "./siwc-account-store.js";

const SIWC_REFRESH_LOCK_MAX_WAIT_MS = 45_000;
/** Refresh this long before expiry (SIWC access tokens live 1 hour). */
const SIWC_PROACTIVE_REFRESH_MARGIN_SECONDS = 120;

export class SiwcReloginRequiredError extends Error {
  constructor(
    message: string,
    options: { cause?: unknown; readonly reason: string } = { reason: "terminal_refresh_failure" },
  ) {
    super(message, { cause: options.cause });
    this.name = "SiwcReloginRequiredError";
    this.reason = options.reason;
  }
  readonly reason: string;
}

export interface SiwcAccessTokenResolverInput {
  readonly abortSignal?: AbortSignal;
  /** Per-account ChatGPT plan provider id (`account:chatgpt-plan:<accountKey>`). */
  readonly providerId: string;
  /**
   * Force a refresh even when the stored token is still time-valid; set after the resource
   * server rejected the current token (401) so the retry cannot resend it.
   */
  readonly forceRefresh?: boolean;
}

export interface SiwcAccessTokenResolution {
  readonly accountScope: string;
  readonly apiKey: string;
}

export interface SiwcCredentialSnapshot {
  readonly accountKey: string;
  readonly accessToken: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly identity: string;
}

export interface SiwcAccessTokenResolverOptions {
  readonly credentialStore: Pick<
    SharedZCodeCredentialStore,
    "filePath" | "loadMany" | "saveMany" | "deleteIfValues"
  >;
  readonly env?: Record<string, string | undefined>;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly tokenClient?: SiwcTokenClient;
  readonly now?: () => number;
}

/** Read the persisted SIWC credentials of one account; null when that account is signed out. */
export async function loadSiwcCredentialSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany" | "saveMany" | "deleteIfValues">,
  accountKey: string,
): Promise<SiwcCredentialSnapshot | null> {
  const keys = buildSiwcAccountCredentialKeys(accountKey);
  const values = await credentialStore.loadMany([
    keys.clientId,
    keys.accessToken,
    keys.refreshToken,
    keys.scopes,
    keys.userInfo,
  ]);
  const clientId = values[keys.clientId]?.trim();
  const accessToken = values[keys.accessToken]?.trim();
  const refreshToken = values[keys.refreshToken]?.trim();
  const scopes = parseSiwcScopes(values[keys.scopes]);
  if (!accessToken || !refreshToken) return null;
  return {
    accountKey,
    accessToken,
    clientId: clientId ?? "",
    refreshToken,
    scopes,
    identity: readAccountSubject(values[keys.userInfo]) ?? clientId ?? "",
  };
}

/**
 * Account-scope fingerprint (compared for equality to detect account switching), not a secret.
 * Hashes only stable account material (issued client id + subject); the access token rotates
 * hourly and must not change the scope, or routine refreshes would look like account switches.
 */
export function createSiwcAccountScope(input: {
  readonly clientId: string;
  readonly providerId: string;
  readonly subject: string;
}): string {
  return createHash("sha256") // codeql[js/insufficient-password-hash]
    .update(JSON.stringify([input.providerId, "chatgpt", input.clientId, input.subject]))
    .digest("hex");
}

/**
 * All signed-in accounts with their consent state. Deliberately READ-ONLY: callers run it
 * from registry refresh paths subscribed to credential changes, where a migration write
 * would deadlock (the credential store awaits those listeners). Migration runs at process
 * startup instead. Presence matches the host's signed-in criterion — an access token OR a
 * refresh token (a login may persist no refresh token), so an access-only account stays
 * executable in worker registries exactly like in the Desktop picker.
 */
export async function listSiwcPlanAccounts(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
): Promise<readonly (SiwcStoredAccountRecord & { readonly entitled: boolean })[]> {
  const records = await readSiwcAccountIndex(credentialStore);
  const result: (SiwcStoredAccountRecord & { readonly entitled: boolean })[] = [];
  for (const record of records) {
    const keys = buildSiwcAccountCredentialKeys(record.accountKey);
    const values = await credentialStore.loadMany([
      keys.accessToken,
      keys.refreshToken,
      keys.scopes,
    ]);
    const present =
      values[keys.accessToken]?.trim() !== undefined ||
      values[keys.refreshToken]?.trim() !== undefined;
    if (!present) continue;
    result.push({
      ...record,
      entitled: isSiwcPlanUsageEntitled(parseSiwcScopes(values[keys.scopes] ?? undefined)),
    });
  }
  return result;
}

/**
 * Request-time SIWC token lifecycle owner: proactive refresh before expiry, cross-process
 * single-flight (rotation reuse is fatal), atomic rotation-aware persistence, and terminal
 * refresh failures clearing that account's credentials into a structured re-sign-in state.
 * All state is scoped to one account slot; accounts never share locks or tokens.
 */
export function createSiwcAccessTokenResolver(options: SiwcAccessTokenResolverOptions): {
  resolve(input: SiwcAccessTokenResolverInput): Promise<SiwcAccessTokenResolution>;
} {
  const now = options.now ?? Date.now;
  const tokenClient =
    options.tokenClient ??
    createSiwcTokenClient({ ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}) });
  const inFlight = new Map<string, Promise<SiwcAccessTokenResolution>>();

  async function resolveLocked(
    input: SiwcAccessTokenResolverInput,
    accountKey: string,
  ): Promise<SiwcAccessTokenResolution> {
    input.abortSignal?.throwIfAborted();
    await migrateLegacySiwcCredentials(options.credentialStore);
    let snapshot = await loadSiwcTokenState(options.credentialStore, accountKey);
    if (!snapshot) {
      throw new SiwcReloginRequiredError(
        "ChatGPT plan credentials are missing. Sign in with `zcode login chatgpt`.",
        { reason: "not_signed_in" },
      );
    }
    if (!input.forceRefresh && isAccessUsable(snapshot, now())) {
      return toResolution(snapshot, input.providerId, accountKey);
    }
    if (!snapshot.clientId || !snapshot.refreshToken) {
      throw new SiwcReloginRequiredError(
        "ChatGPT plan credentials are incomplete. Sign in with `zcode login chatgpt`.",
        { reason: "not_signed_in" },
      );
    }
    // Respect earliest_refresh_at: before it, the current token is the best we may use —
    // except after a server-side rejection, where resending it is guaranteed to fail again.
    if (
      !input.forceRefresh &&
      snapshot.earliestRefreshAt != null &&
      now() / 1000 < snapshot.earliestRefreshAt
    ) {
      if (snapshot.accessToken) return toResolution(snapshot, input.providerId, accountKey);
    }
    snapshot = await refreshUnderLock(
      tokenClient,
      options,
      snapshot,
      accountKey,
      now,
      input.abortSignal,
    );
    if (!isAccessUsable(snapshot, now())) {
      throw new SiwcReloginRequiredError(
        "ChatGPT plan token refresh did not produce a usable access token. Sign in again with `zcode login chatgpt`.",
        { reason: "refresh_failed" },
      );
    }
    return toResolution(snapshot, input.providerId, accountKey);
  }

  return {
    async resolve(input) {
      const accountKey = parseChatGptPlanAccountProviderId(input.providerId);
      if (!accountKey) {
        throw new Error(
          `Not a per-account ChatGPT plan provider id: ${input.providerId}. Sign in again.`,
        );
      }
      const existing = inFlight.get(accountKey);
      if (existing) return existing;
      const pending = resolveLocked(input, accountKey).finally(() => inFlight.delete(accountKey));
      inFlight.set(accountKey, pending);
      return pending;
    },
  };
}

interface SiwcTokenState {
  accessToken: string | null;
  clientId: string | null;
  idToken: string | null;
  refreshToken: string | null;
  scopes: string | null;
  subject: string | null;
  accessExpiresAt: number | null;
  earliestRefreshAt: number | null;
}

function siwcStateKeys(accountKey: string) {
  return buildSiwcAccountCredentialKeys(accountKey);
}

async function loadSiwcTokenState(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany" | "saveMany" | "deleteIfValues">,
  accountKey: string,
): Promise<SiwcTokenState | null> {
  const keys = siwcStateKeys(accountKey);
  const values = await credentialStore.loadMany([
    keys.accessToken,
    keys.clientId,
    keys.idToken,
    keys.refreshToken,
    keys.scopes,
    keys.userInfo,
    keys.accessExpiresAt,
    keys.earliestRefreshAt,
  ]);
  const accessToken = values[keys.accessToken]?.trim() ?? null;
  const refreshToken = values[keys.refreshToken]?.trim() ?? null;
  if (!accessToken && !refreshToken) return null;
  return {
    accessToken: accessToken || null,
    clientId: values[keys.clientId]?.trim() || null,
    idToken: values[keys.idToken]?.trim() || null,
    refreshToken,
    scopes: values[keys.scopes] ?? null,
    subject: readAccountSubject(values[keys.userInfo]),
    accessExpiresAt: readEpoch(values[keys.accessExpiresAt]),
    earliestRefreshAt: readEpoch(values[keys.earliestRefreshAt]),
  };
}

function readAccountSubject(userInfoRaw: string | null | undefined): string | null {
  if (!userInfoRaw) return null;
  try {
    const parsed = JSON.parse(userInfoRaw) as { sub?: unknown };
    return typeof parsed.sub === "string" && parsed.sub.trim() ? parsed.sub.trim() : null;
  } catch {
    return null;
  }
}

function isAccessUsable(state: SiwcTokenState, nowMs: number): boolean {
  if (!state.accessToken) return false;
  if (state.accessExpiresAt === null) return true;
  return nowMs / 1000 < state.accessExpiresAt - SIWC_PROACTIVE_REFRESH_MARGIN_SECONDS;
}

function toResolution(
  state: SiwcTokenState,
  providerId: string,
  accountKey: string,
): SiwcAccessTokenResolution {
  if (!state.accessToken) throw new Error("SIWC access token expected to be present.");
  return {
    apiKey: state.accessToken,
    accountScope: createSiwcAccountScope({
      clientId: state.clientId ?? "",
      // Stability fallback for accounts without persisted user info.
      subject: state.subject ?? state.clientId ?? accountKey,
      providerId,
    }),
  };
}

/**
 * Refresh under a cross-process per-account file lock. The lock file is separate from the
 * credentials file because the store locks the credentials file itself for read-modify-write.
 */
async function refreshUnderLock(
  tokenClient: SiwcTokenClient,
  options: SiwcAccessTokenResolverOptions,
  observed: SiwcTokenState,
  accountKey: string,
  now: () => number,
  abortSignal?: AbortSignal,
): Promise<SiwcTokenState> {
  const lockPath = join(
    dirname(options.credentialStore.filePath),
    buildSiwcAccountRefreshLockFileName(accountKey),
  );
  try {
    return await withFileLock(
      lockPath,
      () => refreshLocked(tokenClient, options, observed, accountKey, now, abortSignal),
      { lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS },
    );
  } catch (error) {
    if (!isZCodeFileLockTimeoutError(error)) throw error;
    // A lock timeout does not mean refresh failed; the winner may have rotated tokens.
    const current = await loadSiwcTokenState(options.credentialStore, accountKey);
    if (current && isAccessUsable(current, now())) return current;
    throw error;
  }
}

async function refreshLocked(
  tokenClient: SiwcTokenClient,
  options: SiwcAccessTokenResolverOptions,
  observed: SiwcTokenState,
  accountKey: string,
  now: () => number,
  abortSignal?: AbortSignal,
): Promise<SiwcTokenState> {
  const store = options.credentialStore;
  const keys = siwcStateKeys(accountKey);
  const current = await loadSiwcTokenState(store, accountKey);
  if (!current?.accessToken || !current.clientId || !current.refreshToken) {
    throw new SiwcReloginRequiredError(
      "ChatGPT plan credentials are missing. Sign in with `zcode login chatgpt`.",
      { reason: "not_signed_in" },
    );
  }
  // Coalesce: if another process refreshed while this one waited, reuse the new token.
  if (current.accessToken !== observed.accessToken && isAccessUsable(current, now())) {
    return current;
  }
  try {
    const response = await tokenClient.refresh({
      clientId: current.clientId,
      refreshToken: current.refreshToken,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    const expiresAt = Math.floor(now() / 1000) + (response.expiresInSeconds ?? 3600);
    const scopeValue = response.scope ?? current.scopes ?? undefined;
    await store.saveMany({
      [keys.accessToken]: response.accessToken,
      // Rotation: the response's refresh token replaces the old one atomically.
      ...(response.refreshToken ? { [keys.refreshToken]: response.refreshToken } : {}),
      ...(response.idToken ? { [keys.idToken]: response.idToken } : {}),
      ...(scopeValue ? { [keys.scopes]: scopeValue } : {}),
      [keys.accessExpiresAt]: String(expiresAt),
      ...(response.earliestRefreshAt !== undefined
        ? { [keys.earliestRefreshAt]: String(response.earliestRefreshAt) }
        : {}),
    });
    const after = await loadSiwcTokenState(store, accountKey);
    if (!after?.accessToken) {
      throw new SiwcReloginRequiredError(
        "ChatGPT plan credentials disappeared during refresh. Sign in again.",
        { reason: "refresh_failed" },
      );
    }
    return after;
  } catch (error) {
    if (isSiwcTerminalRefreshError(error)) {
      // Terminal refresh failures clear that account's tokens but retain its issued client id
      // and account mapping for a smooth re-auth (same retention rule as logout).
      await clearSiwcTokenCredentials(store, accountKey);
      throw new SiwcReloginRequiredError(
        "ChatGPT plan sign-in has expired or been revoked. Sign in again with `zcode login chatgpt`.",
        { cause: error, reason: "terminal_refresh_failure" },
      );
    }
    throw error;
  }
}

export function isSiwcTerminalRefreshError(error: unknown): boolean {
  const code = readErrorCode(error);
  return code !== undefined && SIWC_TERMINAL_REFRESH_ERROR_CODES.includes(code);
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "error" in error) {
    const code = (error as { error?: unknown }).error;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return undefined;
}

function readEpoch(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Clear one account's SIWC token credentials; retains its client id and account mapping. */
export async function clearSiwcTokenCredentials(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany" | "saveMany" | "deleteIfValues">,
  accountKey: string,
): Promise<void> {
  const keys = siwcStateKeys(accountKey);
  const tokenKeys = [
    keys.accessToken,
    keys.refreshToken,
    keys.idToken,
    keys.scopes,
    keys.accessExpiresAt,
    keys.earliestRefreshAt,
  ];
  const current = await credentialStore.loadMany(tokenKeys);
  await credentialStore.deleteIfValues(
    Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
    ),
  );
}

/** Entitlement gate for one account: signed-in identity plus the plan-usage scope consent. */
export async function isSiwcPlanEntitled(
  credentialStore: Pick<
    SharedZCodeCredentialStore,
    "filePath" | "loadMany" | "saveMany" | "deleteIfValues"
  >,
  accountKey: string,
): Promise<boolean> {
  await migrateLegacySiwcCredentials(credentialStore);
  const snapshot = await loadSiwcCredentialSnapshot(credentialStore, accountKey);
  return snapshot !== null && isSiwcPlanUsageEntitled(snapshot.scopes);
}
