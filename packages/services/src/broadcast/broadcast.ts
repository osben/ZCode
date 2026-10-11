import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Broadcast message
 *
 * Used for cross-window state synchronization. Sent from the Renderer through host → main → other hosts → the corresponding Renderer.
 */
export interface BroadcastMessage {
  /** Channel name, such as "state:theme" or "state:locale" */
  channel: string;
  /** Message payload */
  payload: unknown;
  /** ID of the sending window (filled by BroadcastHub; receivers can use it to skip their own messages) */
  sourceWindowId?: number;
}

/** Temporary reservation for a cross-window opaque claim; the token is used for safe commit/release. */
export interface BroadcastClaimLease {
  key: string;
  token: string;
}

export type BroadcastClaimAcquireResult =
  | { status: "acquired"; lease: BroadcastClaimLease }
  | { status: "busy"; retryAfterMs: number }
  | { status: "committed" }
  | { status: "unavailable" };

/**
 * Broadcast service interface
 *
 * Flow: Renderer → (RPC call) → Host → (parentPort) → Main(BroadcastHub)
 *       → (postMessage) → other Host → (RPC event onMessage) → corresponding Renderer
 */
export interface IBroadcastService {
  /** Send a broadcast message */
  send(message: BroadcastMessage): Promise<void>;
  /** Request a temporary reservation with a token; if busy, retry after retryAfterMs. */
  acquireClaim(key: string): Promise<BroadcastClaimAcquireResult>;
  /** Commit the reservation as a permanent claim for the lifetime of the application process. */
  commitClaim(lease: BroadcastClaimLease): Promise<void>;
  /** Release an uncommitted reservation by token; a late token does not affect a later winner. */
  releaseClaim(lease: BroadcastClaimLease): Promise<void>;
  /** Atomically claim an opaque key within the current application process; only the first claim for a key returns true. */
  tryClaim(key: string): Promise<boolean>;
  /** Receive a broadcast from another window */
  onMessage: Event<BroadcastMessage>;
}

export const IBroadcastService = createServiceDescriptor<IBroadcastService>(
  ServiceChannels.Broadcast,
);
