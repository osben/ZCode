import { useEffect, useState } from "react";
import type { IVoiceDictationService, VoiceDictationRuntimeState } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const EMPTY_RUNTIME_STATE: VoiceDictationRuntimeState = {
  loadedModelId: null,
  activeModelId: null,
  activePhase: null,
};
const REFRESH_INTERVAL_MS = 1000;

type RuntimeStateListener = (state: VoiceDictationRuntimeState) => void;

/**
 * One poller per renderer window, shared by every mounted composer and settings view: N views cost
 * one Host call per interval instead of N timers. It runs only while at least one view subscribes,
 * and it notifies listeners only when the snapshot fields change.
 */
const sharedPoller = {
  listeners: new Set<RuntimeStateListener>(),
  service: null as IVoiceDictationService | null,
  latest: EMPTY_RUNTIME_STATE,
  timer: undefined as number | undefined,
  /** Bumped on every start and stop; a poll started under an older generation never reschedules. */
  generation: 0,
};

function sameRuntimeState(a: VoiceDictationRuntimeState, b: VoiceDictationRuntimeState): boolean {
  return (
    a.loadedModelId === b.loadedModelId &&
    a.activeModelId === b.activeModelId &&
    a.activePhase === b.activePhase
  );
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
  }, REFRESH_INTERVAL_MS);
}

function subscribeRuntimeState(
  service: IVoiceDictationService,
  listener: RuntimeStateListener,
): () => void {
  sharedPoller.listeners.add(listener);
  sharedPoller.service = service;
  if (sharedPoller.listeners.size === 1) {
    sharedPoller.generation += 1;
    void pollOnce(sharedPoller.generation);
  }
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
