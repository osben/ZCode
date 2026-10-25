import { describe, expect, it } from "vitest";
import {
  encodeEnrollmentPowChallenge,
  hasLeadingZeroBits,
  parseEnrollmentPowChallenge,
} from "./enrollmentPow.js";

describe("enrollment proof of work layout", () => {
  it("round-trips a challenge and rejects malformed ones", () => {
    const mac = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const encoded = encodeEnrollmentPowChallenge({
      issuedAt: 1_800_000_000,
      difficulty: 22,
      mac,
    });
    expect(parseEnrollmentPowChallenge(encoded)).toEqual({
      issuedAt: 1_800_000_000,
      difficulty: 22,
      mac,
    });
    expect(parseEnrollmentPowChallenge("short")).toBeUndefined();
    expect(parseEnrollmentPowChallenge(`${encoded}A`)).toBeUndefined();
    expect(parseEnrollmentPowChallenge("!".repeat(34))).toBeUndefined();
    // Spare bits of the last character must be zero: one challenge, one spelling.
    const last = encoded.at(-1) === "A" ? "B" : "A";
    expect(parseEnrollmentPowChallenge(`${encoded.slice(0, -1)}${last}`)).toBeUndefined();
  });

  it("counts leading zero bits across byte boundaries", () => {
    expect(hasLeadingZeroBits(Uint8Array.of(0, 0x1f), 11)).toBe(true);
    expect(hasLeadingZeroBits(Uint8Array.of(0, 0x1f), 12)).toBe(false);
    expect(hasLeadingZeroBits(Uint8Array.of(0, 0), 16)).toBe(true);
    expect(hasLeadingZeroBits(Uint8Array.of(0x80), 1)).toBe(false);
    expect(hasLeadingZeroBits(Uint8Array.of(0x7f), 1)).toBe(true);
  });
});
