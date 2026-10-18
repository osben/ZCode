import { useEffect, useState } from "react";
import type { VoiceDictationRuntimeState } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const EMPTY_RUNTIME_STATE: VoiceDictationRuntimeState = {
  loadedModelId: null,
  activeModelId: null,
  activePhase: null,
};
const REFRESH_INTERVAL_MS = 1000;

/**
 * Polls the local model lifecycle while the owning view is mounted. `enabled: false` never calls the
 * Host; a hidden window skips the call and polls again once it is visible.
 */
export function useVoiceDictationRuntimeState({ enabled = true }: { enabled?: boolean } = {}) {
  const { voiceDictationService } = useServices();
  const [runtimeState, setRuntimeState] = useState(EMPTY_RUNTIME_STATE);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timeout: number | undefined;
    const poll = async () => {
      if (voiceDictationService && !document.hidden) {
        try {
          setRuntimeState(await voiceDictationService.getRuntimeState());
        } catch (error) {
          logger.warn("voice model runtime state failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (disposed) return;
      timeout = window.setTimeout(poll, REFRESH_INTERVAL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [enabled, voiceDictationService]);

  return { runtimeState };
}
