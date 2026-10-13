import {
  SIWC_AGENT_NAME_HINT,
  SIWC_AUTHORIZATION_ENDPOINT,
  SIWC_DYNAMIC_CLIENT_ID,
  SIWC_PLAN_USAGE_SCOPE,
  SIWC_RESOURCE,
  SIWC_SCOPE,
} from "./siwc-constants.js";

export interface SiwcAuthorizeUrlInput {
  /** Loopback redirect: http://127.0.0.1:{port}/callback (literal 127.0.0.1, never localhost). */
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  /** Stable per-host id (RFC 9278 thumbprint URI or urn:uuid URI); reused across sign-ins. */
  readonly extAgentHostId: string;
  /**
   * Issued client id for a known account. When present this is a re-auth: the issued id is
   * used, agent_name_hint is omitted, and id_token_hint/login_hint are honored.
   * When absent this is a first registration via the dynamic bootstrap client.
   */
  readonly issuedClientId?: string;
  /** Retained id token (may be expired); selects the account and skips the session picker. */
  readonly idTokenHint?: string;
  /** Saved email; optional convenience hint on re-auth. */
  readonly loginHint?: string;
  /** e.g. "consent" to re-run the consent screen with the full scope set. */
  readonly prompt?: string;
}

/**
 * Build the SIWC authorization URL (OAuth 2.0 Authorization Code + PKCE, dynamic client
 * registration). First registration uses client_id=dynamic_agent_client plus
 * agent_name_hint; re-auth reuses the issued client id with id_token_hint.
 */
export function buildSiwcAuthorizeUrl(input: SiwcAuthorizeUrlInput): string {
  if (!input.issuedClientId && input.idTokenHint) {
    throw new Error("id_token_hint requires a known account (issued client id).");
  }
  const url = new URL(SIWC_AUTHORIZATION_ENDPOINT);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set(
    "client_id",
    input.issuedClientId?.trim() ? input.issuedClientId.trim() : SIWC_DYNAMIC_CLIENT_ID,
  );
  params.set("redirect_uri", input.redirectUri);
  params.set("scope", SIWC_SCOPE);
  params.set("resource", SIWC_RESOURCE);
  params.set("code_challenge", input.codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("state", input.state);
  params.set("nonce", input.nonce);
  params.set("ext_agent_host_id", input.extAgentHostId);
  if (!input.issuedClientId?.trim()) {
    params.set("agent_name_hint", SIWC_AGENT_NAME_HINT);
  }
  if (input.idTokenHint?.trim()) {
    params.set("id_token_hint", input.idTokenHint.trim());
  }
  if (input.loginHint?.trim()) {
    params.set("login_hint", input.loginHint.trim());
  }
  if (input.prompt?.trim()) {
    params.set("prompt", input.prompt.trim());
  }
  return url.toString();
}

/** The scope the consent flow must include for plan-backed inference. */
export function requiredPlanUsageScope(): string {
  return SIWC_PLAN_USAGE_SCOPE;
}
