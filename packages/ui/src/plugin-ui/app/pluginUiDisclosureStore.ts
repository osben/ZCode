/**
 * User's manual pin / collapse of plugin cards (renderer view state, not persisted).
 * Key is sessionKey + toolCallId; true = pinned (kept out of the collapsed area), false = collapsed
 * (moved into the collapsed area), no record means the default rule (forced inline / auto-expand for
 * the last three turns). Resource-level `showInline` is also written as true when the handle arrives
 * (only when no manual record exists).
 */
const pins = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (sessionKey: string, toolCallId: string) => `${sessionKey}\u0000${toolCallId}`;

export function getPluginUiManualPin(sessionKey: string, toolCallId: string): boolean | undefined {
  return pins.get(keyOf(sessionKey, toolCallId));
}

export function setPluginUiManualPin(
  sessionKey: string,
  toolCallId: string,
  pinned: boolean | undefined,
): void {
  const key = keyOf(sessionKey, toolCallId);
  if (pins.get(key) === pinned) return;
  if (pinned === undefined) pins.delete(key);
  else pins.set(key, pinned);
  version += 1;
  for (const listener of listeners) listener();
}

/** Snapshot version: incremented on any record change; the timeline rebuilds collapse boundaries from it. */
export function getPluginUiDisclosureVersion(): number {
  return version;
}

export function subscribePluginUiDisclosure(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: clear all records. */
export function resetPluginUiDisclosureForTest(): void {
  pins.clear();
  listeners.clear();
  version = 0;
}
