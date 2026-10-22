import { useEffect, useState } from "react";
import type { IVoiceDictationService, VoiceDictationRuntimeState } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const EMPTY_RUNTIME_STATE: VoiceDictationRuntimeState = {
  loadedModelId: null,
  activeModelId: null,
  activePhase: null,
};
/** Poll cadence while the Host is busy (loading, transcribing, streaming) or this window retains activity. */
const ACTIVE_REFRESH_INTERVAL_MS = 1000;
/**
 * Poll cadence while the Host is idle. The voice service exposes no push event for runtime state, so
 * an idle view notices a warm-up or an idle unload within this delay.
 */
const IDLE_REFRESH_INTERVAL_MS = 10_000;

type RuntimeStateListener = (state: VoiceDictationRuntimeState) => void;

/**
 * One poller per renderer window, shared by every mounted composer and settings view: N views cost
 * one Host call per interval instead of N timers. It runs only while at least one view subscribes,
 * polls at the active or idle cadence (see nextRefreshDelayMs), and it notifies listeners only when
 * the snapshot fields change.
 */
const sharedPoller = {
  listeners: new Set<RuntimeStateListener>(),
  service: null as IVoiceDictationService | null,
  latest: EMPTY_RUNTIME_STATE,
  timer: undefined as number | undefined,
  /** Bumped on every start, stop and immediate poll; a poll started under an older generation never reschedules. */
  generation: 0,
  /** Window-local operations (for example a warm-up request in flight) that want the active cadence. */
  retainedActivity: 0,
};

function sameRuntimeState(a: VoiceDictationRuntimeState, b: VoiceDictationRuntimeState): boolean {
  return (
    a.loadedModelId === b.loadedModelId &&
    a.activeModelId === b.activeModelId &&
    a.activePhase === b.activePhase
  );
}

function nextRefreshDelayMs(): number {
  const busy = sharedPoller.retainedActivity > 0 || sharedPoller.latest.activePhase !== null;
  return busy ? ACTIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS;
}

async function pollOnce(generation: number): Promise<void> {
  if (sharedPoller.generation !== generation) return;
  const service = sharedPoller.service;
  // A hidden window skips the Host call and polls again once it is visible.
  if (service && !document.hidden) {
    try {
      const next = await service.getRuntimeState();
      if (sharedPoller.generation !== generation) return;
      if (!sameRuntimeState(sharedPoller.latest, next)) {
        sharedPoller.latest = next;
        for (const listener of sharedPoller.listeners) listener(next);
      }
    } catch (error) {
      logger.warn("voice model runtime state failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (sharedPoller.generation !== generation) return;
  sharedPoller.timer = window.setTimeout(() => {
    sharedPoller.timer = undefined;
    void pollOnce(generation);
  }, nextRefreshDelayMs());
}

/** Polls now and drops any scheduled poll, so the new cadence applies from this call. */
function pollNow(): void {
  if (sharedPoller.listeners.size === 0) return;
  if (sharedPoller.timer !== undefined) window.clearTimeout(sharedPoller.timer);
  sharedPoller.timer = undefined;
  sharedPoller.generation += 1;
  void pollOnce(sharedPoller.generation);
}

/**
 * Marks a window-local operation (such as a warm-up request) as active: the poll switches to the
 * active cadence and refreshes at once, so the status dot shows the load without waiting for the idle
 * interval. The Host snapshot stays the only source of what is loaded. Call the returned function
 * when the operation settles; it is safe to call twice.
 */
export function retainVoiceDictationRuntimeActivity(): () => void {
  sharedPoller.retainedActivity += 1;
  pollNow();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sharedPoller.retainedActivity -= 1;
  };
}

function subscribeRuntimeState(
  service: IVoiceDictationService,
  listener: RuntimeStateListener,
): () => void {
  sharedPoller.listeners.add(listener);
  sharedPoller.service = service;
  // A view that re-subscribes missed the changes made while it was off, and later polls equal the
  // shared snapshot, so it would never be notified. Replay the snapshot the poller holds now.
  listener(sharedPoller.latest);
  if (sharedPoller.listeners.size === 1) pollNow();
  return () => {
    sharedPoller.listeners.delete(listener);
    if (sharedPoller.listeners.size > 0) return;
    sharedPoller.generation += 1;
    if (sharedPoller.timer !== undefined) window.clearTimeout(sharedPoller.timer);
    sharedPoller.timer = undefined;
    sharedPoller.service = null;
    sharedPoller.latest = EMPTY_RUNTIME_STATE;
  };
}

/**
 * Polls the local model lifecycle while the owning view is mounted. `enabled: false` never calls the
 * Host; a hidden window skips the call and polls again once it is visible.
 */
export function useVoiceDictationRuntimeState({ enabled = true }: { enabled?: boolean } = {}) {
  const { voiceDictationService } = useServices();
  const [runtimeState, setRuntimeState] = useState(() => sharedPoller.latest);

  useEffect(() => {
    if (!enabled || !voiceDictationService) return undefined;
    return subscribeRuntimeState(voiceDictationService, (next) =>
      setRuntimeState((current) => (sameRuntimeState(current, next) ? current : next)),
    );
  }, [enabled, voiceDictationService]);

  return { runtimeState };
}
