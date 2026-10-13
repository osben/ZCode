import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import {
  SIWC_TERMINAL_REFRESH_ERROR_CODES,
  createSiwcTokenClient,
  isSiwcPlanUsageEntitled,
  parseSiwcScopes,
  type SiwcTokenClient,
} from "./index.js";

/** Credential keys in the shared store; chatgpt is an independent identity domain. */
export const SIWC_CREDENTIAL_KEYS = {
  clientId: "oauth:chatgpt:client_id",
  accessToken: "oauth:chatgpt:access_token",
  refreshToken: "oauth:chatgpt:refresh_token",
  idToken: "oauth:chatgpt:id_token",
  userInfo: "oauth:chatgpt:user_info",
  scopes: "oauth:chatgpt:scopes",
  accessExpiresAt: "oauth:chatgpt:access_expires_at",
  earliestRefreshAt: "oauth:chatgpt:earliest_refresh_at",
} as const;

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
  readonly accessToken: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly identity: string;
}

export interface SiwcAccessTokenResolverOptions {
  readonly credentialStore: Pick<
    SharedZCodeCredentialStore,
    "loadMany" | "saveMany" | "deleteIfValues"
  >;
  readonly env?: Record<string, string | undefined>;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly tokenClient?: SiwcTokenClient;
  readonly now?: () => number;
}

