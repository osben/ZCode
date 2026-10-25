import { Emitter } from "@zcode/rpc";
import {
  HostResponseTypes,
  HostMessageTypes,
  broadcastMessageSchema,
  hostBroadcastClaimResultMessageSchema,
  hostBroadcastEnvelopeSchema,
} from "@zcode/shared";
import type {
  BroadcastClaimAcquireResult,
  BroadcastClaimLease,
  IBroadcastService,
  BroadcastMessage,
} from "./broadcast.js";

const BROADCAST_CLAIM_TIMEOUT_MS = 2_000;
const BROADCAST_CLAIM_RESERVATION_TTL_MS = 5_000;
const BROADCAST_CLAIM_RETRY_MS = 250;
const MAX_LOCAL_CLAIMS = 1_024;
let claimRequestSequence = 0;

type LocalClaimRecord = {
  token: string;
  status: "reserved" | "committed";
  expiresAt: number | null;
};

function pruneLocalClaims(claims: Map<string, LocalClaimRecord>, now = Date.now()): void {
  for (const [key, claim] of claims) {
    if (claim.status === "reserved" && claim.expiresAt !== null && claim.expiresAt <= now) {
      claims.delete(key);
    }
  }
  while (claims.size > MAX_LOCAL_CLAIMS) {
    const oldest = claims.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    claims.delete(oldest);
  }
}

function createClaimRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return randomId;
  }
  claimRequestSequence += 1;
  return `broadcast-claim-${Date.now()}-${claimRequestSequence}`;
}

function createLocalClaimToken(): string {
  return `local-${createClaimRequestId()}`;
}

/**
 * Node implementation of the broadcast service — runs in the host process.
 *
 * When send() is called:
 *   1. Trigger the local emitter (the Renderer in this window receives it through an RPC event).
 *   2. Send it to the main process through parentPort (BroadcastHub relays it to other windows).
 *
 * When a relayed broadcast arrives from main:
 *   Trigger the local emitter → Renderer receives it through an RPC event.
 *
 * @param parentPort - parentPort for the Electron host process (Electron.ParentPort).
 *                     Pass null when cross-window support is unavailable (for example, web server mode).
 */
