import { createHash, createHmac, randomBytes } from "node:crypto";
import type { WebRemoteControlRelayRole } from "@zcode/shared";

export interface WebRemoteControlRelayAuthProvider {
  createPassword(): string;
  createPassHash(password: string): string;
  calculateProof(
    passHash: string,
    nonce: string,
    role: WebRemoteControlRelayRole,
    deviceSid: string,
  ): string;
}

export function createNodeWebRemoteControlRelayAuthProvider(): WebRemoteControlRelayAuthProvider {
  return {
    createPassword: () => randomBytes(24).toString("base64url"),
    // Production callers hash createPassword()'s 192-bit random secret, never a user-entered password.
    // The resulting passHash is itself the secret HMAC/QR credential; this is not password storage.
    // Do not reuse this helper for human passwords, which require a password-hashing algorithm.
    createPassHash: (password) => createHash("sha256").update(password).digest("base64"),
    calculateProof: (passHash, nonce, role, deviceSid) =>
      createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url"),
  };
}