/** Read the persisted SIWC credentials; null when not signed in. */
export async function loadSiwcCredentialSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
): Promise<SiwcCredentialSnapshot | null> {
  const values = await credentialStore.loadMany([
    SIWC_CREDENTIAL_KEYS.clientId,
    SIWC_CREDENTIAL_KEYS.accessToken,
    SIWC_CREDENTIAL_KEYS.refreshToken,
    SIWC_CREDENTIAL_KEYS.scopes,
    SIWC_CREDENTIAL_KEYS.userInfo,
  ]);
  const clientId = values[SIWC_CREDENTIAL_KEYS.clientId]?.trim();
  const accessToken = values[SIWC_CREDENTIAL_KEYS.accessToken]?.trim();
  const refreshToken = values[SIWC_CREDENTIAL_KEYS.refreshToken]?.trim();
  const scopes = parseSiwcScopes(values[SIWC_CREDENTIAL_KEYS.scopes]);
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    clientId: clientId ?? "",
    refreshToken,
    scopes,
    identity: readAccountSubject(values[SIWC_CREDENTIAL_KEYS.userInfo]) ?? clientId ?? "",
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
 * Request-time SIWC token lifecycle owner: proactive refresh before expiry, cross-process
 * single-flight (rotation reuse is fatal), atomic rotation-aware persistence, and terminal
 * refresh failures clearing credentials into a structured re-sign-in state.
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
  ): Promise<SiwcAccessTokenResolution> {
    input.abortSignal?.throwIfAborted();
    let snapshot = await loadSiwcTokenState(options.credentialStore);
    if (!snapshot) {
      throw new SiwcReloginRequiredError(
        "ChatGPT plan credentials are missing. Sign in with `zcode login chatgpt`.",
        { reason: "not_signed_in" },
      );
    }
    if (!input.forceRefresh && isAccessUsable(snapshot, now())) {
      return toResolution(snapshot, input.providerId);
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
      if (snapshot.accessToken) return toResolution(snapshot, input.providerId);
    }
    snapshot = await refreshUnderLock(tokenClient, options, snapshot, now, input.abortSignal);
    if (!isAccessUsable(snapshot, now())) {
      throw new SiwcReloginRequiredError(
        "ChatGPT plan token refresh did not produce a usable access token. Sign in again with `zcode login chatgpt`.",
        { reason: "refresh_failed" },
      );
    }
    return toResolution(snapshot, input.providerId);
  }

  return {
    async resolve(input) {
      const existing = inFlight.get(input.providerId);
      if (existing) return existing;
      const pending = resolveLocked(input).finally(() => inFlight.delete(input.providerId));
      inFlight.set(input.providerId, pending);
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

async function loadSiwcTokenState(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
): Promise<SiwcTokenState | null> {
  const keys = [
    SIWC_CREDENTIAL_KEYS.accessToken,
    SIWC_CREDENTIAL_KEYS.clientId,
    SIWC_CREDENTIAL_KEYS.idToken,
    SIWC_CREDENTIAL_KEYS.refreshToken,
    SIWC_CREDENTIAL_KEYS.scopes,
    SIWC_CREDENTIAL_KEYS.userInfo,
    SIWC_CREDENTIAL_KEYS.accessExpiresAt,
    SIWC_CREDENTIAL_KEYS.earliestRefreshAt,
  ];
  const values = await credentialStore.loadMany(keys);
  const accessToken = values[SIWC_CREDENTIAL_KEYS.accessToken]?.trim() ?? null;
  const refreshToken = values[SIWC_CREDENTIAL_KEYS.refreshToken]?.trim() ?? null;
  if (!accessToken && !refreshToken) return null;
  return {
    accessToken: accessToken || null,
    clientId: values[SIWC_CREDENTIAL_KEYS.clientId]?.trim() || null,
    idToken: values[SIWC_CREDENTIAL_KEYS.idToken]?.trim() || null,
    refreshToken,
    scopes: values[SIWC_CREDENTIAL_KEYS.scopes] ?? null,
    subject: readAccountSubject(values[SIWC_CREDENTIAL_KEYS.userInfo]),
    accessExpiresAt: readEpoch(values[SIWC_CREDENTIAL_KEYS.accessExpiresAt]),
    earliestRefreshAt: readEpoch(values[SIWC_CREDENTIAL_KEYS.earliestRefreshAt]),
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

function toResolution(state: SiwcTokenState, providerId: string): SiwcAccessTokenResolution {
  if (!state.accessToken) throw new Error("SIWC access token expected to be present.");
  return {
    apiKey: state.accessToken,
    accountScope: createSiwcAccountScope({
      clientId: state.clientId ?? "",
      // Stability fallback for accounts without persisted user info.
      subject: state.subject ?? state.clientId ?? "",
      providerId,
    }),
  };
}

/**
 * Refresh under a cross-process file lock. The lock file is separate from the credentials
 * file because the store locks the credentials file itself for read-modify-write.
 */
async function refreshUnderLock(
  tokenClient: SiwcTokenClient,
  options: SiwcAccessTokenResolverOptions,
  observed: SiwcTokenState,
  now: () => number,
  abortSignal?: AbortSignal,
): Promise<SiwcTokenState> {
  const lockPath = join(
    dirname((options.credentialStore as SharedZCodeCredentialStore).filePath),
    "siwc-chatgpt.refresh",
  );
  try {
    return await withFileLock(
      lockPath,
      () => refreshLocked(tokenClient, options, observed, now, abortSignal),
      { lockMaxWaitMs: SIWC_REFRESH_LOCK_MAX_WAIT_MS },
    );
  } catch (error) {
    if (!isZCodeFileLockTimeoutError(error)) throw error;
    // A lock timeout does not mean refresh failed; the winner may have rotated tokens.
    const current = await loadSiwcTokenState(options.credentialStore);
    if (current && isAccessUsable(current, now())) return current;
    throw error;
  }
}

async function refreshLocked(
  tokenClient: SiwcTokenClient,
  options: SiwcAccessTokenResolverOptions,
  observed: SiwcTokenState,
  now: () => number,
  abortSignal?: AbortSignal,
): Promise<SiwcTokenState> {
  const store = options.credentialStore;
  const current = await loadSiwcTokenState(store);
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
      [SIWC_CREDENTIAL_KEYS.accessToken]: response.accessToken,
      // Rotation: the response's refresh token replaces the old one atomically.
      ...(response.refreshToken
        ? { [SIWC_CREDENTIAL_KEYS.refreshToken]: response.refreshToken }
        : {}),
      ...(response.idToken ? { [SIWC_CREDENTIAL_KEYS.idToken]: response.idToken } : {}),
      ...(scopeValue ? { [SIWC_CREDENTIAL_KEYS.scopes]: scopeValue } : {}),
      [SIWC_CREDENTIAL_KEYS.accessExpiresAt]: String(expiresAt),
      ...(response.earliestRefreshAt !== undefined
        ? { [SIWC_CREDENTIAL_KEYS.earliestRefreshAt]: String(response.earliestRefreshAt) }
        : {}),
    });
    const after = await loadSiwcTokenState(store);
    if (!after?.accessToken) {
      throw new SiwcReloginRequiredError(
        "ChatGPT plan credentials disappeared during refresh. Sign in again.",
        { reason: "refresh_failed" },
      );
    }
    return after;
  } catch (error) {
    if (isSiwcTerminalRefreshError(error)) {
      // Terminal refresh failures clear tokens but retain the issued client id and account
      // mapping for a smooth re-auth (same retention rule as logout).
      await clearSiwcTokenCredentials(store);
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

/** Clear SIWC token credentials; retains the issued client id and account mapping. */
export async function clearSiwcTokenCredentials(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany" | "deleteIfValues">,
): Promise<void> {
  const keys = [
    SIWC_CREDENTIAL_KEYS.accessToken,
    SIWC_CREDENTIAL_KEYS.refreshToken,
    SIWC_CREDENTIAL_KEYS.idToken,
    SIWC_CREDENTIAL_KEYS.scopes,
    SIWC_CREDENTIAL_KEYS.accessExpiresAt,
    SIWC_CREDENTIAL_KEYS.earliestRefreshAt,
  ];
  const current = await credentialStore.loadMany(keys);
  await credentialStore.deleteIfValues(
    Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
    ),
  );
}

/** Entitlement gate: signed-in identity plus the plan-usage scope consent. */
export async function isSiwcPlanEntitled(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
): Promise<boolean> {
  const snapshot = await loadSiwcCredentialSnapshot(credentialStore);
  return snapshot !== null && isSiwcPlanUsageEntitled(snapshot.scopes);
}
