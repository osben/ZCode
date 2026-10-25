import {
  EMPTY_PLUGIN_UI_INSTANCE_DERIVATION,
  type PluginUiInstanceDerivation,
  type PluginUiRowDisposition,
} from "../domain/pluginUiInstancePolicy.js";

/**
 * Each session's most recent timeline-derived logical UI disposition (renderer memory). The timeline
 * writes in an effect; tool cards read their own disposition by (sessionKey, toolCallId) (superseded,
 * forced inline). Holds no sandbox state.
 */
const derivations = new Map<string, PluginUiInstanceDerivation>();
const listeners = new Set<() => void>();

export function setPluginUiInstanceDerivation(
  sessionKey: string,
  derivation: PluginUiInstanceDerivation,
): void {
  if (derivations.get(sessionKey) === derivation) return;
  derivations.set(sessionKey, derivation);
  for (const listener of listeners) listener();
}

export function getPluginUiRowDisposition(
  sessionKey: string,
  toolCallId: string,
): PluginUiRowDisposition | undefined {
  return (derivations.get(sessionKey) ?? EMPTY_PLUGIN_UI_INSTANCE_DERIVATION).byToolCallId[
    toolCallId
  ];
}

export function subscribePluginUiInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: clear all records. */
export function resetPluginUiInstancesForTest(): void {
  derivations.clear();
  listeners.clear();
}
