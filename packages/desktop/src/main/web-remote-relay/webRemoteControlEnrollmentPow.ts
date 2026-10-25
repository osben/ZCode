import { createHash } from "node:crypto";
import {
  enrollmentPowHashInput,
  hasLeadingZeroBits,
  ENROLLMENT_POW_MAX_DIFFICULTY,
  ENROLLMENT_POW_MIN_DIFFICULTY,
} from "@zcode/shared/web-remote-relay";

/** Hashes per slice. Each slice is a few milliseconds, so timers and IPC keep running between slices. */
const SLICE_HASHES = 4096;

export interface EnrollmentPowChallengeInfo {
  challenge: string;
  difficulty: number;
}

/**
 * Solves the open-enrollment proof of work (`specs/relay-v2-migration.md` section 15.6) on the main
 * thread without blocking it: the search yields to the event loop between slices and stops on abort.
 * A Worker file is avoided on purpose, because it is fragile inside the Electron asar bundle.
 */
export async function solveEnrollmentPow(options: {
  publicKey: string;
  pow: EnrollmentPowChallengeInfo;
  signal?: AbortSignal;
}): Promise<{ challenge: string; nonce: string }> {
  const { publicKey, pow, signal } = options;
  if (
    !Number.isInteger(pow.difficulty) ||
    pow.difficulty < ENROLLMENT_POW_MIN_DIFFICULTY ||
    pow.difficulty > ENROLLMENT_POW_MAX_DIFFICULTY
  ) {
    throw new Error("Enrollment difficulty is out of range.");
  }
  let counter = 0;
  for (;;) {
    if (signal?.aborted) throw new Error("Enrollment was aborted.");
    for (let index = 0; index < SLICE_HASHES; index += 1) {
      const nonce = String(counter);
      const hash = createHash("sha256")
        .update(enrollmentPowHashInput(publicKey, pow.challenge, nonce))
        .digest();
      if (hasLeadingZeroBits(hash, pow.difficulty)) return { challenge: pow.challenge, nonce };
      counter += 1;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
