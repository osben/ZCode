/**
 * Keeps at most one live sandbox per scope.
 * Key is `buildPluginUiSurfaceKey(target, scope)`, uniformly isolating workspace/session/plugin.
 * While the side pane is open the inline card shows a placeholder; tool results carrying
 * `display.ui.surface` use this to decide whether the surface tab is already open in this session
 * (R4 routing). This only records "who is rendering" and holds no sandbox state.
 * Renderer memory, not persisted.
 */
export type PluginUiSurface = "inline" | "side-pane";

const surfaces = new Map<string, Map<symbol, PluginUiSurface>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function claimPluginUiSurface(key: string, surface: PluginUiSurface): () => void {
  const token = Symbol();
  const claims = surfaces.get(key) ?? new Map<symbol, PluginUiSurface>();
  const before = getPluginUiSurface(key);
  claims.set(token, surface);
  surfaces.set(key, claims);
  if (before !== getPluginUiSurface(key)) notify();
  return () => {
    const before = getPluginUiSurface(key);
    claims.delete(token);
    if (!claims.size && surfaces.get(key) === claims) surfaces.delete(key);
    if (before !== getPluginUiSurface(key)) notify();
  };
}

export function getPluginUiSurface(key: string): PluginUiSurface | null {
  const claims = surfaces.get(key);
  return claims?.size
    ? [...claims.values()].includes("side-pane")
      ? "side-pane"
      : "inline"
    : null;
}

export function subscribePluginUiSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: clear all records. */
export function resetPluginUiSurfacesForTest(): void {
  surfaces.clear();
  listeners.clear();
}
