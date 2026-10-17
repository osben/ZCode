import type { IPlatformService } from "@zcode/shared";

/**
 * Whether this UI runs in a local development runtime. Desktop injects the flag
 * authoritatively (`!app.isPackaged`); when a platform omits it (web client, bare hook
 * tests), the build mode decides. Packaged apps and production web builds return false.
 * Surfaces that are not stabilized yet (ACP agents, see specs/acp-agent-runtime.md
 * "Dev-only visibility") gate on this.
 */
export function isLocalDevelopmentRuntime(
  platform: Pick<IPlatformService, "isLocalDevelopmentRuntime">,
): boolean {
  return platform.isLocalDevelopmentRuntime ?? import.meta.env.DEV;
}
