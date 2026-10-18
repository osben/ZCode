import { useCallback, type RefObject } from "react";
import { useDictationTranscriptHandler } from "@/hooks/useDictationTranscriptHandler.js";
import { useVoiceModelWarmUp } from "@/hooks/useVoiceModelWarmUp.js";
import { useVoiceDictation } from "@/hooks/useVoiceDictation.js";
import { useWebSpeechDictation } from "@/hooks/useWebSpeechDictation.js";
import { V4ComposerVoiceButton } from "@/v4/composer/V4ComposerVoiceButton.js";

/**
 * Engine selection for the composer voice entry. Web remote control transcribes in the browser
 * (Web Speech API); desktop keeps the Host whisper engine with byte-identical behavior (enabled
 * stays true there). Both engines expose the same control surface and deliver text through the
 * same onTranscript insertion path, so a future engine (e.g. host-whisper over the relay) plugs in
 * here without button or insertion changes.
 */
export function V4ComposerDictationControl({
  disabled,
  onTranscript,
  scopeRef,
  webRemote,
}: {
  disabled: boolean;
  onTranscript: (text: string) => void;
  scopeRef: RefObject<HTMLElement | null>;
  webRemote: boolean;
}) {
  const handleTranscript = useDictationTranscriptHandler(onTranscript);
  const webSpeech = useWebSpeechDictation({ enabled: webRemote, onTranscript: handleTranscript });
  const voiceDictation = useVoiceDictation({
    enabled: !webRemote,
    onTranscript: handleTranscript,
    scopeRef,
  });
  useVoiceModelWarmUp({ enabled: !webRemote, scopeRef });
  const engine = webRemote ? webSpeech : voiceDictation;
  // V4ComposerVoiceButton is a memo component; an inline arrow function would defeat the memo (see the reactStableReferences tests).
  const handleToggle = useCallback(() => void engine.toggle(), [engine.toggle]);
  if (webRemote && !webSpeech.supported) {
    // Web Speech API missing (e.g. Firefox): hide the entry instead of showing a dead control.
    return null;
  }
  return (
    <V4ComposerVoiceButton
      phase={engine.phase}
      level={engine.level}
      preview={engine.preview}
      loadingLabelId={webRemote ? "voiceDictation.composer.starting" : undefined}
      disabled={disabled}
      onToggle={handleToggle}
      onCancel={engine.cancel}
    />
  );
}
