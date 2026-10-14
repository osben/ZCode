import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { SIWC_ISSUER, SIWC_OPENID_CONFIGURATION_URL } from "./siwc-constants.js";

export interface SiwcIdTokenPayload {
  readonly sub: string;
  readonly iss: string;
  /** Audience: the issued client id (string or array form is accepted). */
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat?: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  readonly picture?: string;
}

export interface SiwcIdTokenVerificationInput {
  /** The issued client id the token was minted for. */
  readonly audience: string;
  /** Fresh per-attempt nonce from the authorize request. */
  readonly nonce: string;
  readonly issuer?: string;
  readonly clockSkewSeconds?: number;
}

export interface SiwcJwksVerifierOptions {
  readonly fetchFn?: typeof globalThis.fetch;
  readonly jwksUri?: string;
  readonly now?: () => number;
}

export interface SiwcJwksVerifier {
  verify(idToken: string, input: SiwcIdTokenVerificationInput): Promise<SiwcIdTokenPayload>;
}

export class SiwcIdTokenVerificationError extends Error {
  readonly reason:
    | "malformed_token"
    | "unsupported_algorithm"
    | "unknown_key"
    | "bad_signature"
    | "issuer_mismatch"
    | "audience_mismatch"
    | "token_expired"
    | "nonce_mismatch";

  constructor(reason: SiwcIdTokenVerificationError["reason"], message: string) {
    super(message);
    this.name = "SiwcIdTokenVerificationError";
    this.reason = reason;
  }
}

interface CachedJwks {
  keys: readonly Record<string, unknown>[];
}

/**
 * Minimal RS256 id-token verification against OpenAI's JWKS using node:crypto only
 * (no jose dependency). JWKS is cached by kid; an unknown kid triggers one refetch.
 */
