import { describe, expect, it } from "vitest";
import { readRelayConfig } from "../src/adapters/config.js";
import { identityKey, ISSUER, relaySigningKey } from "./support/keys.js";

function baseEnv(): Record<string, string> {
  const identity = identityKey("EdDSA", "login-1");
  return {
    ZCODE_RELAY_DB_PATH: "/var/lib/zcode-relay/relay.sqlite",
    ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS: JSON.stringify([relaySigningKey("relay-1").privateJwk]),
    ZCODE_REMOTE_RELAY_IDENTITY_ISSUER: ISSUER,
    ZCODE_REMOTE_RELAY_IDENTITY_JWKS: JSON.stringify({
      keys: [identity.publicJwk],
    }),
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
      readRelayConfig({
        ...env,
        ZCODE_RELAY_ALLOWED_ORIGINS: "https://zcode.example.invalid",
      }),
    ).not.toThrow();
  });
});

describe("identity mode selection", () => {
  const SECRET = "enrollment-secret-fixture-0123456789abcdef";
  function deviceEnv(extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ZCODE_RELAY_DB_PATH: "/var/lib/zcode-relay/relay.sqlite",
      ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS: JSON.stringify([relaySigningKey("relay-1").privateJwk]),
      ZCODE_REMOTE_RELAY_IDENTITY_MODE: "device-key",
      ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET: SECRET,
      ...extra,
    };
    return env;
  }

  it("defaults to zai-jwt when issuer and JWKS are set and mode is not", () => {
    expect(readRelayConfig(baseEnv()).session.identity).toMatchObject({
      mode: "zai-jwt",
    });
  });

  it("fails closed naming the mode variable when neither mode nor zai variables are set", () => {
    const env = deviceEnv();
    delete env.ZCODE_REMOTE_RELAY_IDENTITY_MODE;
    expect(() => readRelayConfig(env)).toThrow("ZCODE_REMOTE_RELAY_IDENTITY_MODE");
  });

  it("rejects an unknown mode, naming the variable and not echoing the value", () => {
    const env = deviceEnv({ ZCODE_REMOTE_RELAY_IDENTITY_MODE: "open-door" });
    expect(() => readRelayConfig(env)).toThrow("ZCODE_REMOTE_RELAY_IDENTITY_MODE");
    expect(() => readRelayConfig(env)).not.toThrow(/open-door/);
  });

  it("device-key mode needs no zai variables and carries the secret", () => {
    const config = readRelayConfig(deviceEnv());
    expect(config.session.identity).toEqual({
      mode: "device-key",
      enrollmentSecret: SECRET,
      enrollment: {
        mode: "secret",
        difficulty: 22,
        maxEnrolledKeys: 10_000,
        enrollmentsPerHour: 300,
      },
    });
    expect(config.warnings).toEqual([]);
  });

  it("starts open enrollment without a secret, validates the new variables, and keeps secret mode the default", () => {
    const env = deviceEnv({ ZCODE_REMOTE_RELAY_ENROLLMENT_MODE: "open" });
    delete env.ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET;
    const config = readRelayConfig({
      ...env,
      ZCODE_RELAY_ENROLLMENT_DIFFICULTY: "20",
      ZCODE_RELAY_MAX_ENROLLED_KEYS: "50",
      ZCODE_RELAY_MAX_SOCKETS_PER_IDENTITY: "3",
      ZCODE_RELAY_BYTES_PER_IDENTITY_PER_DAY: "1000",
      ZCODE_RELAY_KEY_IDLE_EXPIRY_DAYS: "7",
    });
    expect(config.session.identity).toEqual({
      mode: "device-key",
      enrollment: {
        mode: "open",
        difficulty: 20,
        maxEnrolledKeys: 50,
        enrollmentsPerHour: 300,
      },
    });
    expect(config.server.identityLimits).toEqual({
      maxSockets: 3,
      bytesPerDay: 1000,
    });
    expect(config.store).toMatchObject({
      maxEnrolledKeys: 50,
      keyIdleExpiryDays: 7,
    });

    const short = deviceEnv({
      ZCODE_REMOTE_RELAY_ENROLLMENT_MODE: "open",
      ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET: "too-short",
    });
    expect(() => readRelayConfig(short)).toThrow("ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET");
    expect(() =>
      readRelayConfig(deviceEnv({ ZCODE_REMOTE_RELAY_ENROLLMENT_MODE: "wide" })),
    ).toThrow("ZCODE_REMOTE_RELAY_ENROLLMENT_MODE");
    for (const value of ["7", "33", "x"]) {
      expect(() =>
        readRelayConfig(deviceEnv({ ZCODE_RELAY_ENROLLMENT_DIFFICULTY: value })),
      ).toThrow("ZCODE_RELAY_ENROLLMENT_DIFFICULTY");
    }
    // Unset mode keeps today's behavior: the secret stays required.
    const noSecret = deviceEnv();
    delete noSecret.ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET;
    expect(() => readRelayConfig(noSecret)).toThrow("ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET");
  });

  it("requires a long enough enrollment secret and never echoes it", () => {
    const missing = deviceEnv();
    delete missing.ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET;
    expect(() => readRelayConfig(missing)).toThrow("ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET");
    const short = deviceEnv({
      ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET: "too-short-secret",
    });
    expect(() => readRelayConfig(short)).toThrow("ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET");
    expect(() => readRelayConfig(short)).not.toThrow(/too-short-secret/);
  });

  it("ignores zai variables in device-key mode and warns by name only", () => {
    const env = deviceEnv({
      ZCODE_REMOTE_RELAY_IDENTITY_ISSUER: "https://secret-issuer.invalid",
      ZCODE_REMOTE_RELAY_IDENTITY_JWKS: "not even json",
    });
    const config = readRelayConfig(env);
    expect(config.warnings.join(" ")).toContain("ZCODE_REMOTE_RELAY_IDENTITY_ISSUER");
    expect(config.warnings.join(" ")).toContain("ZCODE_REMOTE_RELAY_IDENTITY_JWKS");
    expect(JSON.stringify(config.warnings)).not.toContain("secret-issuer");
  });

  it("does not require the enrollment secret in zai-jwt mode", () => {
    expect(() => readRelayConfig(baseEnv())).not.toThrow();
  });
});
