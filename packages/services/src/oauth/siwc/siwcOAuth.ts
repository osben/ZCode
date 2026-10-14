import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

/**
 * Host-side SIWC (Sign in with ChatGPT) protocol primitives.
 *
 * Deliberate duplication of the CLI adapters implementation: the Desktop host cannot import
 * apps/zcode-cli internals (same trade-off as the zai/bigmodel polling client duplication).
 * Wire details are pinned by the official OpenAI SIWC docs and must match the CLI exactly.
 */

export const SIWC_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
export const SIWC_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
export const SIWC_OPENID_CONFIGURATION_URL =
  "https://auth.openai.com/.well-known/openid-configuration";
export const SIWC_ISSUER = "https://auth.openai.com";
export const SIWC_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const SIWC_AGENT_NAME_HINT = "ZCode";
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const SIWC_PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
export const SIWC_CALLBACK_PATH = "/callback";

export const SIWC_TERMINAL_REFRESH_ERROR_CODES: readonly string[] = [
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
];

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

export interface SiwcPkcePair {
  codeChallenge: string;
  codeVerifier: string;
}

export function computeSiwcCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function createSiwcPkcePair(): SiwcPkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  return { codeChallenge: computeSiwcCodeChallenge(codeVerifier), codeVerifier };
}

export function createSiwcState(): string {
  return randomBytes(24).toString("base64url");
}

export function buildSiwcAuthorizeUrl(input: {
  codeChallenge: string;
  extAgentHostId: string;
  issuedClientId?: string;
  idTokenHint?: string;
  loginHint?: string;
  nonce: string;
  redirectUri: string;
  state: string;
}): string {
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
  if (input.idTokenHint?.trim()) params.set("id_token_hint", input.idTokenHint.trim());
  if (input.loginHint?.trim()) params.set("login_hint", input.loginHint.trim());
  return url.toString();
}

/** Mask PII-bearing params before an authorize URL is shown in the UI transcript. */
export function redactSiwcAuthorizeUrl(authorizeUrl: string): string {
  const url = new URL(authorizeUrl);
  for (const param of ["id_token_hint", "login_hint"]) {
    if (url.searchParams.has(param)) url.searchParams.set(param, "<redacted>");
  }
  return url.toString();
}

export interface SiwcTokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresInSeconds?: number;
  scope?: string;
  earliestRefreshAt?: number;
}

export class SiwcOAuthError extends Error {
  readonly error: string;
  readonly errorDescription?: string;
  readonly httpStatus?: number;

  constructor(options: {
    error: string;
    errorDescription?: string;
    httpStatus?: number;
    cause?: unknown;
  }) {
    super(
      options.errorDescription
        ? `SIWC OAuth error ${options.error}: ${options.errorDescription}`
        : `SIWC OAuth error: ${options.error}`,
      { cause: options.cause },
    );
    this.name = "SiwcOAuthError";
    this.error = options.error;
    this.errorDescription = options.errorDescription;
    this.httpStatus = options.httpStatus;
  }
}

export class SiwcRevokeError extends Error {
  readonly httpStatus?: number;

  constructor(message: string, options: { httpStatus?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "SiwcRevokeError";
    this.httpStatus = options.httpStatus;
  }
}

async function postForm(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    ...(signal ? { signal } : {}),
  });
}