export function createSiwcJwksVerifier(options: SiwcJwksVerifierOptions = {}): SiwcJwksVerifier {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  let cachedJwks: CachedJwks | undefined;

  async function loadJwks(jwksUri: string): Promise<CachedJwks> {
    const response = await fetchFn(jwksUri, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new SiwcIdTokenVerificationError(
        "unknown_key",
        `Unable to load SIWC JWKS (HTTP ${response.status}).`,
      );
    }
    const parsed = (await response.json()) as { keys?: unknown };
    const keys = Array.isArray(parsed?.keys)
      ? parsed.keys.filter(
          (key): key is Record<string, unknown> =>
            typeof key === "object" && key !== null && !Array.isArray(key),
        )
      : [];
    const loaded: CachedJwks = { keys };
    cachedJwks = loaded;
    return loaded;
  }

  function findRsaJwk(
    jwks: CachedJwks,
    kid: string | undefined,
  ): Record<string, unknown> | undefined {
    return jwks.keys.find((key) => key.kty === "RSA" && (kid === undefined || key.kid === kid));
  }

  async function toKeyObject(
    jwk: Record<string, unknown>,
    kid: string | undefined,
  ): Promise<KeyObject> {
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") {
      throw new SiwcIdTokenVerificationError(
        "unknown_key",
        `SIWC JWKS key for kid ${String(kid)} is missing RSA modulus/exponent members.`,
      );
    }
    try {
      // Only the public JWK members are passed through; unknown members are ignored by createPublicKey.
      return createPublicKey({
        key: {
          kty: "RSA",
          n: jwk.n,
          e: jwk.e,
          ...(typeof jwk.kid === "string" ? { kid: jwk.kid } : {}),
          ...(jwk.alg === "RS256" ? { alg: "RS256" } : {}),
          ...(jwk.use === "sig" ? { use: "sig" } : {}),
        },
        format: "jwk",
      });
    } catch (error) {
      throw new SiwcIdTokenVerificationError(
        "unknown_key",
        `SIWC JWKS key for kid ${String(kid)} is unusable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function resolveSigningKey(jwksUri: string, kid: string | undefined): Promise<KeyObject> {
    // Try the cached JWKS first; an unknown kid triggers exactly one refetch (key rotation).
    const cachedMatch = cachedJwks ? findRsaJwk(cachedJwks, kid) : undefined;
    if (cachedMatch) {
      return toKeyObject(cachedMatch, kid);
    }
    const refreshed = await loadJwks(jwksUri);
    const refreshedMatch = findRsaJwk(refreshed, kid);
    if (!refreshedMatch) {
      throw new SiwcIdTokenVerificationError(
        "unknown_key",
        `SIWC JWKS does not contain a matching RSA key${kid ? ` for kid ${kid}` : ""}.`,
      );
    }
    return toKeyObject(refreshedMatch, kid);
  }

  return {
    async verify(idToken, input) {
      const segments = idToken.split(".");
      if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
        throw new SiwcIdTokenVerificationError(
          "malformed_token",
          "SIWC id token is not a signed JWS with three segments.",
        );
      }
      const header = parseJsonSegment(segments[0]!);
      const payloadRecord = parseJsonSegment(segments[1]!);
      if (header.alg !== "RS256") {
        throw new SiwcIdTokenVerificationError(
          "unsupported_algorithm",
          `SIWC id token must use RS256 (got ${String(header.alg)}).`,
        );
      }
      const kid = typeof header.kid === "string" ? header.kid : undefined;
      const jwksUri = options.jwksUri ?? (await resolveJwksUri(fetchFn));
      const publicKey = await resolveSigningKey(jwksUri, kid);
      const signature = Buffer.from(segments[2]!, "base64url");
      const signedContent = Buffer.from(`${segments[0]}.${segments[1]}`, "ascii");
      const valid = verifySignature("RSA-SHA256", signedContent, publicKey, signature);
      if (!valid) {
        throw new SiwcIdTokenVerificationError(
          "bad_signature",
          "SIWC id token signature mismatch.",
        );
      }

      const payload = toIdTokenPayload(payloadRecord);
      const expectedIssuer = input.issuer ?? SIWC_ISSUER;
      if (payload.iss !== expectedIssuer) {
        throw new SiwcIdTokenVerificationError(
          "issuer_mismatch",
          `SIWC id token issuer mismatch (expected ${expectedIssuer}).`,
        );
      }
      const audienceList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audienceList.includes(input.audience)) {
        throw new SiwcIdTokenVerificationError(
          "audience_mismatch",
          "SIWC id token audience does not match the issued client id.",
        );
      }
      const skewSeconds = input.clockSkewSeconds ?? 0;
      if (payload.exp + skewSeconds <= Math.floor(now() / 1000)) {
        throw new SiwcIdTokenVerificationError("token_expired", "SIWC id token has expired.");
      }
      if (input.nonce && payload.nonce !== input.nonce) {
        throw new SiwcIdTokenVerificationError(
          "nonce_mismatch",
          "SIWC id token nonce does not match this authorization attempt.",
        );
      }
      return payload;
    },
  };
}

async function resolveJwksUri(fetchFn: typeof globalThis.fetch): Promise<string> {
  const response = await fetchFn(SIWC_OPENID_CONFIGURATION_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new SiwcIdTokenVerificationError(
      "unknown_key",
      `Unable to load SIWC OIDC discovery (HTTP ${response.status}).`,
    );
  }
  const parsed = (await response.json()) as { jwks_uri?: unknown };
  if (typeof parsed.jwks_uri !== "string" || !parsed.jwks_uri.trim()) {
    throw new SiwcIdTokenVerificationError(
      "unknown_key",
      "SIWC OIDC discovery did not provide a jwks_uri.",
    );
  }
  return parsed.jwks_uri.trim();
}

function parseJsonSegment(segment: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new SiwcIdTokenVerificationError(
      "malformed_token",
      `SIWC id token segment is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toIdTokenPayload(record: Record<string, unknown>): SiwcIdTokenPayload {
  const sub = record.sub;
  const iss = record.iss;
  const aud = record.aud;
  const exp = record.exp;
  if (typeof sub !== "string" || !sub.trim()) {
    throw new SiwcIdTokenVerificationError("malformed_token", "SIWC id token has no sub claim.");
  }
  if (typeof iss !== "string") {
    throw new SiwcIdTokenVerificationError("malformed_token", "SIWC id token has no iss claim.");
  }
  if (typeof aud !== "string" && !(Array.isArray(aud) && aud.every((v) => typeof v === "string"))) {
    throw new SiwcIdTokenVerificationError("malformed_token", "SIWC id token has no aud claim.");
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new SiwcIdTokenVerificationError("malformed_token", "SIWC id token has no exp claim.");
  }
  return {
    sub,
    iss,
    aud: aud as SiwcIdTokenPayload["aud"],
    exp,
    ...(typeof record.iat === "number" ? { iat: record.iat } : {}),
    ...(typeof record.nonce === "string" ? { nonce: record.nonce } : {}),
    ...(typeof record.email === "string" ? { email: record.email } : {}),
    ...(typeof record.email_verified === "boolean" ? { emailVerified: record.email_verified } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.picture === "string" ? { picture: record.picture } : {}),
  };
}
