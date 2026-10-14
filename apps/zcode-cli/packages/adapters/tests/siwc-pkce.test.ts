import { describe, expect, it } from "vitest";
import {
  computeSiwcCodeChallenge,
  createSiwcNonce,
  createSiwcPkcePair,
  createSiwcState,
} from "../src/auth/siwc/siwc-pkce.js";

describe("SIWC PKCE utilities", () => {
  it("derives the S256 challenge from RFC 7636 appendix B vector", () => {
    // RFC 7636 appendix B: verifier -> challenge (base64url, no padding).
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(computeSiwcCodeChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates verifier/challenge pairs without padding characters", () => {
    const pair = createSiwcPkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pair.codeChallenge).not.toContain("=");
    expect(pair.codeChallenge).toBe(computeSiwcCodeChallenge(pair.codeVerifier));
  });

  it("creates unique state and nonce per call", () => {
    const states = new Set([createSiwcState(), createSiwcState(), createSiwcState()]);
    const nonces = new Set([createSiwcNonce(), createSiwcNonce(), createSiwcNonce()]);
    expect(states.size).toBe(3);
    expect(nonces.size).toBe(3);
  });
});
