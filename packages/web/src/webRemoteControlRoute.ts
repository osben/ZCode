import { resolveWebRemoteControlRoutePathFromBaseUrl } from "@zcode/shared";

interface WebRemoteControlRouteEnv {
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly BASE_URL: string;
}

/**
 * Page route and asset directory are decoupled: multi-version OSS releases use
 * `/remote/v4/<version>/` as the Vite base so every sub-resource request carries
 * the version, while the page entry stays at `/remote/v4`. Inject the route
 * variable at build time to override; when it is not injected (Docker, v3, dev
 * `/remote`), derive from BASE_URL, matching historical behavior.
 */
export function resolveWebRemoteControlRoutePath(env: WebRemoteControlRouteEnv): string {
  const explicitRoutePath = env.VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?.trim();
  return resolveWebRemoteControlRoutePathFromBaseUrl(explicitRoutePath || env.BASE_URL);
}
