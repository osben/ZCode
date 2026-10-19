import type { VoiceDictationSettings, VoiceModelIdleUnloadMinutes } from "@zcode/shared";

/** Built-in default for an absent idle-unload delay (specs/voice-dictation.md, "Live recording"/"Memory"). */
export const DEFAULT_IDLE_UNLOAD_MINUTES: VoiceModelIdleUnloadMinutes = 5;
/** Built-in default chime volume, integer percent. */
export const DEFAULT_FEEDBACK_VOLUME = 70;

export interface ResolvedVoiceDictationPreferences {
  pushToTalk: boolean;
  idleUnloadMinutes: VoiceModelIdleUnloadMinutes;
  feedbackSounds: boolean;
  feedbackVolume: number;
  muteWhileRecording: boolean;
  copyToClipboard: boolean;
  warmUpOnFocus: boolean;
}

/**
 * Effective voice-dictation preferences. The single owner of default values: an absent key means its
 * default, and the opt-out flags (`pushToTalk`, `muteWhileRecording`, `warmUpOnFocus`) are on unless
 * explicitly `false`, while the opt-in flags (`feedbackSounds`, `copyToClipboard`) are off unless
 * explicitly `true`.
 */
export function resolveVoiceDictationPreferences(
  voice: VoiceDictationSettings | undefined,
): ResolvedVoiceDictationPreferences {
  return {
    pushToTalk: voice?.pushToTalk !== false,
    idleUnloadMinutes: voice?.idleUnloadMinutes ?? DEFAULT_IDLE_UNLOAD_MINUTES,
    feedbackSounds: voice?.feedbackSounds === true,
    feedbackVolume: voice?.feedbackVolume ?? DEFAULT_FEEDBACK_VOLUME,
    muteWhileRecording: voice?.muteWhileRecording !== false,
    copyToClipboard: voice?.copyToClipboard === true,
    warmUpOnFocus: voice?.warmUpOnFocus !== false,
  };
}
