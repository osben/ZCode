/**
 * Single owner of plugin page widgetState.
 * Key is `buildPluginUiSurfaceKey(target, scope)`: workspaceKey + sessionId + pluginId + server +
 * resource + scopeId, isolated the same way as pluginUiSurfaceStore. The page's `ui/set-widget-state`
 * writes here synchronously; `usePluginUiHost` takes the initial value from here when creating the
 * AppBridge, so collapsing and re-expanding within a session, or closing and reopening the pane,
 * both restore state.
 * Renderer memory, not persisted: empty after a process restart; a plugin's business data belongs in
 * its own server. Since 4a-0 this is not written to session storage via CLI commands and has no
 * "model-visible" semantics — information for the model goes through updateModelContext.
 */
const states = new Map<string, unknown>();

/** Returns undefined when never written; a page-written null is preserved as-is (distinguishes "not loaded" from "cleared"). */
export function getPluginUiWidgetState(key: string): unknown {
  return states.get(key);
}

export function setPluginUiWidgetState(key: string, widgetState: unknown): void {
  states.set(key, widgetState);
}

export function clearPluginUiWidgetState(key: string): void {
  states.delete(key);
}

/** For tests: clear all records. */
export function resetPluginUiWidgetStateForTest(): void {
  states.clear();
}
