/**
 * User's manual pin / collapse of plugin cards (renderer view state, not persisted).
 * Key is sessionKey + toolCallId; true = pinned (kept out of the collapsed area), false = collapsed
 * (moved into the collapsed area), no record means the default rule (forced inline / auto-expand for
 * the last three turns). Resource-level `showInline` is also written as true when the handle arrives
 * (only when no manual record exists).
 */
const pinsBySession = new Map<string, ReadonlyMap<string, boolean>>();
const emptyPins: ReadonlyMap<string, boolean> = new Map();
const listeners = new Set<() => void>();

export function getPluginUiManualPin(sessionKey: string, toolCallId: string): boolean | undefined {
  return getPluginUiDisclosureSnapshot(sessionKey).get(toolCallId);
}

export function setPluginUiManualPin(
  sessionKey: string,
  toolCallId: string,
  pinned: boolean | undefined,
): void {
  const previous = getPluginUiDisclosureSnapshot(sessionKey);
  if (previous.get(toolCallId) === pinned) return;
  const next = new Map(previous);
  if (pinned === undefined) next.delete(toolCallId);
  else next.set(toolCallId, pinned);
  if (next.size === 0) pinsBySession.delete(sessionKey);
  else pinsBySession.set(sessionKey, next);
  for (const listener of listeners) listener();
}

/** The former global version propagated other sessions' pin actions into the current timeline; the snapshot now changes only with its owning session. */
export function getPluginUiDisclosureSnapshot(sessionKey: string): ReadonlyMap<string, boolean> {
  return pinsBySession.get(sessionKey) ?? emptyPins;
}

export function subscribePluginUiDisclosure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: clear all records. */
export function resetPluginUiDisclosureForTest(): void {
  pinsBySession.clear();
  listeners.clear();
}
