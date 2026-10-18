import type { VoiceDictationRuntimeState } from "@zcode/services";

/** Status of the selected dictation model as shown on the composer microphone button. */
export type VoiceModelStatus = "none" | "idle" | "loading" | "loaded";

/**
 * Derives the selected model's status from the Host runtime snapshot. A loaded model that is not the
 * selected one counts as idle: the dot always refers to the user's current selection.
 */
export function deriveVoiceModelStatus(
  runtimeState: VoiceDictationRuntimeState,
  selectedModelId: string | null,
): VoiceModelStatus {
  if (!selectedModelId) return "none";
  if (runtimeState.activeModelId === selectedModelId && runtimeState.activePhase === "loading") {
    return "loading";
  }
  if (runtimeState.loadedModelId === selectedModelId) return "loaded";
  return "idle";
}
