import {
  createHash,
  createPublicKey,
  createPrivateKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  ENROLLMENT_POW_MAX_DIFFICULTY,
  ENROLLMENT_POW_MIN_DIFFICULTY,
} from "@zcode/shared/web-remote-relay";
import { createEnrollmentGate } from "./enrollmentGate.js";
import type {
  RelayDeviceKeyExchange,
  RelayDeviceKeyResult,
  RelayDeviceKeyStore,
  RelayJwtClaims,
  RelayKeyTier,
  RelaySession,
  RelaySessionService,
} from "../contract.js";

/** Relay JWTs are issued and verified only by this process; the identity provider never signs them. */
export const RELAY_JWT_ISSUER = "zcode-remote-relay";
export const RELAY_JWT_AUDIENCE = "zcode-remote-relay";
const CLOCK_SKEW_SECONDS = 30;
const MAX_TTL_SECONDS = 86_400;
const MAX_SUBJECT_LENGTH = 256;
/** Reserved for device-key identities; zai-jwt mode refuses it so the namespaces never overlap. */
export const DEVICE_KEY_SUBJECT_PREFIX = "dk:";
const DEVICE_KEY_SIGNING_DOMAIN = "zcode-relay-device-session-v1\nzcode-remote-relay";
const DEVICE_KEY_WINDOW_SECONDS = 60;
const REPLAY_RETENTION_MS = 120_000;
const DEFAULT_MAX_REPLAY_ENTRIES = 100_000;
const DEFAULT_POW_DIFFICULTY = 22;
const DEFAULT_MAX_ENROLLED_KEYS = 10_000;
const DEFAULT_ENROLLMENTS_PER_HOUR = 300;
const PAIRING_TTL_SECONDS = 300;
const MAX_PAIRINGS_PER_USER = 8;
const MAX_PAIRINGS_TOTAL = 10_000;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type Jwk = Record<string, unknown>;

export interface IdentityVerifierConfig {
  issuer: string;
  audience?: string;
  userClaim: string;
  /** Public JWKs only. A token whose kid is absent from this set is rejected. */
  keys: readonly Jwk[];
}

export interface DeviceKeyIdentityConfig {
  mode: "device-key";
  /** Owner enrollment. Required unless `enrollment.mode` is `open`, where it is optional. */
  enrollmentSecret?: string;
  keys: RelayDeviceKeyStore;
  enrollment?: {
    mode: "secret" | "open";
    /** Leading zero bits of the open-enrollment proof of work. */
    difficulty?: number;
    /** Open-tier key cap; reaching it stops new open enrollments (breaker). */
    maxEnrolledKeys?: number;
    /** Open enrollments per rolling hour before the breaker opens. */
    enrollmentsPerHour?: number;
  };
}

export interface RelaySessionConfig {
  /** Private Ed25519 JWKs. The first entry signs; every entry verifies. */
  signingKeys: readonly Jwk[];
  ttlSeconds: number;
  identity: (IdentityVerifierConfig & { mode?: "zai-jwt" }) | DeviceKeyIdentityConfig;
  now: () => number;
  /** Device-key mode replay cache capacity; full means fail closed. */
  maxReplayEntries?: number;
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
  if (subject.startsWith(DEVICE_KEY_SUBJECT_PREFIX)) return undefined;
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
  const deviceIdentity = config.identity.mode === "device-key" ? config.identity : undefined;
  const zaiIdentity = config.identity.mode === "device-key" ? undefined : config.identity;
  const identityKeys = zaiIdentity ? zaiIdentity.keys.map(publicKeyFromJwk) : [];
  if (zaiIdentity && identityKeys.length === 0) throw new Error("Identity key set is empty.");
  const identity = zaiIdentity ? { ...zaiIdentity, keyObjects: identityKeys } : undefined;
  const mode = deviceIdentity ? "device-key" : "zai-jwt";
  const openEnrollment = deviceIdentity?.enrollment?.mode === "open";
  if (deviceIdentity && !deviceIdentity.enrollmentSecret && !openEnrollment)
    throw new Error("Enrollment secret is missing.");
  const secretDigest = deviceIdentity?.enrollmentSecret
    ? createHash("sha256").update(deviceIdentity.enrollmentSecret).digest()
    : undefined;
  const difficulty = deviceIdentity?.enrollment?.difficulty ?? DEFAULT_POW_DIFFICULTY;
  if (
    !Number.isInteger(difficulty) ||
    difficulty < ENROLLMENT_POW_MIN_DIFFICULTY ||
    difficulty > ENROLLMENT_POW_MAX_DIFFICULTY
  ) {
    throw new Error("Enrollment difficulty is out of range.");
  }
  const maxEnrolledKeys = deviceIdentity?.enrollment?.maxEnrolledKeys ?? DEFAULT_MAX_ENROLLED_KEYS;
  const enrollmentsPerHour =
    deviceIdentity?.enrollment?.enrollmentsPerHour ?? DEFAULT_ENROLLMENTS_PER_HOUR;
  const gate = createEnrollmentGate({
    difficulty,
    maxEnrolledKeys,
    enrollmentsPerHour,
  });
  const maxReplayEntries = config.maxReplayEntries ?? DEFAULT_MAX_REPLAY_ENTRIES;
  // Entries share one retention window, so insertion order is expiry order and pruning pops from the front.
  const seenNonces = new Map<string, number>();
  const pairings = new Map<string, { userId: string; expiresAt: number; tier: RelayKeyTier }>();
  const active = signing[0];
  const activeSigner = active?.signer;
  if (!active || !activeSigner) throw new Error("Relay signing keys are missing.");