async function parseTokenResponse(response: Response): Promise<SiwcTokenResponse> {
  const text = await response.text();
  let body: Record<string, unknown> | undefined;
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = undefined;
    }
  }
  if (!response.ok) {
    const error = typeof body?.error === "string" ? body.error.trim() : undefined;
    const detail =
      typeof body?.error_description === "string"
        ? body.error_description
        : typeof body?.detail === "string" && body.detail.trim()
          ? body.detail.trim()
          : undefined;
    throw new SiwcOAuthError({
      error: error ?? "request_failed",
      ...(detail ? { errorDescription: detail } : {}),
      httpStatus: response.status,
    });
  }
  const accessToken = typeof body?.access_token === "string" ? body.access_token.trim() : "";
  if (!accessToken) {
    throw new SiwcOAuthError({ error: "invalid_response", httpStatus: response.status });
  }
  return {
    accessToken,
    ...(typeof body?.refresh_token === "string" && body.refresh_token.trim()
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body?.id_token === "string" && body.id_token.trim()
      ? { idToken: body.id_token }
      : {}),
    ...(typeof body?.expires_in === "number" && Number.isFinite(body.expires_in)
      ? { expiresInSeconds: body.expires_in }
      : {}),
    ...(typeof body?.scope === "string" ? { scope: body.scope } : {}),
    ...(typeof body?.earliest_refresh_at === "number" && Number.isFinite(body.earliest_refresh_at)
      ? { earliestRefreshAt: body.earliest_refresh_at }
      : {}),
  };
}

export function createSiwcTokenClient(options: { fetchFn?: typeof globalThis.fetch } = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  return {
    async exchangeCode(input: {
      clientId: string;
      code: string;
      codeVerifier: string;
      redirectUri: string;
      signal?: AbortSignal;
    }): Promise<SiwcTokenResponse> {
      return parseTokenResponse(
        await postForm(
          fetchFn,
          SIWC_TOKEN_ENDPOINT,
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: input.clientId,
            code: input.code,
            code_verifier: input.codeVerifier,
            redirect_uri: input.redirectUri,
            resource: SIWC_RESOURCE,
          }),
          input.signal,
        ),
      );
    },
    async refresh(input: {
      clientId: string;
      refreshToken: string;
      signal?: AbortSignal;
    }): Promise<SiwcTokenResponse> {
      return parseTokenResponse(
        await postForm(
          fetchFn,
          SIWC_TOKEN_ENDPOINT,
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: input.clientId,
            refresh_token: input.refreshToken,
            resource: SIWC_RESOURCE,
          }),
          input.signal,
        ),
      );
    },
    async revoke(input: { clientId: string; refreshToken: string; signal?: AbortSignal }) {
      const discovery = await fetchFn(SIWC_OPENID_CONFIGURATION_URL, {
        headers: { accept: "application/json" },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!discovery.ok) {
        throw new SiwcRevokeError(`SIWC OIDC discovery failed with HTTP ${discovery.status}`, {
          httpStatus: discovery.status,
        });
      }
      const metadata = (await discovery.json()) as { revocation_endpoint?: unknown };
      if (
        typeof metadata.revocation_endpoint !== "string" ||
        !metadata.revocation_endpoint.trim()
      ) {
        throw new SiwcRevokeError("SIWC OIDC discovery did not provide a revocation_endpoint");
      }
      const response = await postForm(
        fetchFn,
        metadata.revocation_endpoint.trim(),
        new URLSearchParams({
          token: input.refreshToken,
          token_type_hint: "refresh_token",
          client_id: input.clientId,
        }),
        input.signal,
      );
      if (!response.ok) {
        throw new SiwcRevokeError(`SIWC token revocation failed with HTTP ${response.status}`, {
          httpStatus: response.status,
        });
      }
    },
  };
}

export interface SiwcIdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

