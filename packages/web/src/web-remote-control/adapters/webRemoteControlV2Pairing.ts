import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";

/**
 * Exchanges the QR pairing code (`pk`) for a relay JWT at `POST /api/v1/remote/session`
 * (relay `device-key` identity mode). The code is single-use, so a failure is never retried here.
 */
export function createWebRemoteControlV2PairingClient(origin: string, fetcher = fetch) {
  return {
    async exchange(code: string, signal: AbortSignal): Promise<string> {
      try {
        const response = await fetcher(new URL("/api/v1/remote/session", origin), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pairing_code: code }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          redirect: "error",
        });
        if (response.status === 401 || response.status === 400) {
          throw new WebRemoteControlV2ConnectionError("auth-required");
        }
        if (!response.ok) {
          throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
        }
        const body = (await response.json().catch(() => undefined)) as
          | { code?: unknown; data?: { jwt?: unknown } }
          | undefined;
        const jwt = body?.data?.jwt;
        if (body?.code !== 0 || typeof jwt !== "string" || jwt.length === 0) {
          throw new WebRemoteControlV2ConnectionError("relay-unavailable");
        }
        return jwt;
      } catch (error) {
        // Never propagate fetch or body text: the code and JWT must stay out of the UI and logs.
        if (error instanceof WebRemoteControlV2ConnectionError) throw error;
        throw new WebRemoteControlV2ConnectionError("relay-unavailable", true);
      }
    },
  };
}