  const issue = (
    userId: string,
    options: { viaPairing?: boolean; tier?: RelayKeyTier } = {},
  ): RelaySession => {
    const issuedAt = Math.floor(config.now() / 1000);
    const header = { alg: "EdDSA", typ: "JWT", kid: active.kid };
    const claims = {
      iss: RELAY_JWT_ISSUER,
      aud: RELAY_JWT_AUDIENCE,
      sub: userId,
      iat: issuedAt,
      exp: issuedAt + config.ttlSeconds,
      // Marks sessions obtained from a pairing code; /pairing refuses them so they cannot renew themselves.
      ...(options.viaPairing ? { amr: ["pairing"] } : {}),
      ...(options.tier === undefined ? {} : { tier: options.tier }),
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
      JSON.stringify(claims),
    ).toString("base64url")}`;
    const signature = sign(null, Buffer.from(signingInput), activeSigner).toString("base64url");
    return {
      jwt: `${signingInput}.${signature}`,
      expiresIn: config.ttlSeconds,
    };
  };

  const secretMatches = (presented: string | undefined): boolean => {
    if (!secretDigest) return false;
    // Hash both sides first: timingSafeEqual needs equal lengths, and a length check would leak the length.
    const presentedDigest = createHash("sha256")
      .update(presented ?? "")
      .digest();
    return timingSafeEqual(presentedDigest, secretDigest);
  };

  const pruneSeen = (nowMs: number) => {
    for (const [key, expiresAt] of seenNonces) {
      if (expiresAt > nowMs) break;
      seenNonces.delete(key);
    }
  };
  const prunePairings = (nowMs: number) => {
    for (const [key, entry] of pairings) {
      if (entry.expiresAt > nowMs) break;
      pairings.delete(key);
    }
  };

  return {
    mode,
    exchange(identityToken) {
      if (!identity) return undefined;
      const userId = verifyIdentityToken(identityToken, identity, Math.floor(config.now() / 1000));
      return userId === undefined ? undefined : issue(userId);
    },
    async exchangeDeviceKey(request: RelayDeviceKeyExchange): Promise<RelayDeviceKeyResult> {
      if (!deviceIdentity) return { status: "denied" };
      const nowMs = config.now();
      if (
        !PUBLIC_KEY_PATTERN.test(request.publicKey) ||
        !NONCE_PATTERN.test(request.nonce) ||
        !SIGNATURE_PATTERN.test(request.signature) ||
        !Number.isSafeInteger(request.ts) ||
        Math.abs(Math.floor(nowMs / 1000) - request.ts) > DEVICE_KEY_WINDOW_SECONDS
      ) {
        return { status: "denied" };
      }
      let valid = false;
      try {
        const publicKey = createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: request.publicKey },
          format: "jwk",
        });
        const signed = `${DEVICE_KEY_SIGNING_DOMAIN}\n${request.publicKey}\n${request.ts}\n${request.nonce}`;
        valid = verify(
          null,
          Buffer.from(signed),
          publicKey,
          Buffer.from(request.signature, "base64url"),
        );
      } catch {
        valid = false;
      }
      if (!valid) return { status: "denied" };
      // Stateless proof of work runs before any store call, so anonymous floods never queue store IO.
      if (request.work !== undefined) {
        if (
          !openEnrollment ||
          !gate.workIsValid(request.publicKey, request.work, Math.floor(nowMs / 1000))
        ) {
          return { status: "denied" };
        }
      }
      let lookup;
      try {
        lookup = await deviceIdentity.keys.lookup(request.publicKey);
      } catch {
        return { status: "busy" };
      }
      let enrollAs: RelayKeyTier | undefined;
      const tier = lookup.tier;
      if (tier === undefined) {
        if (request.enrollmentSecret !== undefined) {
          if (!secretMatches(request.enrollmentSecret)) return { status: "denied" };
          enrollAs = "owner";
        } else if (request.work !== undefined) {
          if (gate.breakerOpen(nowMs, lookup.openKeys)) return { status: "closed" };
          enrollAs = "open";
        } else if (openEnrollment) {
          if (gate.breakerOpen(nowMs, lookup.openKeys)) return { status: "closed" };
          return {
            status: "not-enrolled",
            challenge: gate.issueChallenge(request.publicKey, Math.floor(nowMs / 1000)),
          };
        } else {
          return { status: "not-enrolled" };
        }
      }
      // Reserve the nonce synchronously after the awaits so concurrent replays cannot both pass.
      pruneSeen(nowMs);
      const replayKey = `${request.publicKey}.${request.nonce}`;
      if (seenNonces.has(replayKey)) return { status: "denied" };
      if (seenNonces.size >= maxReplayEntries) return { status: "busy" };
      seenNonces.set(replayKey, nowMs + REPLAY_RETENTION_MS);
      if (enrollAs !== undefined) {
        try {
          await deviceIdentity.keys.enroll(request.publicKey, Math.floor(nowMs / 1000), enrollAs);
        } catch {
          return { status: "busy" };
        }
        if (enrollAs === "open") gate.recordEnrollment(nowMs);
      } else {
        // Best effort: last-seen only drives idle expiry, so a failed write must not fail a login.
        void deviceIdentity.keys
          .touch(request.publicKey, Math.floor(nowMs / 1000))
          .catch(() => undefined);
      }
      const digest = createHash("sha256")
        .update(Buffer.from(request.publicKey, "base64url"))
        .digest("base64url");
      return {
        status: "ok",
        session: issue(`${DEVICE_KEY_SUBJECT_PREFIX}${digest}`, {
          tier: enrollAs ?? tier ?? "open",
        }),
      };
    },
    exchangePairing(code) {
      if (!deviceIdentity || !PAIRING_CODE_PATTERN.test(code)) return undefined;
      const nowMs = config.now();
      prunePairings(nowMs);
      const key = createHash("sha256").update(code).digest("base64url");
      const entry = pairings.get(key);
      if (!entry) return undefined;
      pairings.delete(key);
      return entry.expiresAt > nowMs
        ? issue(entry.userId, { viaPairing: true, tier: entry.tier })
        : undefined;
    },
    createPairing(userId, tier) {
      if (!deviceIdentity) return undefined;
      const nowMs = config.now();
      prunePairings(nowMs);
      let owned = 0;
      for (const entry of pairings.values()) if (entry.userId === userId) owned += 1;
      if (owned >= MAX_PAIRINGS_PER_USER || pairings.size >= MAX_PAIRINGS_TOTAL) return undefined;
      const code = randomBytes(16).toString("base64url");
      pairings.set(createHash("sha256").update(code).digest("base64url"), {
        userId,
        tier,
        expiresAt: nowMs + PAIRING_TTL_SECONDS * 1000,
      });
      return { code, expiresIn: PAIRING_TTL_SECONDS };
    },
    claims(jwt) {
      return verifyClaims(jwt);
    },
    verify(jwt) {
      return verifyClaims(jwt)?.userId;
    },
  };

  function verifyClaims(jwt: string): RelayJwtClaims | undefined {
    {
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
      // The two modes use disjoint subject namespaces, so a JWT minted under one mode never verifies under the other.
      if (payload.sub.startsWith(DEVICE_KEY_SUBJECT_PREFIX) !== (mode === "device-key"))
        return undefined;
      return {
        userId: payload.sub,
        expiresAt: payload.exp,
        viaPairing: Array.isArray(payload.amr) && payload.amr.includes("pairing"),
        // Legacy device-key JWTs have no claim and get the smaller quota until they are renewed.
        ...(mode === "device-key" ? { tier: payload.tier === "owner" ? "owner" : "open" } : {}),
      } as RelayJwtClaims;
    }
  }
}
