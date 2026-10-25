import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ENROLLMENT_POW_MAC_BYTES,
  ENROLLMENT_POW_NONCE_PATTERN,
  ENROLLMENT_POW_WINDOW_SECONDS,
  encodeEnrollmentPowChallenge,
  enrollmentPowHashInput,
  enrollmentPowMacInput,
  hasLeadingZeroBits,
  parseEnrollmentPowChallenge,
} from "@zcode/shared/web-remote-relay";

const CLOCK_SKEW_SECONDS = 30;
const HOUR_MS = 3_600_000;

/**
 * Open-enrollment gate (`specs/relay-v2-migration.md` section 15.6): stateless proof of work bound to a
 * public key by a per-process HMAC, and the global breaker that stops new open enrollments.
 */
export function createEnrollmentGate(options: {
  difficulty: number;
  maxEnrolledKeys: number;
  enrollmentsPerHour: number;
}) {
  const { difficulty, maxEnrolledKeys, enrollmentsPerHour } = options;
  // Per-process key: a restart invalidates outstanding challenges, and no env secret is needed.
  const powKey = randomBytes(32);
  const openEnrollments: number[] = [];
  const macFor = (publicKey: string, issuedAt: number, bits: number) =>
    createHmac("sha256", powKey)
      .update(enrollmentPowMacInput(publicKey, issuedAt, bits))
      .digest()
      .subarray(0, ENROLLMENT_POW_MAC_BYTES);

  const issueChallenge = (publicKey: string, nowSeconds: number) => ({
    challenge: encodeEnrollmentPowChallenge({
      issuedAt: nowSeconds,
      difficulty,
      mac: macFor(publicKey, nowSeconds, difficulty),
    }),
    difficulty,
    expiresIn: ENROLLMENT_POW_WINDOW_SECONDS,
  });

  /** Stateless: MAC binds the challenge to the key and this process, then age and leading zero bits. */
  const workIsValid = (
    publicKey: string,
    work: { challenge: string; nonce: string },
    nowSeconds: number,
  ): boolean => {
    if (!ENROLLMENT_POW_NONCE_PATTERN.test(work.nonce)) return false;
    const parsed = parseEnrollmentPowChallenge(work.challenge);
    if (!parsed || parsed.difficulty !== difficulty) return false;
    if (
      parsed.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
      nowSeconds - parsed.issuedAt > ENROLLMENT_POW_WINDOW_SECONDS
    ) {
      return false;
    }
    const expected = macFor(publicKey, parsed.issuedAt, parsed.difficulty);
    if (!timingSafeEqual(expected, Buffer.from(parsed.mac))) return false;
    const hash = createHash("sha256")
      .update(enrollmentPowHashInput(publicKey, work.challenge, work.nonce))
      .digest();
    return hasLeadingZeroBits(hash, parsed.difficulty);
  };

  const breakerOpen = (nowMs: number, openKeys: number): boolean => {
    while (openEnrollments.length > 0 && openEnrollments[0]! <= nowMs - HOUR_MS) {
      openEnrollments.shift();
    }
    return openKeys >= maxEnrolledKeys || openEnrollments.length >= enrollmentsPerHour;
  };

  return {
    issueChallenge,
    workIsValid,
    breakerOpen,
    recordEnrollment(nowMs: number) {
      openEnrollments.push(nowMs);
    },
  };
}
