import {
  WEB_REMOTE_CONTROL_RELAY_V2_HTTP,
  WebRemoteControlV2ConnectionError,
  parseWebRemoteControlRelayV2HttpResponse,
} from "@zcode/shared/web-remote-relay";
import { withWebRemoteControlHttpSignal } from "#src/web-remote-control/adapters/webRemoteControlHttpSignal.js";

/** One-time tokens are not cached; a 401 is handed to the entry to restore login, and network failures are handed to transport backoff. */
export function createWebRemoteControlV2TokenClient(origin: string, fetcher = fetch) {
  return async (jwt: string, signal: AbortSignal): Promise<string> => {
    try {
      return await withWebRemoteControlHttpSignal(signal, async (requestSignal) => {
        const response = await fetcher(
          new URL(WEB_REMOTE_CONTROL_RELAY_V2_HTTP.token.path, origin),
          {
            method: "POST",
            headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
            body: JSON.stringify({ role: "terminal" }),
            signal: requestSignal,
            redirect: "error",
          },
        );
        if (response.status === 401) throw new WebRemoteControlV2ConnectionError("auth-required");
        if (!response.ok)
          throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
        // Reading the body can also fail due to network loss or timeout and must be left to the outer network retry; only complete but invalid JSON is a terminal state.
        const body = await response.text();
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          throw new WebRemoteControlV2ConnectionError("relay-unavailable");
        }
        const result = parseWebRemoteControlRelayV2HttpResponse("token", value);
        if (!result || result.code !== 0 || !result.data)
          throw new WebRemoteControlV2ConnectionError("relay-unavailable");
        return result.data.token;
      });
    } catch (error) {
      // Do not propagate the fetch/server body, so one-time tokens and JWTs do not enter the UI or diagnostic logs.
      if (error instanceof WebRemoteControlV2ConnectionError) throw error;
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", true);
    }
  };
}
