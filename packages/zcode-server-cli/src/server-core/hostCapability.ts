import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "@zcode/shared";

// Keep the one-time, short-lived ticket semantics consistent with packages/server/src/hostCapability.ts.
// Dependency boundaries prohibit importing the implementation through @zcode/server, so retain an equivalent
// in-memory implementation in this package; behavior follows the legacy server compatibility contract (TTL, one-time consumption, expiration cleanup).
export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

export interface HostCapabilityStore {
  issue(): ServerRemoteHostCapability;
  consume(capability: string | undefined): boolean;
}

/** Short-lived, single-use desktop host capability; exists only in Server Core process memory. */
export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const expiresByCapability = new Map<string, number>();

  const purgeExpired = (at: number): void => {
    for (const [capability, expiresAt] of expiresByCapability) {
      if (expiresAt <= at) expiresByCapability.delete(capability);
    }
  };

  return {
    issue() {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      expiresByCapability.set(capability, expiresAt);
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return false;
      const consumedAt = now();
      const expiresAt = expiresByCapability.get(capability);
      // Delete the ticket whether it succeeds, expires, or is replayed; only its first use within the TTL may receive
      // the trusted-host role, preventing a replayable long-lived privilege declaration.
      expiresByCapability.delete(capability);
      purgeExpired(consumedAt);
      return expiresAt !== undefined && expiresAt > consumedAt;
    },
  };
}
