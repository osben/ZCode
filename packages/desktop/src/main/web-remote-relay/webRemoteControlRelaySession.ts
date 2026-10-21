import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";

/**
 * Exchanges the account identity token for a relay-signed JWT (`POST /api/v1/remote/session`).
 * The relay JWT is the only credential sent to `/api/v1/remote/*` and `ws2`. The identity token is
 * used only for this exchange and never goes into a WS URL, a QR code, or a log line.
 */
export interface WebRemoteControlRelayBearer {
  /**
   * Returns a relay JWT for the identity on the given relay HTTP origin, reusing a cached one until
   * shortly before it expires.
   */
  getJwt(input: { relayOrigin: string; identityJwt: string; signal: AbortSignal }): Promise<string>;
  /** Drops cached JWTs, for example after the relay answered 401 for one. */
  invalidate(): void;
}

const REFRESH_MARGIN_MS = 30_000;

interface CachedRelayJwt {
  relayOrigin: string;
  identityJwt: string;
  jwt: string;
  expiresAt: number;
}

export function createWebRemoteControlRelayBearer(
  options: { fetcher?: typeof fetch; now?: () => number } = {},
): WebRemoteControlRelayBearer {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cached: CachedRelayJwt | undefined;
  // In-flight exchange, shared by concurrent callers for the same relay and identity.
  let inFlight:
    | { relayOrigin: string; identityJwt: string; promise: Promise<CachedRelayJwt> }
    | undefined;

  async function exchange(
    relayOrigin: string,
    identityJwt: string,
    signal: AbortSignal,
  ): Promise<CachedRelayJwt> {
    const response = await fetcher(new URL("/api/v1/remote/session", relayOrigin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity_token: identityJwt }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      throw new WebRemoteControlV2ConnectionError("auth-required");
    }
    if (!response.ok) {
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
    }
    const data = readSessionData(await response.json().catch(() => undefined));
    if (!data) {
      throw new WebRemoteControlV2ConnectionError("relay-unavailable");
    }
    return {
      relayOrigin,
      identityJwt,
      jwt: data.jwt,
      expiresAt: now() + data.expiresInSeconds * 1000,
    };
  }

  return {
    async getJwt({ relayOrigin, identityJwt, signal }) {
      if (
        cached &&
        cached.relayOrigin === relayOrigin &&
        cached.identityJwt === identityJwt &&
        cached.expiresAt - REFRESH_MARGIN_MS > now()
      ) {
        return cached.jwt;
      }
      if (
        !inFlight ||
        inFlight.relayOrigin !== relayOrigin ||
        inFlight.identityJwt !== identityJwt
      ) {
        const promise = exchange(relayOrigin, identityJwt, signal);
        const entry = { relayOrigin, identityJwt, promise };
        inFlight = entry;
        // Clear the slot whichever way the exchange settles, unless a newer one replaced it.
        void promise
          .finally(() => {
            if (inFlight === entry) inFlight = undefined;
          })
          .catch(() => undefined);
      }
      const next = await inFlight.promise;
      cached = next;
      return next.jwt;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

function readSessionData(body: unknown): { jwt: string; expiresInSeconds: number } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const envelope = body as { code?: unknown; data?: unknown };
  if (envelope.code !== 0 || !envelope.data || typeof envelope.data !== "object") return undefined;
  const data = envelope.data as { jwt?: unknown; expires_in?: unknown };
  if (typeof data.jwt !== "string" || data.jwt.length === 0) return undefined;
  if (
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  ) {
    return undefined;
  }
  return { jwt: data.jwt, expiresInSeconds: data.expires_in };
}
