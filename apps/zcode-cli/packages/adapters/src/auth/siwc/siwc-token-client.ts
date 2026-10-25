import {
  SIWC_OPENID_CONFIGURATION_URL,
  SIWC_RESOURCE,
  SIWC_TOKEN_ENDPOINT,
} from "./siwc-constants.js";

export interface SiwcTokenResponse {
  readonly accessToken: string;
  /** Rotated replacement refresh token; every refresh returns a new one. */
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly tokenType?: string;
  readonly expiresInSeconds?: number;
  readonly scope?: string;
  /** Epoch seconds; refreshing before this point must be avoided. */
  readonly earliestRefreshAt?: number;
}

export interface SiwcOAuthErrorOptions {
  readonly cause?: unknown;
  readonly error: string;
  readonly errorDescription?: string;
  readonly httpStatus?: number;
}

/** OAuth token-endpoint failure with the server-provided error code preserved. */
export class SiwcOAuthError extends Error {
  readonly error: string;
  readonly errorDescription?: string;
  readonly httpStatus?: number;

  constructor(options: SiwcOAuthErrorOptions) {
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

  constructor(message: string, options: { cause?: unknown; httpStatus?: number } = {}) {
    super(message, { cause: options.cause });
    this.name = "SiwcRevokeError";
    this.httpStatus = options.httpStatus;
  }
}

export interface SiwcTokenClient {
  exchangeCode(input: {
    readonly clientId: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly signal?: AbortSignal;
  }): Promise<SiwcTokenResponse>;
  refresh(input: {
    readonly clientId: string;
    readonly refreshToken: string;
    readonly signal?: AbortSignal;
  }): Promise<SiwcTokenResponse>;
  /** Revoke the refresh token at the OIDC discovery revocation endpoint. Empty 200 = success. */
  revoke(input: {
    readonly clientId: string;
    readonly refreshToken: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export interface SiwcTokenClientOptions {
  readonly fetchFn?: typeof globalThis.fetch;
  /** Test/override endpoints; defaults are the public auth.openai.com endpoints. */
  readonly endpoints?: {
    readonly tokenEndpoint?: string;
    readonly openidConfigurationUrl?: string;
  };
}

interface SiwcTokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  earliest_refresh_at?: unknown;
}

export function createSiwcTokenClient(options: SiwcTokenClientOptions = {}): SiwcTokenClient {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const tokenEndpoint = options.endpoints?.tokenEndpoint ?? SIWC_TOKEN_ENDPOINT;
  const openidConfigurationUrl =
    options.endpoints?.openidConfigurationUrl ?? SIWC_OPENID_CONFIGURATION_URL;

  return {
    async exchangeCode(input) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        resource: SIWC_RESOURCE,
      });
      return parseSiwcTokenResponse(await postForm(fetchFn, tokenEndpoint, body, input.signal));
    },
    async refresh(input) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: input.clientId,
        refresh_token: input.refreshToken,
        resource: SIWC_RESOURCE,
      });
      // scope is intentionally omitted so the existing grant is kept unchanged.
      return parseSiwcTokenResponse(await postForm(fetchFn, tokenEndpoint, body, input.signal));
    },
    async revoke(input) {
      const revocationEndpoint = await resolveRevocationEndpoint(
        fetchFn,
        openidConfigurationUrl,
        input.signal,
      );
      const body = new URLSearchParams({
        token: input.refreshToken,
        token_type_hint: "refresh_token",
        client_id: input.clientId,
      });
      const response = await postFormRaw(fetchFn, revocationEndpoint, body, input.signal);
      // The revocation endpoint answers empty 200 even for already-invalid tokens; anything
      // else means the request could not be confirmed.
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new SiwcRevokeError(
          `SIWC token revocation failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          { httpStatus: response.status },
        );
      }
    },
  };
}

async function resolveRevocationEndpoint(
  fetchFn: typeof globalThis.fetch,
  openidConfigurationUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchFn(openidConfigurationUrl, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new SiwcRevokeError(`SIWC OIDC discovery failed with HTTP ${response.status}`, {
      httpStatus: response.status,
    });
  }
  const parsed = (await response.json()) as { revocation_endpoint?: unknown };
  if (typeof parsed.revocation_endpoint !== "string" || !parsed.revocation_endpoint.trim()) {
    throw new SiwcRevokeError("SIWC OIDC discovery did not provide a revocation_endpoint");
  }
  return parsed.revocation_endpoint.trim();
}

async function postFormRaw(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    ...(signal ? { signal } : {}),
  });
}

async function postForm(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<SiwcTokenResponseBody> {
  const response = await postFormRaw(fetchFn, url, body, signal);
  if (!response.ok) {
    throw await toSiwcOAuthError(response);
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new SiwcOAuthError({ error: "invalid_response", httpStatus: response.status });
  }
  try {
    return JSON.parse(text) as SiwcTokenResponseBody;
  } catch (error) {
    throw new SiwcOAuthError({
      cause: error,
      error: "invalid_response",
      httpStatus: response.status,
    });
  }
}

async function toSiwcOAuthError(response: Response): Promise<SiwcOAuthError> {
  const payload = await readJsonBody(response);
  const record = isRecord(payload) ? payload : undefined;
  const error = record?.error;
  const detail = record?.detail;
  const errorDescription = record?.error_description;
  if (typeof error === "string" && error.trim()) {
    return new SiwcOAuthError({
      error: error.trim(),
      ...(typeof errorDescription === "string" ? { errorDescription } : {}),
      httpStatus: response.status,
    });
  }
  // Direct-admission failures may return {"detail": "..."} without a standard error object.
  if (typeof detail === "string" && detail.trim()) {
    return new SiwcOAuthError({
      error: "request_failed",
      errorDescription: detail.trim(),
      httpStatus: response.status,
    });
  }
  return new SiwcOAuthError({ error: "request_failed", httpStatus: response.status });
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  const payload = await readJsonBody(response);
  const record = isRecord(payload) ? payload : undefined;
  const detail = record?.detail ?? record?.error;
  return typeof detail === "string" && detail.trim() ? detail.trim() : undefined;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseSiwcTokenResponse(body: SiwcTokenResponseBody): SiwcTokenResponse {
  if (typeof body.access_token !== "string" || !body.access_token.trim()) {
    throw new SiwcOAuthError({ error: "invalid_response" });
  }
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" && body.refresh_token.trim()
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(typeof body.id_token === "string" && body.id_token.trim()
      ? { idToken: body.id_token }
      : {}),
    ...(typeof body.token_type === "string" ? { tokenType: body.token_type } : {}),
    ...(typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? { expiresInSeconds: body.expires_in }
      : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
    ...(typeof body.earliest_refresh_at === "number" && Number.isFinite(body.earliest_refresh_at)
      ? { earliestRefreshAt: body.earliest_refresh_at }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
