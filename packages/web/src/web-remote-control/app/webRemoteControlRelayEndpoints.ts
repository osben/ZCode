import {
  normalizeConfiguredWebRemoteControlRelayWsUrl,
  resolveWebRemoteControlRelayHttpOrigin,
  resolveWebRemoteControlRelayWsUrl,
} from "@zcode/shared";

export interface WebRemoteControlRelayEndpoints {
  wsUrl: string;
  /** Origin for the relay HTTP API (`/session`, `/token`, `/device`); always the WS URL's host. */
  httpOrigin: string;
}

/**
 * Single owner of the web client's relay address (specs/relay-v2-migration.md §13). The page may be
 * hosted on its own domain, so HTTP calls must follow the configured relay like `ws2` does instead
 * of using the page origin. Unset configuration keeps the page origin for both.
 */
export function resolveWebRemoteControlRelayEndpoints(input: {
  configuredRelayUrl: string | null | undefined;
  pageOrigin: string;
}): WebRemoteControlRelayEndpoints {
  const wsUrl = resolveWebRemoteControlRelayWsUrl({
    endpointOrigin: input.pageOrigin,
    overrideUrl: normalizeConfiguredWebRemoteControlRelayWsUrl(input.configuredRelayUrl),
  });
  return { wsUrl, httpOrigin: resolveWebRemoteControlRelayHttpOrigin(wsUrl) };
}
