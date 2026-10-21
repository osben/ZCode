import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebRemoteControlRelayBearer } from "#src/main/web-remote-relay/webRemoteControlRelaySession.js";

/**
 * Fork device-key identity for self-hosted relays that run in `device-key` mode
 * (`specs/relay-v2-migration.md` section 15). The private key lives only in the credential store under
 * a `fork_` key, never in `setting.json`.
 */
export const WEB_REMOTE_CONTROL_DEVICE_KEY_CREDENTIAL = "fork_web-remote-control:device-key";
/** Placeholder login JWT: device-key mode has no account JWT, and the bearer ignores this value. */
export const WEB_REMOTE_CONTROL_DEVICE_KEY_PLACEHOLDER_JWT = "device-key";

const SIGNING_DOMAIN = "zcode-relay-device-session-v1\nzcode-remote-relay";
const REFRESH_MARGIN_MS = 30_000;

export interface DeviceKeyCredentialStore {
  load(key: string): Promise<string | null | undefined>;
  save(key: string, value: string): Promise<void>;
}

export interface WebRemoteControlDeviceKeyProof {
  publicKey: string;
  ts: number;
  nonce: string;
  signature: string;
}

export interface WebRemoteControlDeviceKeyIdentity {
  /** Stable relay user id: `dk:` + base64url(sha256(raw public key)). */
  userId(): Promise<string>;
  /** Fresh signed challenge for `POST /session`. */
  proveExchange(): Promise<WebRemoteControlDeviceKeyProof>;
}

interface LoadedKey {
  privateKey: KeyObject;
  publicKey: string;
}

function keyFromStored(raw: string): LoadedKey {
  const parsed = JSON.parse(raw) as { v?: unknown; jwk?: Record<string, unknown> };
  if (parsed.v !== 1 || !parsed.jwk || parsed.jwk.crv !== "Ed25519") {
    throw new Error("Stored device key is not usable.");
  }
  const privateKey = createPrivateKey({ key: parsed.jwk as never, format: "jwk" });
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (typeof publicKey !== "string") throw new Error("Stored device key is not usable.");
  return { privateKey, publicKey };
}

export function createWebRemoteControlDeviceKeyIdentity(options: {
  credentials: DeviceKeyCredentialStore;
  now?: () => number;
  randomNonce?: () => string;
}): WebRemoteControlDeviceKeyIdentity {
  const now = options.now ?? Date.now;
  const randomNonce = options.randomNonce ?? (() => randomBytes(16).toString("base64url"));
  // Single flight: concurrent first uses across windows must produce one key, not several identities.
  let loading: Promise<LoadedKey> | undefined;

  async function loadOrCreate(): Promise<LoadedKey> {
    const stored = await options.credentials.load(WEB_REMOTE_CONTROL_DEVICE_KEY_CREDENTIAL);
    // A present but unreadable value is surfaced, never replaced: replacing would silently change the identity.
    if (stored) return keyFromStored(stored);
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    await options.credentials.save(
      WEB_REMOTE_CONTROL_DEVICE_KEY_CREDENTIAL,
      JSON.stringify({ v: 1, jwk }),
    );
    return { privateKey, publicKey: jwk.x as string };
  }

  const key = () => {
    loading ??= loadOrCreate().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };

  return {
    async userId() {
      const { publicKey } = await key();
      const digest = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();
      return `dk:${digest.toString("base64url")}`;
    },
    async proveExchange() {
      const { privateKey, publicKey } = await key();
      const ts = Math.floor(now() / 1000);
      const nonce = randomNonce();
      const signed = `${SIGNING_DOMAIN}\n${publicKey}\n${ts}\n${nonce}`;
      return {
        publicKey,
        ts,
        nonce,
        signature: sign(null, Buffer.from(signed), privateKey).toString("base64url"),
      };
    },
  };
}

