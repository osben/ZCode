import type { IVoiceDictationService } from "@zcode/services";
import type { VoiceModelIdleUnloadMinutes } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * Applies the idle-unload preference to the Host. An older Desktop Host without the RPC keeps its
 * default unload delay (logged), because that preference must never block recording or warm-up;
 * every other failure propagates to the caller.
 */
export async function applyIdleUnloadPreference(
  service: IVoiceDictationService,
  minutes: VoiceModelIdleUnloadMinutes,
): Promise<void> {
  try {
    await service.setIdleUnloadMinutes(minutes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.trim() !== "Method not found: setIdleUnloadMinutes") throw error;
    logger.warn(
      "voice dictation host does not support idle unload preference; using host default",
      { error: message },
    );
  }
}
