import { useSettings } from "@/hooks/useSettingService.js";
import { useVoiceDictationRuntimeState } from "@/hooks/useVoiceDictationRuntimeState.js";
import { deriveVoiceModelStatus, type VoiceModelStatus } from "@/lib/voiceModelStatus.js";

/** Status of the selected dictation model (loading / loaded / idle), polled from the Desktop Host. */
export function useVoiceModelStatus({ enabled }: { enabled: boolean }): VoiceModelStatus {
  const { settings } = useSettings();
  const { runtimeState } = useVoiceDictationRuntimeState({ enabled });
  if (!enabled) return "none";
  return deriveVoiceModelStatus(runtimeState, settings?.voiceDictation?.modelId ?? null);
}
