import {
  normalizeAgentProviderToZCodeAgent,
  normalizeAgentProvidersToZCodeAgent,
  type ZCodeProvider,
  type AppSettings,
} from "@zcode/shared";
const INSTALLABLE_AGENT_CLI_PROVIDERS: ZCodeProvider[] = [];

export type BuiltinAgentCliStatus = "enabled" | "enabling" | "disabling" | "disabled";

function normalizeEnabledBuiltinAgentCliProviders(
  providers?: ReadonlyArray<ZCodeProvider>,
): ZCodeProvider[] {
  return normalizeAgentProvidersToZCodeAgent(providers);
}

export function getEnabledBuiltinAgentCliProviders(
  settings: Pick<AppSettings, "enabledBuiltinAgentCliProviders"> | null | undefined,
): ZCodeProvider[] {
  return normalizeEnabledBuiltinAgentCliProviders(settings?.enabledBuiltinAgentCliProviders);
}

export function requiresBuiltinAgentCliInstall(provider: ZCodeProvider): boolean {
  return INSTALLABLE_AGENT_CLI_PROVIDERS.includes(provider);
}

export function resolveBuiltinAgentCliStatus(params: {
  provider: ZCodeProvider;
  enabledProviders: readonly ZCodeProvider[];
  enablingProvider: ZCodeProvider | null;
  disablingProvider: ZCodeProvider | null;
}): BuiltinAgentCliStatus {
  // Bugfix: non-install builtin agent providers are already supplied by the current runtime and
  // do not depend on settings.enabledBuiltinAgentCliProviders. Always return enabled here, so a
  // missing default, a hot update, or legacy config cannot misjudge glm as disabled and lock the
  // send entry.
  if (!requiresBuiltinAgentCliInstall(params.provider)) {
    return "enabled";
  }

  if (params.enablingProvider === params.provider) {
    return "enabling";
  }

  if (params.disablingProvider === params.provider) {
    return "disabling";
  }

  return params.enabledProviders.includes(params.provider) ? "enabled" : "disabled";
}

export function getEffectiveBuiltinAgentCliProvider(
  _settings: Pick<AppSettings, "enabledBuiltinAgentCliProviders"> | null | undefined,
  provider: ZCodeProvider,
): ZCodeProvider {
  // Bugfix: selectedProvider in the workspace/store may hold a stale third-party provider. If the
  // UI keeps consuming that value directly, menus and task creation would treat the old agent as
  // available. Fall back uniformly to the always-available glm so UI state and the agent server's
  // single source of truth do not diverge.
  return normalizeAgentProviderToZCodeAgent(provider);
}
