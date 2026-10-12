import { useEffect, useState } from "react";
import type { PluginUiSurfaceEntry } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { usePluginStore } from "@/store/pluginStore.js";

export interface UsePluginUiSurfacesInput {
  workspacePath: string;
  workspaceIdentity?: string;
  /** When false, do not fetch (no session / unsupported platform) and return an empty array. */
  enabled?: boolean;
}

/**
 * Workspace-level surface entries (): read `plugins/listUiSurfaces` via the bridge.
 * The refresh signal reuses the plugin settings page's store: a change in the id+enabled fingerprint of
 * `installedPlugins` (install / uninstall / enable / disable) triggers a refetch; no separate event
 * channel is used, and nothing is cached across workspaces.
 */
export function usePluginUiSurfaces(input: UsePluginUiSurfacesInput): PluginUiSurfaceEntry[] {
  const bridge = useOptionalServices()?.pluginUiBridgeService;
  const pluginFingerprint = usePluginStore((state) =>
    state.installedPlugins.map((plugin) => `${plugin.id}:${plugin.enabled ? 1 : 0}`).join("|"),
  );
  const enabled = input.enabled !== false && Boolean(bridge);
  const [surfaces, setSurfaces] = useState<PluginUiSurfaceEntry[]>([]);

  useEffect(() => {
    if (!enabled || !bridge) {
      setSurfaces([]);
      return;
    }
    let cancelled = false;
    void bridge
      .listSurfaces({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      })
      .then((next) => {
        if (!cancelled) setSurfaces(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[plugin-ui] listSurfaces failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        setSurfaces([]);
      });
    return () => {
      cancelled = true;
    };
    // pluginFingerprint serves only as a refresh signal.
  }, [bridge, enabled, input.workspaceIdentity, input.workspacePath, pluginFingerprint]);

  return surfaces;
}

/** Manifest title may be locale → string; resolved by locale, language prefix, en, then any value. */
export function resolvePluginUiSurfaceTitle(
  title: PluginUiSurfaceEntry["title"],
  locale: string,
): string {
  if (typeof title === "string") return title;
  const language = locale.split("-")[0] ?? locale;
  return (
    title[locale] ??
    title[language] ??
    Object.entries(title).find(([key]) =>
      key.toLowerCase().startsWith(language.toLowerCase()),
    )?.[1] ??
    title.en ??
    Object.values(title)[0] ??
    ""
  );
}
