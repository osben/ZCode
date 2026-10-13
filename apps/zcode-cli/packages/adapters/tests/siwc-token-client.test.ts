import { describe, expect, it } from "vitest";
import {
  createSiwcTokenClient,
  SiwcOAuthError,
  type SiwcTokenResponse,
} from "../src/auth/siwc/siwc-token-client.js";

interface RecordedRequest {
  url: string;
  body: URLSearchParams;
  headers: Record<string, string>;
}

function createRecordingFetch(
  handler: (
    request: RecordedRequest,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): { fetchFn: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: RecordedRequest = { url: String(input), body, headers };
    requests.push(request);
    const { status, body: responseBody } = await handler(request);
    return new Response(
      responseBody === undefined || responseBody === null ? "" : JSON.stringify(responseBody),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchFn, requests };
}

const TOKEN_RESPONSE_BODY = {
  access_token: "access-token-1",
  refresh_token: "refresh-token-1",
  id_token: "id-token-1",
  token_type: "bearer",
  expires_in: 3600,
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  earliest_refresh_at: 1_770_000_000,
};

describe("SIWC token client", () => {
  it("exchanges the authorization code with the issued client id and PKCE verifier", async () => {
    const { fetchFn, requests } = createRecordingFetch(() => ({
      status: 200,
      body: TOKEN_RESPONSE_BODY,
    }));
    const client = createSiwcTokenClient({
      fetchFn,
      endpoints: { tokenEndpoint: "https://auth.test/token" },
    });
    const response = await client.exchangeCode({
      clientId: "oaiapp_issued",
      code: "auth-code",
      codeVerifier: "verifier",
      redirectUri: "http://127.0.0.1:1234/callback",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://auth.test/token");
    expect(requests[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(requests[0]!.body.get("grant_type")).toBe("authorization_code");
    expect(requests[0]!.body.get("client_id")).toBe("oaiapp_issued");
    expect(requests[0]!.body.get("code")).toBe("auth-code");
    expect(requests[0]!.body.get("code_verifier")).toBe("verifier");
    expect(requests[0]!.body.get("redirect_uri")).toBe("http://127.0.0.1:1234/callback");
    expect(requests[0]!.body.get("resource")).toBe("https://api.openai.com/v1");
    expect(requests[0]!.body.has("client_secret")).toBe(false);

    expect(response).toEqual({
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      idToken: "id-token-1",
      tokenType: "bearer",
      expiresInSeconds: 3600,
      scope: TOKEN_RESPONSE_BODY.scope,
      earliestRefreshAt: 1_770_000_000,
    } satisfies SiwcTokenResponse);
  });

  it("refreshes with the issued client id, rotating refresh token, and no scope", async () => {
    const { fetchFn, requests } = createRecordingFetch(() => ({
      status: 200,
      body: {
        access_token: "access-token-2",
        refresh_token: "refresh-token-2",
        expires_in: 3600,
      },
    }));
    const client = createSiwcTokenClient({
      fetchFn,
      endpoints: { tokenEndpoint: "https://auth.test/token" },
    });
    const response = await client.refresh({
      clientId: "oaiapp_issued",
      refreshToken: "refresh-token-1",
    });

    const body = requests[0]!.body;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("oaiapp_issued");
    expect(body.get("refresh_token")).toBe("refresh-token-1");
    expect(body.get("resource")).toBe("https://api.openai.com/v1");
    expect(body.has("scope")).toBe(false);
    expect(response.refreshToken).toBe("refresh-token-2");
  });

  it("maps token endpoint errors to SiwcOAuthError with the server code", async () => {
    const { fetchFn } = createRecordingFetch(() => ({
      status: 400,
      body: { error: "refresh_token_reused", error_description: "Rotation reuse detected" },
    }));
    const client = createSiwcTokenClient({
      fetchFn,
      endpoints: { tokenEndpoint: "https://auth.test/token" },
    });
    const error = await client
      .refresh({ clientId: "oaiapp_issued", refreshToken: "stale" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SiwcOAuthError);
    expect((error as SiwcOAuthError).error).toBe("refresh_token_reused");
    expect((error as SiwcOAuthError).errorDescription).toBe("Rotation reuse detected");
    expect((error as SiwcOAuthError).httpStatus).toBe(400);
  });

  it("maps detail-only bodies (direct admission failures) to SiwcOAuthError", async () => {
    const { fetchFn } = createRecordingFetch(() => ({
      status: 403,
      body: { detail: "Request body too large" },
    }));
    const client = createSiwcTokenClient({
      fetchFn,
      endpoints: { tokenEndpoint: "https://auth.test/token" },
    });
    const error = await client
      .exchangeCode({
        clientId: "oaiapp_issued",
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:1234/callback",
      })
      .catch((caught: unknown) => caught);
    expect((error as SiwcOAuthError).error).toBe("request_failed");
    expect((error as SiwcOAuthError).errorDescription).toBe("Request body too large");
  });

  it("revokes via the discovery revocation endpoint and accepts empty 200", async () => {
    const { fetchFn, requests } = createRecordingFetch((request) => {
      if (request.url === "https://auth.test/.well-known/openid-configuration") {
        return {
          status: 200,
          body: {
            revocation_endpoint: "https://auth.test/revoke",
            jwks_uri: "https://auth.test/jwks",
          },
        };
      }
      return { status: 200, body: undefined };
    });
    const client = createSiwcTokenClient({
      fetchFn,
      endpoints: { openidConfigurationUrl: "https://auth.test/.well-known/openid-configuration" },
    });
    await client.revoke({ clientId: "oaiapp_issued", refreshToken: "refresh-token-1" });

    const revoke = requests.find((request) => request.url === "https://auth.test/revoke");
    expect(revoke).toBeDefined();
    expect(revoke!.body.get("token")).toBe("refresh-token-1");
    expect(revoke!.body.get("token_type_hint")).toBe("refresh_token");
    expect(revoke!.body.get("client_id")).toBe("oaiapp_issued");
  });

  it("reports revocation failures with the HTTP status", async () => {
    const { fetchFn } = createRecordingFetch((request) => {
      if (request.url.endsWith("openid-configuration")) {
        return { status: 200, body: { revocation_endpoint: "https://auth.test/revoke" } };
      }
      return { status: 503, body: { detail: "temporarily unavailable" } };
    });
    const client = createSiwcTokenClient({ fetchFn });
    await expect(
      client.revoke({ clientId: "oaiapp_issued", refreshToken: "refresh-token-1" }),
    ).rejects.toThrow(/HTTP 503/u);
  });

  it("rejects token responses without an access token", async () => {
    const { fetchFn } = createRecordingFetch(() => ({ status: 200, body: { scope: "openid" } }));
    const client = createSiwcTokenClient({
      fetchFn,
      endpoints: { tokenEndpoint: "https://auth.test/token" },
    });
    await expect(
      client.refresh({ clientId: "oaiapp_issued", refreshToken: "stale" }),
    ).rejects.toThrow(/invalid_response/u);
  });
});