export function createBroadcastService(
  parentPort: {
    postMessage(message: unknown): void;
    on(event: "message", listener: (e: { data: unknown }) => void): void;
  } | null,
): IBroadcastService {
  const emitter = new Emitter<BroadcastMessage>();
  const localClaims = new Map<string, LocalClaimRecord>();
  const pendingClaims = new Map<
    string,
    {
      key: string;
      resolve: (result: BroadcastClaimAcquireResult) => void;
      timeout: ReturnType<typeof setTimeout>;
      timedOut: boolean;
      cleanupTimeout: ReturnType<typeof setTimeout> | null;
    }
  >();

  const postClaimControl = (
    type:
      | typeof HostResponseTypes.BroadcastClaimCommit
      | typeof HostResponseTypes.BroadcastClaimRelease,
    lease: BroadcastClaimLease,
  ): void => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({ type, key: lease.key, claimToken: lease.token });
    } catch {
      // Failure is expected while the host is exiting; Main reclaims uncommitted reservations during unregister.
    }
  };

  // Listen for broadcasts relayed by the main process and cross-window claim results.
  if (parentPort) {
    parentPort.on("message", (e: { data: unknown }) => {
      const broadcastResult = hostBroadcastEnvelopeSchema.safeParse(e.data);
      if (broadcastResult.success && broadcastResult.data.type === HostMessageTypes.Broadcast) {
        emitter.fire(broadcastResult.data.message);
        return;
      }

      const claimResult = hostBroadcastClaimResultMessageSchema.safeParse(e.data);
      if (!claimResult.success) {
        return;
      }
      const pending = pendingClaims.get(claimResult.data.requestId);
      if (!pending) {
        return;
      }
      pendingClaims.delete(claimResult.data.requestId);
      clearTimeout(pending.timeout);
      if (pending.cleanupTimeout) {
        clearTimeout(pending.cleanupTimeout);
      }
      // If the request times out but Main grants the reservation later, release it explicitly with the original key/token;
      // otherwise no component owns the lease anymore and other windows must wait for the TTL to expire before trying again.
      if (pending.timedOut) {
        if (claimResult.data.status === "acquired") {
          postClaimControl(HostResponseTypes.BroadcastClaimRelease, {
            key: pending.key,
            token: claimResult.data.claimToken,
          });
        }
        return;
      }
      if (claimResult.data.status === "acquired") {
        pending.resolve({
          status: "acquired",
          lease: { key: pending.key, token: claimResult.data.claimToken },
        });
        return;
      }
      if (claimResult.data.status === "busy") {
        pending.resolve({ status: "busy", retryAfterMs: claimResult.data.retryAfterMs });
        return;
      }
      pending.resolve({ status: "committed" });
    });
  }

  const acquireClaim = async (key: string): Promise<BroadcastClaimAcquireResult> => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return { status: "unavailable" };
    }
    if (!parentPort) {
      const now = Date.now();
      pruneLocalClaims(localClaims, now);
      const existing = localClaims.get(normalizedKey);
      if (existing?.status === "committed") {
        return { status: "committed" };
      }
      if (existing) {
        return {
          status: "busy",
          retryAfterMs: Math.max(
            0,
            Math.min(BROADCAST_CLAIM_RETRY_MS, (existing.expiresAt ?? now) - now),
          ),
        };
      }
      const lease = { key: normalizedKey, token: createLocalClaimToken() };
      localClaims.set(normalizedKey, {
        token: lease.token,
        status: "reserved",
        expiresAt: now + BROADCAST_CLAIM_RESERVATION_TTL_MS,
      });
      pruneLocalClaims(localClaims, now);
      return { status: "acquired", lease };
    }

    const requestId = createClaimRequestId();
    return new Promise<BroadcastClaimAcquireResult>((resolve) => {
      // Do not optimistically play after a claim timeout; Main may already have granted the same key to another window.
      // A late acquired result is explicitly released by token in the message handler.
      const timeout = setTimeout(() => {
        const pending = pendingClaims.get(requestId);
        if (pending) {
          pending.timedOut = true;
          pending.cleanupTimeout = setTimeout(() => {
            pendingClaims.delete(requestId);
          }, BROADCAST_CLAIM_RESERVATION_TTL_MS + BROADCAST_CLAIM_TIMEOUT_MS);
        }
        resolve({ status: "unavailable" });
      }, BROADCAST_CLAIM_TIMEOUT_MS);
      pendingClaims.set(requestId, {
        key: normalizedKey,
        resolve,
        timeout,
        timedOut: false,
        cleanupTimeout: null,
      });
      try {
        parentPort.postMessage({
          type: HostResponseTypes.BroadcastClaimRequest,
          requestId,
          key: normalizedKey,
        });
      } catch {
        clearTimeout(timeout);
        pendingClaims.delete(requestId);
        resolve({ status: "unavailable" });
      }
    });
  };

  const commitClaim = async (lease: BroadcastClaimLease): Promise<void> => {
    if (parentPort) {
      postClaimControl(HostResponseTypes.BroadcastClaimCommit, lease);
      return;
    }
    pruneLocalClaims(localClaims);
    const current = localClaims.get(lease.key);
    if (current?.status === "reserved" && current.token === lease.token) {
      localClaims.set(lease.key, { ...current, status: "committed", expiresAt: null });
    }
  };

  const releaseClaim = async (lease: BroadcastClaimLease): Promise<void> => {
    if (parentPort) {
      postClaimControl(HostResponseTypes.BroadcastClaimRelease, lease);
      return;
    }
    pruneLocalClaims(localClaims);
    const current = localClaims.get(lease.key);
    if (current?.status === "reserved" && current.token === lease.token) {
      localClaims.delete(lease.key);
    }
  };

  return {
    async send(message: BroadcastMessage): Promise<void> {
      const validatedMessage = broadcastMessageSchema.parse(message);
      // 1. Notify this window's Renderer.
      emitter.fire(validatedMessage);
      // 2. Send it to the main process for cross-window relay.
      if (parentPort) {
        parentPort.postMessage({ type: HostResponseTypes.Broadcast, message: validatedMessage });
      }
    },
    acquireClaim,
    commitClaim,
    releaseClaim,
    async tryClaim(key: string): Promise<boolean> {
      const result = await acquireClaim(key);
      if (result.status !== "acquired") {
        return false;
      }
      await commitClaim(result.lease);
      return true;
    },
    onMessage: emitter.event,
  };
}
