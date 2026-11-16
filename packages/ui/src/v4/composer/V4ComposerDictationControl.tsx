import { useCallback, useEffect, type RefObject } from "react";
import type { VoiceTranscriptionPreview } from "@zcode/services";
import { useDictationTranscriptHandler } from "@/hooks/useDictationTranscriptHandler.js";
import { useVoiceModelStatus } from "@/hooks/useVoiceModelStatus.js";
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
  onPreviewChange,
  scopeRef,
  webRemote,
  registerStopHandler,
}: {
  disabled: boolean;
  onTranscript: (text: string) => void;
  /** Receives the streaming ghost preview (null when none); the editor draws it, never the document. */
  onPreviewChange?: (preview: VoiceTranscriptionPreview | null) => void;
  scopeRef: RefObject<HTMLElement | null>;
  webRemote: boolean;
  /** Receives the engine's stop so the editor can soft-finish on user typing. */
  registerStopHandler?: (stop: () => void) => void;
}) {
  const handleTranscript = useDictationTranscriptHandler(onTranscript);
  const webSpeech = useWebSpeechDictation({ enabled: webRemote, onTranscript: handleTranscript });
  const voiceDictation = useVoiceDictation({
    enabled: !webRemote,
    onTranscript: handleTranscript,
    scopeRef,
  });
  useVoiceModelWarmUp({ enabled: !webRemote, scopeRef });
  const modelStatus = useVoiceModelStatus({ enabled: !webRemote });
  const engine = webRemote ? webSpeech : voiceDictation;
  const enginePreview = engine.preview;
  // Hand the preview to the editor layer. No null on cleanup between previews: the span must be
  // UPDATED in place, not cancelled and recreated at whatever caret position follows (a real null
  // arrives whenever the engine itself reports no preview, which cancels the span).
  useEffect(() => {
    onPreviewChange?.(enginePreview);
  }, [enginePreview, onPreviewChange]);
  // V4ComposerVoiceButton is a memo component; an inline arrow function would defeat the memo (see the reactStableReferences tests).
  const handleToggle = useCallback(() => void engine.toggle(), [engine.toggle]);
  useEffect(() => {
    registerStopHandler?.(() => void engine.stop());
  }, [engine.stop, registerStopHandler]);
  if (webRemote && !webSpeech.supported) {
    // Web Speech API missing (e.g. Firefox): hide the entry instead of showing a dead control.
    return null;
  }
  return (
    <V4ComposerVoiceButton
      phase={engine.phase}
      subscribeLevel={engine.subscribeLevel}
      loadingLabelId={webRemote ? "voiceDictation.composer.starting" : undefined}
      disabled={disabled}
      onToggle={handleToggle}
      modelStatus={modelStatus}
      permissionGuide={voiceDictation.permissionGuide}
      onReauthorizeMicrophone={() => void voiceDictation.reauthorizeMicrophone()}
      onDismissPermissionGuide={voiceDictation.dismissPermissionGuide}
    />
  );
}
