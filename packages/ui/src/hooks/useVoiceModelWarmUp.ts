import { useEffect, useRef, type RefObject } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";

/** One request per model per window: refocusing the composer must not hammer the Host. */
const WARM_UP_THROTTLE_MS = 30_000;

interface UseVoiceModelWarmUpOptions {
  /** Desktop-local dictation only; Web remote control and hosts without the voice service never warm up. */
  enabled: boolean;
  /** Focus entering this container (the composer) triggers the warm-up. */
  scopeRef: RefObject<HTMLElement | null>;
}

function isMissingMethod(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === `Method not found: ${method}`;
}

/**
 * Loads the selected transcription model in the background when the composer gains focus, so the
 * first recording does not wait for it (spec: Model warm-up on composer focus). Best-effort: every
 * failure is logged and swallowed, the recording path still loads the model on demand.
 */
export function useVoiceModelWarmUp({ enabled, scopeRef }: UseVoiceModelWarmUpOptions) {
  const { voiceDictationService } = useServices();
  const { settings } = useSettings();
  const voice = settings?.voiceDictation;
  const modelId = voice?.modelId ?? null;
  const idleUnloadMinutes = voice?.idleUnloadMinutes ?? 5;
  const warmUpOnFocus = voice?.warmUpOnFocus !== false;

  const lastRequestRef = useRef<{ modelId: string; at: number } | null>(null);
  const inFlightRef = useRef(false);
  /** An older Host without the method: stop asking for the rest of the session. */
  const hostUnsupportedRef = useRef(false);

  useEffect(() => {
    const scope = scopeRef.current;
    if (!enabled || !voiceDictationService || !warmUpOnFocus || !modelId || !scope) return;

    const warmUp = async () => {
      if (hostUnsupportedRef.current || inFlightRef.current) return;
      const last = lastRequestRef.current;
      const now = Date.now();
      if (last && last.modelId === modelId && now - last.at < WARM_UP_THROTTLE_MS) return;
      inFlightRef.current = true;
      lastRequestRef.current = { modelId, at: now };
      try {
        try {
          await voiceDictationService.setIdleUnloadMinutes(idleUnloadMinutes);
        } catch (error) {
          if (!isMissingMethod(error, "setIdleUnloadMinutes")) throw error;
        }
        await voiceDictationService.warmUp({ modelId });
      } catch (error) {
        if (isMissingMethod(error, "warmUp")) {
          hostUnsupportedRef.current = true;
          logger.info("voice dictation host does not support model warm-up");
        } else {
          logger.warn("voice model warm-up failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        inFlightRef.current = false;
      }
    };

    scope.addEventListener("focusin", warmUp);
    if (scope.contains(document.activeElement)) void warmUp();
    return () => scope.removeEventListener("focusin", warmUp);
  }, [enabled, idleUnloadMinutes, modelId, scopeRef, voiceDictationService, warmUpOnFocus]);
}
