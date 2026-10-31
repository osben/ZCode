import { join } from "node:path";
import { isChatGptPlanAccountKey } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { ICredentialService } from "../../credential/credential.js";

/**
 * Purge of codex-flavor usage grants stored by builds that shipped "Link usage"
 * (specs/chatgpt-plan-signin.md "Usage limits → Leftover grant purge"). The usage probe was
 * removed; this revoke is the only request left that uses the Codex client id.
 */

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REVOKE_ENDPOINT = "https://auth.openai.com/oauth/revoke";
const REVOKE_TIMEOUT_MS = 15_000;
const LOCK_MAX_WAIT_MS = 45_000;
const CODEX_KEY_SUFFIXES = [
  "access_token",
  "refresh_token",
  "id_token",
  "account_id",
  "access_expires_at",
  "earliest_refresh_at",
] as const;

function leftoverKeys(accountKey: string): string[] {
  return [
    ...CODEX_KEY_SUFFIXES.map((suffix) => `oauth:chatgpt-codex:${accountKey}:${suffix}`),
    `fork:oauth:chatgpt:${accountKey}:usage-epoch`,
  ];
}

export class SiwcCodexGrantPurge {
  constructor(
    private readonly credentials: ICredentialService,
    private readonly configDir: string,
    private readonly fetchFn: typeof globalThis.fetch,
  ) {}

  /** Revoke (best effort) and delete one account's leftover grant; no request when nothing is stored. */
  async purgeAccount(accountKey: string): Promise<void> {
    if (!isChatGptPlanAccountKey(accountKey)) return;
    const keys = leftoverKeys(accountKey);
    if (!(await this.hasAny(keys))) return;
    // Same lock file the removed refresh path used, so an older build's refresh cannot re-persist tokens.
    await withFileLock(
      join(this.configDir, `siwc-chatgpt-codex.${accountKey}.refresh`),
      async () => {
        const values = await Promise.all(keys.map((key) => this.credentials.load(key)));
        if (values.every((value) => !value)) return;
        const refreshToken =
          values[keys.indexOf(`oauth:chatgpt-codex:${accountKey}:refresh_token`)];
        if (refreshToken) await this.revoke(refreshToken);
        for (const key of keys) await this.credentials.delete(key);
      },
      { lockMaxWaitMs: LOCK_MAX_WAIT_MS },
    );
  }

  private async hasAny(keys: readonly string[]): Promise<boolean> {
    const values = await Promise.all(keys.map((key) => this.credentials.load(key)));
    return values.some(Boolean);
  }

  private async revoke(refreshToken: string): Promise<void> {
    try {
      await this.fetchFn(CODEX_REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: CODEX_CLIENT_ID,
        }).toString(),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
    } catch {
      // Best effort: local deletion proceeds regardless.
    }
  }
}
