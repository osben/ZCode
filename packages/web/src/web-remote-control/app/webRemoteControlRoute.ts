import { resolveWebRemoteControlRoutePathFromBaseUrl } from "@zcode/shared";

interface WebRemoteControlRouteEnv {
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly BASE_URL: string;
}

/**
 * Page routes are separate from the resource directory: OSS multi-version releases use `/remote/v4/<version>/` as the Vite base,
 * so every sub-resource request carries its own version, while the page entry remains `/remote/v4`. Injecting the route variable at build time overrides this;
 * when not injected (Docker, v3, dev `/remote`), it falls back to deriving from BASE_URL, with behavior consistent with history.
 */
export function resolveWebRemoteControlRoutePath(env: WebRemoteControlRouteEnv): string {
  const explicitRoutePath = env.VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?.trim();
  return resolveWebRemoteControlRoutePathFromBaseUrl(explicitRoutePath || env.BASE_URL);
}
