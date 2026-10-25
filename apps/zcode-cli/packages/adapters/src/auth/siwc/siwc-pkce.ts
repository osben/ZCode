import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface SiwcPkcePair {
  readonly codeChallenge: string;
  readonly codeVerifier: string;
}

/** PKCE S256 challenge: base64url(SHA-256(verifier)) without padding (RFC 7636 §4.2). */
export function computeSiwcCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** Fresh verifier per attempt: 32 random bytes, base64url-encoded (43 chars, unreserved). */
export function createSiwcPkcePair(): SiwcPkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  return { codeChallenge: computeSiwcCodeChallenge(codeVerifier), codeVerifier };
}

/** Fresh state per attempt; validated by the loopback callback server. */
export function createSiwcState(): string {
  return randomBytes(24).toString("base64url");
}

/** Fresh nonce per attempt; validated against the id_token claim after exchange. */
export function createSiwcNonce(): string {
  return randomUUID();
}
