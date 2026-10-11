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

/** Polls local model lifecycle while its settings view is mounted. */
export function useVoiceDictationRuntimeState() {
  const { voiceDictationService } = useServices();
  const [runtimeState, setRuntimeState] = useState(EMPTY_RUNTIME_STATE);

  useEffect(() => {
    let disposed = false;
    let timeout: number | undefined;
    const poll = async () => {
      if (voiceDictationService) {
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
  }, [voiceDictationService]);

  return { runtimeState };
}
