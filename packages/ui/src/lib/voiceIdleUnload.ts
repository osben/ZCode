import type { IVoiceDictationService } from "@zcode/services";
import type { VoiceModelIdleUnloadMinutes } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * Last preference applied, per Host service object (module scope, so one renderer window). The Host
 * keeps the delay in memory only, so a Host that restarts behind the same service object is not
 * re-applied until the value changes; see specs/voice-dictation.md.
 */
let lastApplied: { service: IVoiceDictationService; minutes: VoiceModelIdleUnloadMinutes } | null =
  null;

/**
 * Tail of the apply queue per Host service object. Applies run one at a time, so the dedupe check
 * always compares against the value the previous apply actually sent, never against a pending one.
 */
const applyQueues = new WeakMap<IVoiceDictationService, Promise<void>>();

/** Test seam: forgets the last applied preference so each test starts with a fresh Host state. */
export function resetIdleUnloadPreferenceForTests(): void {
  lastApplied = null;
}

/**
 * Applies the idle-unload preference to the Host. An older Desktop Host without the RPC keeps its
 * default unload delay (logged), because that preference must never block recording or warm-up;
 * every other failure propagates to the caller. An unchanged value is not sent again.
 */
export function applyIdleUnloadPreference(
  service: IVoiceDictationService,
  minutes: VoiceModelIdleUnloadMinutes,
): Promise<void> {
  const previous = applyQueues.get(service) ?? Promise.resolve();
  const next = previous.then(() => sendIdleUnloadPreference(service, minutes));
  // The stored tail never rejects, so one failed apply does not stall the applies queued behind it.
  applyQueues.set(
    service,
    next.catch(() => undefined),
  );
  return next;
}

async function sendIdleUnloadPreference(
  service: IVoiceDictationService,
  minutes: VoiceModelIdleUnloadMinutes,
): Promise<void> {
  if (lastApplied?.service === service && lastApplied.minutes === minutes) return;
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
  lastApplied = { service, minutes };
}
