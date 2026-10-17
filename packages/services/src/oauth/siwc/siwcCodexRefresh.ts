import { join } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import { SIWC_TERMINAL_REFRESH_ERROR_CODES, SiwcOAuthError } from "./siwcOAuth.js";
import {
  buildSiwcCodexCredentialKeys,
  buildSiwcCodexRefreshLockFileName,
  type createSiwcCodexTokenClient,
  type SiwcCodexTokenSet,
} from "./siwcCodexWire.js";
import type { ICredentialService } from "../../credential/credential.js";
export const SIWC_CODEX_REFRESH_LOCK_MAX_WAIT_MS = 45_000;

/** The token endpoint's JSON body rides in SiwcOAuthError.cause; its `error` code decides terminality. */
function readOAuthErrorCode(error: SiwcOAuthError): string | null {
  const detail = error.cause instanceof Error ? error.cause.message : "";
  try {
    const parsed = JSON.parse(detail) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

export async function refreshSiwcCodexAccessToken(
  accountKey: string,
  dependencies: {
    configDir: string;
    tokenClient: ReturnType<typeof createSiwcCodexTokenClient>;
    credentialService: ICredentialService;
    readCredentials: (...keys: string[]) => Promise<Record<string, string | null>>;
    writeCredentials: (entries: Record<string, string>) => Promise<void>;
    now: () => number;
    onCleared: () => void;
  },
): Promise<string | null> {
  return withFileLock(
    join(dependencies.configDir, buildSiwcCodexRefreshLockFileName(accountKey)),
    async () => {
      const keys = buildSiwcCodexCredentialKeys(accountKey);
      const stored = await dependencies.readCredentials(keys.refreshToken);
      const refreshToken = stored[keys.refreshToken];
      if (!refreshToken) return null;
      let next: SiwcCodexTokenSet;
      try {
        next = await dependencies.tokenClient.refresh({ refreshToken });
      } catch (error) {
        // A terminal OAuth error code (revoked/expired/reused refresh token — the same set the
        // SIWC refresh path uses) can never succeed on retry; clearing the slot under the held
        // lock lets the user link usage again instead of keeping a permanently failing grant
        // that pins usageLinked=true. Non-terminal codes (for example invalid_request) and
        // transport errors rethrow untouched.
        if (
          error instanceof SiwcOAuthError &&
          SIWC_TERMINAL_REFRESH_ERROR_CODES.includes(readOAuthErrorCode(error) ?? "")
        ) {
          for (const key of [
            keys.accessToken,
            keys.refreshToken,
            keys.idToken,
            keys.accountId,
            keys.accessExpiresAt,
            keys.earliestRefreshAt,
          ]) {
            await dependencies.credentialService.delete(key);
          }
          dependencies.onCleared();
          return null;
        }
        throw error;
      }
      await dependencies.writeCredentials({
        ...(next.refreshToken ? { [keys.refreshToken]: next.refreshToken } : {}),
        [keys.accessToken]: next.accessToken,
        ...(next.idToken ? { [keys.idToken]: next.idToken } : {}),
        [keys.accessExpiresAt]: String(
          Math.floor(dependencies.now() / 1000) + (next.expiresInSeconds ?? 10 * 24 * 60 * 60),
        ),
        ...(next.earliestRefreshAt !== undefined
          ? { [keys.earliestRefreshAt]: String(next.earliestRefreshAt) }
          : {}),
      });
      return next.accessToken;
    },
    { lockMaxWaitMs: SIWC_CODEX_REFRESH_LOCK_MAX_WAIT_MS },
  );
}
