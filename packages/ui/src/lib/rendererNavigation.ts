interface RendererNavigationEntry {
  readonly type?: string;
}

function readRendererNavigationEntries(): RendererNavigationEntry[] {
  try {
    if (typeof globalThis.performance?.getEntriesByType !== "function") {
      return [];
    }
    return globalThis.performance.getEntriesByType("navigation") as RendererNavigationEntry[];
  } catch {
    return [];
  }
}

/**
 * Distinguish app cold start from a refresh of the same renderer.
 * Workspace/app entry points should show only drafts, but a renderer reload during output must restore the current pane and continue streaming.
 */
export function isRendererReloadNavigation(
  entries: readonly RendererNavigationEntry[] = readRendererNavigationEntries(),
): boolean {
  return entries[0]?.type === "reload";
}
