export interface RelaySession {
  jwt: string;
  expiresIn: number;
}

/** Enrolled device public keys (device-key identity mode). Separate from device records. */
export interface RelayDeviceKeyStore {
  isEnrolled(publicKey: string): Promise<boolean>;
  /** Idempotent. Rejects when the enrolled-key capacity is exhausted. */
  enroll(publicKey: string, createdAt: number): Promise<void>;
}

export interface RelayDeviceKeyExchange {
  publicKey: string;
  ts: number;
  nonce: string;
  signature: string;
  enrollmentSecret?: string;
}

/** `denied` is deliberately uniform (bad signature, stale, replay, wrong secret). */
export type RelayDeviceKeyResult =
  | { status: "ok"; session: RelaySession }
  | { status: "denied" | "not-enrolled" | "busy" };

/** Device-key identity mode operations of the session service (`specs/relay-v2-migration.md` section 15). */
export interface RelayDeviceKeySessionOperations {
  /** Device-key mode only: proof of possession, enrollment, replay protection. */
  exchangeDeviceKey(request: RelayDeviceKeyExchange): Promise<RelayDeviceKeyResult>;
  /** Device-key mode only: consumes a single-use pairing code and mints a JWT for its owner. */
  exchangePairing(code: string): RelaySession | undefined;
  /** Device-key mode only: mints a pairing code for the user, or undefined at the per-user cap. */
  createPairing(userId: string): { code: string; expiresIn: number } | undefined;
}