export interface WebRemoteControlDeviceKeyBearer extends WebRemoteControlRelayBearer {
  /** Mints a single-use pairing code for the phone QR, or undefined when the relay refuses. */
  issuePairingCode(input: {
    relayOrigin: string;
    signal: AbortSignal;
  }): Promise<string | undefined>;
}

interface CachedJwt {
  relayOrigin: string;
  jwt: string;
  expiresAt: number;
}

/**
 * Relay bearer for `device-key` mode. It signs a fresh challenge per exchange. The enrollment secret
 * is sent only after the relay answers 4012 (key not enrolled), so it is not on every exchange.
 */
export function createWebRemoteControlDeviceKeyBearer(options: {
  identity: WebRemoteControlDeviceKeyIdentity;
  loadEnrollmentSecret(): Promise<string | undefined>;
  fetcher?: typeof fetch;
  now?: () => number;
}): WebRemoteControlDeviceKeyBearer {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cached: CachedJwt | undefined;
  let inFlight: { relayOrigin: string; promise: Promise<CachedJwt> } | undefined;

  async function post(
    relayOrigin: string,
    secret: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const proof = await options.identity.proveExchange();
    return fetcher(new URL("/api/v1/remote/session", relayOrigin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_key: {
          public_key: proof.publicKey,
          ts: proof.ts,
          nonce: proof.nonce,
          signature: proof.signature,
        },
        ...(secret === undefined ? {} : { enrollment_secret: secret }),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
  }

  async function exchange(relayOrigin: string, signal: AbortSignal): Promise<CachedJwt> {
    let response = await post(relayOrigin, undefined, signal);
    if (response.status === 401) {
      const body = (await response.json().catch(() => undefined)) as { code?: unknown } | undefined;
      if (body?.code === 4012) {
        const secret = await options.loadEnrollmentSecret();
        if (!secret) throw new WebRemoteControlV2ConnectionError("auth-required");
        response = await post(relayOrigin, secret, signal);
      } else {
        throw new WebRemoteControlV2ConnectionError("auth-required");
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new WebRemoteControlV2ConnectionError("auth-required");
    }
    if (!response.ok) {
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
    }
    const envelope = (await response.json().catch(() => undefined)) as
      | { code?: unknown; data?: { jwt?: unknown; expires_in?: unknown } }
      | undefined;
    const data = envelope?.data;
    if (
      envelope?.code !== 0 ||
      typeof data?.jwt !== "string" ||
      data.jwt.length === 0 ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw new WebRemoteControlV2ConnectionError("relay-unavailable");
    }
    return { relayOrigin, jwt: data.jwt, expiresAt: now() + data.expires_in * 1000 };
  }

  async function getJwt(input: { relayOrigin: string; signal: AbortSignal }): Promise<string> {
    if (
      cached &&
      cached.relayOrigin === input.relayOrigin &&
      cached.expiresAt - REFRESH_MARGIN_MS > now()
    ) {
      return cached.jwt;
    }
    if (!inFlight || inFlight.relayOrigin !== input.relayOrigin) {
      const promise = exchange(input.relayOrigin, input.signal);
      const entry = { relayOrigin: input.relayOrigin, promise };
      inFlight = entry;
      void promise
        .finally(() => {
          if (inFlight === entry) inFlight = undefined;
        })
        .catch(() => undefined);
    }
    const next = await inFlight.promise;
    cached = next;
    return next.jwt;
  }

  return {
    getJwt,
    invalidate() {
      cached = undefined;
    },
    async issuePairingCode({ relayOrigin, signal }) {
      try {
        const jwt = await getJwt({ relayOrigin, signal });
        const response = await fetcher(new URL("/api/v1/remote/pairing", relayOrigin), {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          redirect: "error",
        });
        if (!response.ok) return undefined;
        const body = (await response.json().catch(() => undefined)) as
          | { code?: unknown; data?: { code?: unknown } }
          | undefined;
        return body?.code === 0 && typeof body.data?.code === "string" ? body.data.code : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
