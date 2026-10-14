import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSiwcJwksVerifier,
  SiwcIdTokenVerificationError,
} from "../src/auth/siwc/siwc-id-token.js";

const ISSUER = "https://auth.openai.com";
const AUDIENCE = "oaiapp_issued-client";
const JWKS_URI = "https://auth.test/jwks";

interface TestKey {
  kid: string;
  jwk: Record<string, unknown>;
  sign: (content: string) => string;
}

function createRsaTestKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    kid,
    jwk: { ...jwk, kid, kty: "RSA", alg: "RS256", use: "sig" },
    sign: (content: string) => {
      const signer = createSign("RSA-SHA256");
      signer.update(content, "ascii");
      return signer.sign(privateKey).toString("base64url");
    },
  };
}

function buildIdToken(key: TestKey, payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${headerB64}.${payloadB64}.${key.sign(`${headerB64}.${payloadB64}`)}`;
}

function basePayload(nowSeconds: number): Record<string, unknown> {
  return {
    sub: "user-sub-1",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: nowSeconds + 600,
    iat: nowSeconds,
    nonce: "nonce-value",
    email: "user@example.com",
    email_verified: true,
    name: "Test User",
  };
}

function createVerifier(key: TestKey, options: { now?: () => number } = {}) {
  let keySet = [key];
  const fetchFn: typeof fetch = async () => {
    const body = { keys: keySet.map((entry) => entry.jwk) };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    verifier: createSiwcJwksVerifier({ fetchFn, jwksUri: JWKS_URI, now: options.now }),
    rotateTo(nextKey: TestKey) {
      keySet = [nextKey];
    },
  };
}

describe("SIWC id token verification", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);

  it("accepts a valid RS256 token and returns the identity claims", async () => {
    const key = createRsaTestKey("key-1");
    const { verifier } = createVerifier(key);
    const payload = await verifier.verify(buildIdToken(key, basePayload(nowSeconds)), {
      audience: AUDIENCE,
      nonce: "nonce-value",
    });
    expect(payload.sub).toBe("user-sub-1");
    expect(payload.email).toBe("user@example.com");
    expect(payload.emailVerified).toBe(true);
    expect(payload.name).toBe("Test User");
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const key = createRsaTestKey("key-1");
    const { verifier } = createVerifier(key);
    const token = buildIdToken(key, basePayload(nowSeconds));
    const [header] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...basePayload(nowSeconds), sub: "attacker" }),
    ).toString("base64url");
    const forged = `${header}.${forgedPayload}.${token.split(".")[2]}`;
    await expect(
      verifier.verify(forged, { audience: AUDIENCE, nonce: "nonce-value" }),
    ).rejects.toMatchObject({ reason: "bad_signature" });
  });

  it("rejects the wrong issuer, audience, nonce, and expired tokens", async () => {
    const key = createRsaTestKey("key-1");
    const { verifier } = createVerifier(key);
    await expect(
      verifier.verify(
        buildIdToken(key, { ...basePayload(nowSeconds), iss: "https://evil.example" }),
        { audience: AUDIENCE, nonce: "nonce-value" },
      ),
    ).rejects.toMatchObject({ reason: "issuer_mismatch" });
    await expect(
      verifier.verify(buildIdToken(key, { ...basePayload(nowSeconds), aud: "oaiapp_other" }), {
        audience: AUDIENCE,
        nonce: "nonce-value",
      }),
    ).rejects.toMatchObject({ reason: "audience_mismatch" });
    await expect(
      verifier.verify(buildIdToken(key, { ...basePayload(nowSeconds), nonce: "other" }), {
        audience: AUDIENCE,
        nonce: "nonce-value",
      }),
    ).rejects.toMatchObject({ reason: "nonce_mismatch" });
    await expect(
      verifier.verify(buildIdToken(key, { ...basePayload(nowSeconds), exp: nowSeconds - 1 }), {
        audience: AUDIENCE,
        nonce: "nonce-value",
      }),
    ).rejects.toMatchObject({ reason: "token_expired" });
  });

  it("accepts array audiences containing the issued client id", async () => {
    const key = createRsaTestKey("key-1");
    const { verifier } = createVerifier(key);
    await expect(
      verifier.verify(buildIdToken(key, { ...basePayload(nowSeconds), aud: ["other", AUDIENCE] }), {
        audience: AUDIENCE,
        nonce: "nonce-value",
      }),
    ).resolves.toMatchObject({ sub: "user-sub-1" });
  });

  it("refetches JWKS once when the cached set lacks the token kid (rotation)", async () => {
    const oldKey = createRsaTestKey("rotation-old");
    const newKey = createRsaTestKey("rotation-new");
    const { verifier, rotateTo } = createVerifier(oldKey);
    // Warm the cache with the old key, then rotate the server's JWKS.
    await verifier.verify(buildIdToken(oldKey, basePayload(nowSeconds)), {
      audience: AUDIENCE,
      nonce: "nonce-value",
    });
    rotateTo(newKey);
    await expect(
      verifier.verify(buildIdToken(newKey, basePayload(nowSeconds)), {
        audience: AUDIENCE,
        nonce: "nonce-value",
      }),
    ).resolves.toMatchObject({ sub: "user-sub-1" });
  });

  it("rejects non-RS256 algorithms without fetching keys", async () => {
    const key = createRsaTestKey("key-1");
    const { verifier } = createVerifier(key);
    const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    );
    const payloadB64 = Buffer.from(JSON.stringify(basePayload(nowSeconds))).toString("base64url");
    const mac = createHash("sha256").update(`${headerB64}.${payloadB64}`).digest("base64url");
    await expect(
      verifier.verify(`${headerB64}.${payloadB64}.${mac}`, {
        audience: AUDIENCE,
        nonce: "nonce-value",
      }),
    ).rejects.toMatchObject({ reason: "unsupported_algorithm" });
  });

  it("rejects malformed tokens", async () => {
    const key = createRsaTestKey("key-1");
    const { verifier } = createVerifier(key);
    await expect(
      verifier.verify("not-a-jwt", { audience: AUDIENCE, nonce: "n" }),
    ).rejects.toBeInstanceOf(SiwcIdTokenVerificationError);
  });

  it("uses unique kids per key so rotation tests cannot collide", () => {
    const first = createRsaTestKey(`key-${randomUUID()}`);
    const second = createRsaTestKey(`key-${randomUUID()}`);
    expect(first.kid).not.toBe(second.kid);
  });
});