/** RS256 id-token verification against the OpenAI JWKS (node:crypto only). */
export function createSiwcJwksVerifier(
  options: { fetchFn?: typeof globalThis.fetch; now?: () => number } = {},
) {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  let cachedKeys: readonly Record<string, unknown>[] | undefined;

  async function loadKeys(): Promise<readonly Record<string, unknown>[]> {
    const discovery = await fetchFn(SIWC_OPENID_CONFIGURATION_URL, {
      headers: { accept: "application/json" },
    });
    if (!discovery.ok) {
      throw new Error(`SIWC OIDC discovery failed with HTTP ${discovery.status}`);
    }
    const metadata = (await discovery.json()) as { jwks_uri?: unknown };
    if (typeof metadata.jwks_uri !== "string" || !metadata.jwks_uri.trim()) {
      throw new Error("SIWC OIDC discovery did not provide a jwks_uri");
    }
    const jwks = await fetchFn(metadata.jwks_uri.trim(), {
      headers: { accept: "application/json" },
    });
    if (!jwks.ok) {
      throw new Error(`SIWC JWKS fetch failed with HTTP ${jwks.status}`);
    }
    const parsed = (await jwks.json()) as { keys?: unknown };
    cachedKeys = Array.isArray(parsed?.keys)
      ? parsed.keys.filter(
          (key): key is Record<string, unknown> =>
            typeof key === "object" && key !== null && !Array.isArray(key),
        )
      : [];
    return cachedKeys;
  }

  async function resolveKey(kid: string | undefined): Promise<KeyObject> {
    const candidates = cachedKeys ?? (await loadKeys());
    const find = (keys: readonly Record<string, unknown>[]) =>
      keys.find((key) => key.kty === "RSA" && (kid === undefined || key.kid === kid));
    let match = find(candidates);
    if (!match && cachedKeys) {
      // Exactly one refetch for rotated keys.
      match = find(await loadKeys());
    }
    if (!match) {
      throw new Error(`SIWC JWKS does not contain a matching RSA key for kid ${String(kid)}`);
    }
    if (typeof match.n !== "string" || typeof match.e !== "string") {
      throw new Error("SIWC JWKS key is missing RSA members");
    }
    return createPublicKey({
      key: {
        kty: "RSA",
        n: match.n,
        e: match.e,
        ...(typeof match.kid === "string" ? { kid: match.kid } : {}),
        ...(match.alg === "RS256" ? { alg: "RS256" } : {}),
        ...(match.use === "sig" ? { use: "sig" } : {}),
      },
      format: "jwk",
    });
  }

  return {
    async verify(
      idToken: string,
      input: { audience: string; nonce: string },
    ): Promise<SiwcIdTokenClaims> {
      const segments = idToken.split(".");
      if (segments.length !== 3 || segments.some((segment) => !segment)) {
        throw new Error("SIWC id token is malformed");
      }
      const decode = (segment: string): Record<string, unknown> =>
        JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as Record<string, unknown>;
      const header = decode(segments[0]!);
      const payload = decode(segments[1]!);
      if (header.alg !== "RS256") {
        throw new Error(`SIWC id token must use RS256 (got ${String(header.alg)})`);
      }
      const key = await resolveKey(typeof header.kid === "string" ? header.kid : undefined);
      const valid = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${segments[0]}.${segments[1]}`, "ascii"),
        key,
        Buffer.from(segments[2]!, "base64url"),
      );
      if (!valid) throw new Error("SIWC id token signature mismatch");
      if (payload.iss !== SIWC_ISSUER) throw new Error("SIWC id token issuer mismatch");
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audience.includes(input.audience)) {
        throw new Error("SIWC id token audience mismatch");
      }
      if (typeof payload.exp !== "number" || payload.exp <= (options.now ?? Date.now)() / 1000) {
        throw new Error("SIWC id token has expired");
      }
      if (payload.nonce !== input.nonce) throw new Error("SIWC id token nonce mismatch");
      if (typeof payload.sub !== "string" || !payload.sub.trim()) {
        throw new Error("SIWC id token has no subject");
      }
      return {
        sub: payload.sub,
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
        ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        ...(typeof payload.picture === "string" ? { picture: payload.picture } : {}),
      };
    },
  };
}

export function parseSiwcScopes(value: string | null | undefined): readonly string[] {
  return (value ?? "")
    .split(/\s+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

export function isSiwcPlanUsageEntitled(scopes: readonly string[]): boolean {
  return scopes.includes(SIWC_PLAN_USAGE_SCOPE);
}
