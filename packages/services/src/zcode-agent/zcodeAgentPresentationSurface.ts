import type { ServiceAuthorityMode } from "@zcode/shared";

export type ZCodeAgentPresentationSurface = "desktop";

export interface ZCodeAgentPresentationHostFacts {
  runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** Main has completed the server-side single-feature rollout decision; when omitted, preserve historical Host assembly semantics. */
  desktopContextPromptEnabled?: boolean;
}

export function resolveZCodeAgentPresentationSurface(
  facts: ZCodeAgentPresentationHostFacts,
): ZCodeAgentPresentationSurface | undefined {
  // Desktop presentation capability must be derived from trusted assembly facts already held by the Host; callers must not pass a separate flag repeatedly.
  // Ordinary HTTP/manual app servers lack these two facts, so keep using the terminal surface and avoid spreading the Desktop prompt.
  const isDesktopHost =
    facts.runtimeSurface === "desktop_local_host" ||
    facts.serviceAuthorityMode === "desktop-attached-remote";
  if (!isDesktopHost || facts.desktopContextPromptEnabled === false) {
    return undefined;
  }
  return "desktop";
}
