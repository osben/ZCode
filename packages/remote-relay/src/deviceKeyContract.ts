export interface RelaySession {
  jwt: string;
  expiresIn: number;
}

/** `owner`: enrolled with the shared secret (and every key enrolled before open enrollment). `open`: enrolled by PoW. */
export type RelayKeyTier = "owner" | "open";

export interface RelayKeyLookup {
  /** Undefined when the key is not enrolled. */
  tier?: RelayKeyTier;
  /** Enrolled `open` keys, so the session service can refuse a challenge when the cap is reached. */
  openKeys: number;
}

/** Enrolled device public keys (device-key identity mode). Separate from device records. */
export interface RelayDeviceKeyStore {
  lookup(publicKey: string): Promise<RelayKeyLookup>;
  /** Idempotent. Rejects when the capacity for the tier is exhausted. Writes the key and its usage row atomically. */
  enroll(publicKey: string, createdAt: number, tier: RelayKeyTier): Promise<void>;
  /** Records the last successful exchange; no-op for keys without a usage row. */
  touch(publicKey: string, seenAt: number): Promise<void>;
}

export interface RelayEnrollmentWork {
  challenge: string;
  nonce: string;
}

export interface RelayDeviceKeyExchange {
  publicKey: string;
  ts: number;
  nonce: string;
  signature: string;
  enrollmentSecret?: string;
  work?: RelayEnrollmentWork;
}

/** `denied` is deliberately uniform (bad signature, stale, replay, wrong secret, bad work). */
export type RelayDeviceKeyResult =
  | { status: "ok"; session: RelaySession }
  | {
      status: "not-enrolled";
      /** Present only when open enrollment is available for this key right now. */
      challenge?: { challenge: string; difficulty: number; expiresIn: number };
    }
  | { status: "denied" | "busy" | "closed" };

export interface RelayJwtClaims {
  userId: string;
  /** Present only in device-key mode. A JWT without the claim is treated as `open`. */
  tier?: RelayKeyTier;
  /** Unix seconds. */
  expiresAt: number;
  viaPairing: boolean;
}

/** Device-key identity mode operations of the session service (`specs/relay-v2-migration.md` section 15). */
export interface RelayDeviceKeySessionOperations {
  /** Device-key mode only: proof of possession, enrollment, replay protection. */
  exchangeDeviceKey(request: RelayDeviceKeyExchange): Promise<RelayDeviceKeyResult>;
  /** Device-key mode only: consumes a single-use pairing code and mints a JWT for its owner. */
  exchangePairing(code: string): RelaySession | undefined;
  /**
   * Device-key mode only: mints a pairing code for the user, or undefined at the per-user cap. The pairing
   * JWT it later yields carries `tier`.
   */
  createPairing(
    userId: string,
    tier: RelayKeyTier,
  ): { code: string; expiresIn: number } | undefined;
}
