/**
 * Open-enrollment proof of work (`specs/relay-v2-migration.md` section 15.6): wire layout shared by the
 * relay (verifier) and the Desktop (solver). This module never hashes; each side supplies sha256, so the
 * web bundle can import the package without `node:crypto`.
 */
export const ENROLLMENT_POW_DOMAIN = "zcode-relay-pow-v1";
export const ENROLLMENT_POW_CHALLENGE_BYTES = 25;
export const ENROLLMENT_POW_MAC_BYTES = 16;
export const ENROLLMENT_POW_WINDOW_SECONDS = 60;
export const ENROLLMENT_POW_MIN_DIFFICULTY = 8;
export const ENROLLMENT_POW_MAX_DIFFICULTY = 32;
/** Envelope code of the 401 that carries a challenge: the key is not enrolled and may enroll by work. */
export const ENROLLMENT_NOT_ENROLLED_CODE = 4012;
/** Envelope code of the 503 returned while the relay accepts no new open enrollments. */
export const ENROLLMENT_CLOSED_CODE = 4503;

export interface EnrollmentPowChallenge {
  issuedAt: number;
  difficulty: number;
  mac: Uint8Array;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** The bytes the relay authenticates with its per-process key: it binds the challenge to one public key. */
export function enrollmentPowMacInput(
  publicKey: string,
  issuedAt: number,
  difficulty: number,
): string {
  return `${ENROLLMENT_POW_DOMAIN}\n${publicKey}\n${issuedAt}\n${difficulty}`;
}

export function encodeEnrollmentPowChallenge(challenge: EnrollmentPowChallenge): string {
  const bytes = new Uint8Array(ENROLLMENT_POW_CHALLENGE_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(challenge.issuedAt));
  bytes[8] = challenge.difficulty;
  bytes.set(challenge.mac.subarray(0, ENROLLMENT_POW_MAC_BYTES), 9);
  return toBase64Url(bytes);
}

export function parseEnrollmentPowChallenge(value: string): EnrollmentPowChallenge | undefined {
  const bytes = fromBase64Url(value);
  if (!bytes || bytes.length !== ENROLLMENT_POW_CHALLENGE_BYTES) return undefined;
  // Reject non-canonical encodings (spare bits in the last character) so one challenge has one spelling.
  if (toBase64Url(bytes) !== value) return undefined;
  const issuedAt = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0));
  const difficulty = bytes[8]!;
  if (!Number.isSafeInteger(issuedAt)) return undefined;
  return { issuedAt, difficulty, mac: bytes.slice(9) };
}

/** The string both sides hash. `nonce` is the client counter in decimal. */
export function enrollmentPowHashInput(
  publicKey: string,
  challenge: string,
  nonce: string,
): string {
  return `${ENROLLMENT_POW_DOMAIN}\n${publicKey}\n${challenge}\n${nonce}`;
}

export function hasLeadingZeroBits(hash: Uint8Array, bits: number): boolean {
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) if (hash[index] !== 0) return false;
  const rest = bits % 8;
  return rest === 0 || hash[whole]! >> (8 - rest) === 0;
}

export const ENROLLMENT_POW_NONCE_PATTERN = /^[0-9]{1,16}$/;
