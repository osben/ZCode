import type {
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthStartResponse,
  SiwcLoginCompletionResult,
  SiwcLoginStart,
  SiwcPlanAccountsStatus,
  UserInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * OAuth authentication service.
 *
 * Runs in the host process and owns all OAuth flow business logic:
 * provider management, state lifecycle, token exchange, and credential storage.
 */
export interface IOAuthService {
  /** Get the available providers (only those with enabled=true). */
  getProviders(): Promise<OAuthProviderMeta[]>;

  /** Get the current active provider. */
  getActiveProvider(): Promise<OAuthProviderId | null>;

  /** Restore the session display state from the local cache at startup: return user information on success without validating the token remotely. */
  restoreCachedSession(): Promise<UserInfo | null>;

  /** Restore the local display state and distinguish never logged in from requiring reauthentication after JWT expiration. */
  restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult>;

  /** Explicitly validate the current provider session: return user information on success, or null on failure or expiration. */
  restoreSession(): Promise<UserInfo | null>;

  /**
   * Start OAuth: select a provider, generate state, and return the authorize URL.
   * The renderer sends the state to the main process for deep-link routing.
   */
  startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** Start OAuth using a short-lived backend flow; currently supported only by Z.AI, while other providers keep the existing flow. */
  startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** Query the current backend OAuth flow; return null if it is not time to poll, is still pending, or no flow exists. */
  pollPendingOAuth(): Promise<OAuthCallbackResult | null>;

  /**
   * Handle an OAuth callback: validate state; exchange the token and store credentials when a code is present, or persist attribution when only attribution parameters are present.
   * Return null when an accepted callback is invalidated by cancellation or a newer flow, so the caller can ignore it silently.
   * @param url - Full deep-link URL.
   */
  handleCallback(url: string): Promise<OAuthCallbackResult | null>;

  /**
   * Refresh the token.
   * @param provider - Optional; uses the active provider when omitted.
   */
  refreshToken(provider?: OAuthProviderId): Promise<void>;

  /**
   * Sign out of a provider.
   * @param provider - Optional; signs out of the active provider when omitted.
   */
  logout(provider?: OAuthProviderId): Promise<void>;

  /** Sign out of all providers. */
  logoutAll(): Promise<void>;

  /**
   * Cancel pending OAuth.
   * @param provider - Optional; cancels the current pending flow when omitted.
   */
  cancelPending(provider?: OAuthProviderId): Promise<void>;

  /**
   * ChatGPT plan (official OpenAI SIWC): start the loopback+PKCE login. Default adds an
   * account (no hints — OpenAI shows the account chooser); `reauthAccountKey` re-authorizes
   * that account. Independent of the zai/bigmodel flow; the UI opens authorizeUrl externally
   * and polls pollChatGptPlanLogin.
   */
  startChatGptPlanLogin(options?: { reauthAccountKey?: string }): Promise<SiwcLoginStart>;

  /** ChatGPT plan login poll; null while the browser redirect has not arrived yet. */
  pollChatGptPlanLogin(): Promise<SiwcLoginCompletionResult | null>;

  /** ChatGPT plan connection status per signed-in account (signed-in state and consent). */
  getChatGptPlanStatus(): Promise<SiwcPlanAccountsStatus>;

  /**
   * Revoke one account's ChatGPT plan refresh token and clear its local tokens (retains its
   * client id; other accounts untouched). Omitting the key signs out every account.
   */
  logoutChatGptPlan(
    accountKey?: string,
  ): Promise<{ accountCount: number; revoked: boolean; signedOut: boolean }>;

  /**
   * Start the per-account "Link usage" codex-flavor grant (read-only usage probe; tokens never
   * reach the inference path). The UI opens authorizeUrl externally and polls
   * pollChatGptUsageLink. Fails when the account is not signed in.
   */
  startChatGptUsageLink(accountKey: string): Promise<SiwcLoginStart>;

  /** Usage-link poll; null while the browser redirect has not arrived yet. */
  pollChatGptUsageLink(): Promise<{ accountKey: string } | null>;
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth);
