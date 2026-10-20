import { createPublicKey, createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import type { RelaySession, RelaySessionService } from "../contract.js";

/** Relay JWTs are issued and verified only by this process; the identity provider never signs them. */
export const RELAY_JWT_ISSUER = "zcode-remote-relay";
export const RELAY_JWT_AUDIENCE = "zcode-remote-relay";
const CLOCK_SKEW_SECONDS = 30;
const MAX_TTL_SECONDS = 86_400;
const MAX_SUBJECT_LENGTH = 256;

type Jwk = Record<string, unknown>;

export interface IdentityVerifierConfig {
  issuer: string;
  audience?: string;
  userClaim: string;
  /** Public JWKs only. A token whose kid is absent from this set is rejected. */
  keys: readonly Jwk[];
}

export interface RelaySessionConfig {
  /** Private Ed25519 JWKs. The first entry signs; every entry verifies. */
  signingKeys: readonly Jwk[];
  ttlSeconds: number;
  identity: IdentityVerifierConfig;
  now: () => number;
}

interface VerifiedKey {
  kid: string;
  key: KeyObject;
  keyType: string;
  curve?: string;
  /** Present only for relay signing keys; identity keys are public-only. */
  signer?: KeyObject;
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function jwkKid(jwk: Jwk, index: number): string {
  const kid = typeof jwk.kid === "string" && jwk.kid.length > 0 ? jwk.kid : undefined;
  return kid ?? `index-${index}`;
}

/** Parses a JWK set entry into a KeyObject, refusing private material where only public is allowed. */
function publicKeyFromJwk(jwk: Jwk, index: number): VerifiedKey {
  if ("d" in jwk) throw new Error(`Identity key ${index} must be public.`);
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  return {
    kid: jwkKid(jwk, index),
    key,
    keyType: key.asymmetricKeyType ?? "",
    curve: key.asymmetricKeyDetails?.namedCurve,
  };
}

function signingKeyFromJwk(jwk: Jwk, index: number): VerifiedKey {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new Error(`Relay signing key ${index} must be an Ed25519 OKP key.`);
  }
  const privateKey = createPrivateKey({ key: jwk as never, format: "jwk" });
  return {
    kid: jwkKid(jwk, index),
    key: createPublicKey(privateKey),
    keyType: "ed25519",
    signer: privateKey,
  };
}

/** Verifies JWS compact signatures for the algorithms this relay accepts. `none` and HMAC never reach here. */
function verifySignature(
  alg: string,
  signingInput: Buffer,
  signature: Buffer,
  key: VerifiedKey,
): boolean {
  if (alg === "EdDSA") {
    return key.keyType === "ed25519" && verify(null, signingInput, key.key, signature);
  }
  if (alg === "ES256") {
    return (
      key.keyType === "ec" &&
      key.curve === "prime256v1" &&
      verify("sha256", signingInput, { key: key.key, dsaEncoding: "ieee-p1363" }, signature)
    );
  }
  if (alg === "RS256") {
    return key.keyType === "rsa" && verify("sha256", signingInput, key.key, signature);
  }
  return false;
}

function splitCompact(token: string): [string, string, string] | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return undefined;
  return parts as [string, string, string];
}

function selectKey(keys: readonly VerifiedKey[], kid: unknown): VerifiedKey | undefined {
  if (typeof kid === "string") return keys.find((key) => key.kid === kid);
  return keys.length === 1 ? keys[0] : undefined;
}

/** Verifies an account login JWT once at exchange time. Runtime never calls the identity provider. */
function verifyIdentityToken(
  token: string,
  config: IdentityVerifierConfig & { keyObjects: readonly VerifiedKey[] },
  nowSeconds: number,
): string | undefined {
  const parts = splitCompact(token);
  if (!parts) return undefined;
  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (!header || !payload || typeof header.alg !== "string") return undefined;
  const key = selectKey(config.keyObjects, header.kid);
  if (!key) return undefined;
  const signature = Buffer.from(parts[2], "base64url");
  if (!verifySignature(header.alg, Buffer.from(`${parts[0]}.${parts[1]}`), signature, key)) {
    return undefined;
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    return undefined;
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
    return undefined;
  }
  if (payload.iss !== config.issuer) return undefined;
  if (config.audience !== undefined) {
    const audience = payload.aud;
    const matches = Array.isArray(audience)
      ? audience.includes(config.audience)
      : audience === config.audience;
    if (!matches) return undefined;
  }
  const subject = payload[config.userClaim];
  if (typeof subject !== "string" || subject.trim().length === 0) return undefined;
  if (subject.length > MAX_SUBJECT_LENGTH) return undefined;
  return subject;
}

/** Creates the session service from validated config. Throws on malformed key material (fail closed). */
export function createRelaySessionService(config: RelaySessionConfig): RelaySessionService {
  if (
    !Number.isSafeInteger(config.ttlSeconds) ||
    config.ttlSeconds < 1 ||
    config.ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new Error("Relay JWT TTL is out of range.");
  }
  if (config.signingKeys.length === 0) throw new Error("Relay signing keys are missing.");
  const signing = config.signingKeys.map(signingKeyFromJwk);
  const kidSet = new Set(signing.map((key) => key.kid));
  if (kidSet.size !== signing.length) throw new Error("Relay signing key ids must be unique.");
  const identityKeys = config.identity.keys.map(publicKeyFromJwk);
  if (identityKeys.length === 0) throw new Error("Identity key set is empty.");
  const identity = { ...config.identity, keyObjects: identityKeys };
  const active = signing[0];
  const activeSigner = active?.signer;
  if (!active || !activeSigner) throw new Error("Relay signing keys are missing.");

  const issue = (userId: string): RelaySession => {
    const issuedAt = Math.floor(config.now() / 1000);
    const header = { alg: "EdDSA", typ: "JWT", kid: active.kid };
    const claims = {
      iss: RELAY_JWT_ISSUER,
      aud: RELAY_JWT_AUDIENCE,
      sub: userId,
      iat: issuedAt,
      exp: issuedAt + config.ttlSeconds,
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
      JSON.stringify(claims),
    ).toString("base64url")}`;
    const signature = sign(null, Buffer.from(signingInput), activeSigner).toString("base64url");
    return { jwt: `${signingInput}.${signature}`, expiresIn: config.ttlSeconds };
  };

  return {
    exchange(identityToken) {
      const userId = verifyIdentityToken(identityToken, identity, Math.floor(config.now() / 1000));
      return userId === undefined ? undefined : issue(userId);
    },
    verify(jwt) {
      const parts = splitCompact(jwt);
      if (!parts) return undefined;
      const header = decodeSegment(parts[0]);
      const payload = decodeSegment(parts[1]);
      if (!header || !payload || header.alg !== "EdDSA") return undefined;
      const key = signing.find((candidate) => candidate.kid === header.kid);
      if (!key) return undefined;
      const signature = Buffer.from(parts[2], "base64url");
      if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key.key, signature))
        return undefined;
      const now = Math.floor(config.now() / 1000);
      if (payload.iss !== RELAY_JWT_ISSUER || payload.aud !== RELAY_JWT_AUDIENCE) return undefined;
      if (typeof payload.exp !== "number" || payload.exp <= now) return undefined;
      if (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS)
        return undefined;
      if (typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
      return payload.sub;
    },
  };
}
