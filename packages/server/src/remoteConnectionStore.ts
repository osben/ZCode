import { randomUUID } from "node:crypto";
import type { RemoteConnection } from "./remote/index.js";

export const REMOTE_CONNECTION_CLAIM_TTL_MS = 5 * 60_000;

export interface RemoteConnectionStore {
  /** Keep a connection until it is claimed or its unclaimed TTL elapses; returns its id. */
  add(connection: RemoteConnection): string;
  /** Single-use: remove the entry and transfer ownership to the caller. */
  claim(id: string): RemoteConnection | undefined;
}

/**
 * Unclaimed connections are disposed on expiry. Without this, a POST that never got a
 * WebSocket claim kept its remote backend and child process alive for the server lifetime.
 */
export function createRemoteConnectionStore({
  ttlMs = REMOTE_CONNECTION_CLAIM_TTL_MS,
}: { ttlMs?: number } = {}): RemoteConnectionStore {
  const entries = new Map<string, { connection: RemoteConnection; expiry: NodeJS.Timeout }>();

  return {
    add(connection) {
      const id = randomUUID();
      const expiry = setTimeout(() => {
        entries.delete(id);
        connection.dispose();
      }, ttlMs);
      // The expiry timer alone must not keep the process alive; the HTTP server does that.
      expiry.unref();
      entries.set(id, { connection, expiry });
      return id;
    },
    claim(id) {
      const entry = entries.get(id);
      if (!entry) {
        return undefined;
      }
      clearTimeout(entry.expiry);
      entries.delete(id);
      return entry.connection;
    },
  };
}
