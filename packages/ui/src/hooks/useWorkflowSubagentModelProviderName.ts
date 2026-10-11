import { useMemo } from "react";
import type { ZCodeConfigOption } from "@zcode/shared";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * Source of the provider name for a subagent model: the session's model catalog
 * (the entry with category === "model" in workspace configOptions) already includes
 * `modelProviderId` / `modelProviderName`; there is no need to load a second provider catalog for one label.
 *
 * Return only the **name**, never the id: without providerLabel, `modelProviderName` falls back to
 * providerId itself (see zcodeSessionSettingsToConfigOptions). Treat that as no name here—never
 * show a providerId (which is a UUID for team plans) on screen.
 */
function workflowSubagentProviderNameLookup(
  configOptions: readonly ZCodeConfigOption[] | null | undefined,
): ((providerId: string) => string | undefined) | undefined {
  const entries = configOptions?.find((option) => option.category === "model")?.options;
  if (entries === undefined) {
    return undefined;
  }
  const names = new Map<string, string>();
  for (const entry of entries) {
    const providerId = entry.modelProviderId?.trim();
    const providerName = entry.modelProviderName?.trim();
    if (!providerId || !providerName || providerName === providerId) {
      continue;
    }
    if (!names.has(providerId)) {
      names.set(providerId, providerName);
    }
  }
  return names.size === 0 ? undefined : (providerId: string) => names.get(providerId);
}

/**
 * Hook form of the catalog lookup above. If workspacePath is absent (the host cannot provide a scope),
 * there is no lookup function. In that case the name formatter falls back to the bare modelId by design.
 */
export function useWorkflowSubagentModelProviderName(
  workspacePath: string | undefined,
  workspaceIdentity?: string,
): ((providerId: string) => string | undefined) | undefined {
  const configOptions = useZCodeSessionStore((state) =>
    workspacePath === undefined
      ? undefined
      : selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).configOptions,
  );
  return useMemo(() => workflowSubagentProviderNameLookup(configOptions), [configOptions]);
}
