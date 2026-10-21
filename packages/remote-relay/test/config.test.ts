import { describe, expect, it } from "vitest";
import { readRelayConfig } from "../src/adapters/config.js";
import { identityKey, ISSUER, relaySigningKey } from "./support/keys.js";

function baseEnv(): Record<string, string> {
  const identity = identityKey("EdDSA", "login-1");
  return {
    ZCODE_RELAY_DB_PATH: "/var/lib/zcode-relay/relay.sqlite",
    ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS: JSON.stringify([relaySigningKey("relay-1").privateJwk]),
    ZCODE_REMOTE_RELAY_IDENTITY_ISSUER: ISSUER,
    ZCODE_REMOTE_RELAY_IDENTITY_JWKS: JSON.stringify({ keys: [identity.publicJwk] }),
  };
}

describe("relay configuration", () => {
  it("reads the defaults when only required variables are set", () => {
    const config = readRelayConfig(baseEnv());
    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      port: 3031,
      authTimeoutMs: 15_000,
    });
    expect(config.session.ttlSeconds).toBe(3600);
    expect(config.session.identity.userClaim).toBe("sub");
    expect(config.store.path).toBe("/var/lib/zcode-relay/relay.sqlite");
  });

  it.each([
    "ZCODE_RELAY_DB_PATH",
    "ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS",
    "ZCODE_REMOTE_RELAY_IDENTITY_ISSUER",
    "ZCODE_REMOTE_RELAY_IDENTITY_JWKS",
  ])("fails closed and names %s when it is missing", (name) => {
    const env = baseEnv();
    delete env[name];
    expect(() => readRelayConfig(env)).toThrow(name);
  });

  it("names the variable but never its value when key material is malformed", () => {
    const env = baseEnv();
    env.ZCODE_REMOTE_RELAY_IDENTITY_JWKS = "{secret-looking-text";
    let message = "";
    try {
      readRelayConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("ZCODE_REMOTE_RELAY_IDENTITY_JWKS");
    expect(message).not.toContain("secret-looking-text");
  });

  it("rejects a TTL above the 24 hour maximum", () => {
    const env = { ...baseEnv(), ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS: "86401" };
    expect(() => readRelayConfig(env)).toThrow("ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS");
  });

  it("requires explicit Web origins for a public bind address", () => {
    const env = { ...baseEnv(), ZCODE_RELAY_HOST: "0.0.0.0" };
    expect(() => readRelayConfig(env)).toThrow("explicit Web origins");
    expect(() =>
      readRelayConfig({ ...env, ZCODE_RELAY_ALLOWED_ORIGINS: "https://zcode.example.invalid" }),
    ).not.toThrow();
  });
});
