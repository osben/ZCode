import { describe, expect, it } from "vitest";
import { buildSiwcAuthorizeUrl } from "../src/auth/siwc/siwc-authorize-url.js";
import { computeSiwcCodeChallenge } from "../src/auth/siwc/siwc-pkce.js";

const BASE_INPUT = {
  redirectUri: "http://127.0.0.1:53191/callback",
  state: "state-value",
  nonce: "nonce-value",
  codeChallenge: computeSiwcCodeChallenge("verifier-value"),
  extAgentHostId: "urn:uuid:0f4c2a1e-6c9d-4a70-9d0e-2f0a64ac1b31",
} as const;

describe("SIWC authorize URL builder", () => {
  it("builds a first-registration URL with the dynamic client and agent name hint", () => {
    const url = new URL(buildSiwcAuthorizeUrl({ ...BASE_INPUT }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    const params = url.searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("redirect_uri")).toBe(BASE_INPUT.redirectUri);
    expect(params.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    expect(params.get("resource")).toBe("https://api.openai.com/v1");
    expect(params.get("code_challenge")).toBe(BASE_INPUT.codeChallenge);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("state")).toBe("state-value");
    expect(params.get("nonce")).toBe("nonce-value");
    expect(params.get("ext_agent_host_id")).toBe(BASE_INPUT.extAgentHostId);
    expect(params.get("agent_name_hint")).toBe("ZCode");
    expect(params.has("id_token_hint")).toBe(false);
    expect(params.has("login_hint")).toBe(false);
  });

  it("builds a re-auth URL with the issued client id and id_token_hint", () => {
    const url = new URL(
      buildSiwcAuthorizeUrl({
        ...BASE_INPUT,
        issuedClientId: "oaiapp_issued-client",
        idTokenHint: "header.payload.signature",
        loginHint: "user@example.com",
      }),
    );
    const params = url.searchParams;
    expect(params.get("client_id")).toBe("oaiapp_issued-client");
    expect(params.get("id_token_hint")).toBe("header.payload.signature");
    expect(params.get("login_hint")).toBe("user@example.com");
    expect(params.has("agent_name_hint")).toBe(false);
    expect(params.get("ext_agent_host_id")).toBe(BASE_INPUT.extAgentHostId);
  });

  it("supports prompt=consent for re-consent after opt-in", () => {
    const url = new URL(
      buildSiwcAuthorizeUrl({ ...BASE_INPUT, issuedClientId: "oaiapp_x", prompt: "consent" }),
    );
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("rejects id_token_hint without a known account", () => {
    expect(() => buildSiwcAuthorizeUrl({ ...BASE_INPUT, idTokenHint: "token" })).toThrow(
      /issued client id/u,
    );
  });
});
