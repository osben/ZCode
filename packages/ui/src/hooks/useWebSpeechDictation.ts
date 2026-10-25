import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { resolveEngineLanguage, type VoiceTranscriptionPreview } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useVoiceDictationEscapeCancel } from "@/hooks/useVoiceDictationEscapeCancel.js";
import { logger } from "@/logger.js";
import type { VoiceDictationPhase } from "@/hooks/useVoiceDictation.js";
import {
  WebSpeechDictationEngine,
  getSpeechRecognitionConstructor,
} from "@/lib/webSpeechDictation.js";

interface UseWebSpeechDictationOptions {
  /** True only in web remote control mode; the desktop client keeps the Host whisper engine. */
  enabled: boolean;
  /** Called with non-empty transcribed text; the caller decides where to insert it (same contract as useVoiceDictation). */
  onTranscript: (text: string) => void;
}

/**
 * Web remote dictation: browser-native SpeechRecognition → onTranscript insert. Audio is captured
 * and transcribed inside the browser (Chrome/Edge cloud-backed, Safari via Apple), never routed
 * through the Desktop Host whisper service. Returns the same control surface as useVoiceDictation
 * plus `supported`, which stays false where the Web Speech API is missing so the entry stays hidden.
 * No keyboard shortcut/push-to-talk on web: the composer button is the only trigger.
 */
export function useWebSpeechDictation({ enabled, onTranscript }: UseWebSpeechDictationOptions) {
  const { intl } = useZCodeIntl();
  const { settings } = useSettings();
  // "auto" (whisper auto-detect, or several selected languages) has no SpeechRecognition equivalent:
  // leave lang empty so the browser picks its default, instead of forcing a possibly wrong locale.
  const engineLanguage = resolveEngineLanguage(settings?.voiceDictation ?? {});
  const speechLanguage = engineLanguage === "auto" ? null : engineLanguage;
  const [supported] = useState(() => getSpeechRecognitionConstructor() !== null);
  const [phase, setPhase] = useState<VoiceDictationPhase>("idle");
  const [preview, setPreview] = useState<VoiceTranscriptionPreview | null>(null);
  const [engine] = useState(() => new WebSpeechDictationEngine());
  const phaseRef = useRef<VoiceDictationPhase>("idle");
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const updatePhase = useCallback((next: VoiceDictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const handleEngineError = useCallback(
    (code: SpeechRecognitionErrorCode) => {
      // "no-speech" is the browser ending a silent session (web equivalent of the desktop
      // minimum-duration guard); "aborted" follows a stop/abort, and any finals still arrive
      // through onSessionEnd. Neither is a failure worth a toast.
      if (code === "no-speech" || code === "aborted") {
        logger.info("web speech dictation ended early", { code });
        return;
      }
      logger.warn("web speech dictation error", { code });
      const messageId =
        code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture"
          ? "voiceDictation.microphoneFailed"
          : "voiceDictation.transcribeFailed";
      toast(intl.formatMessage({ id: messageId }));
    },
    [intl],
  );

  const start = useCallback((): void => {
    if (!enabled || !supported || phaseRef.current !== "idle" || engine.isListening) return;
    setPreview(null);
    updatePhase("loading");
    try {
      engine.start({
        language: speechLanguage,
        onSessionStart: () => {
          if (phaseRef.current === "loading") updatePhase("recording");
        },
        onPreview: (update) => {
          if (phaseRef.current === "recording") setPreview(update);
        },
        onError: handleEngineError,
        onSessionEnd: (transcript, reason) => {
          if (reason === "aborted" || !mountedRef.current) return;
          setPreview(null);
          updatePhase("idle");
          if (transcript) onTranscriptRef.current(transcript);
        },
      });
    } catch (error) {
      // Construction/start rejections must not strand the UI in the loading phase.
      logger.warn("web speech dictation failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
      setPreview(null);
      updatePhase("idle");
      toast(intl.formatMessage({ id: "voiceDictation.transcribeFailed" }));
    }
  }, [enabled, engine, handleEngineError, speechLanguage, supported, updatePhase]);

  const stop = useCallback((): void => {
    // The engine settles through onSessionEnd (phase → idle, transcript insert) once the
    // recognizer flushes its pending finals.
    engine.stop();
  }, [engine]);

  /** Aborts the session without inserting anything; the engine drops accumulated finals on abort. */
  const cancel = useCallback((): void => {
    if (phaseRef.current === "idle") return;
    engine.cancel();
    setPreview(null);
    updatePhase("idle");
  }, [engine, updatePhase]);

  const toggle = useCallback((): void => {
    if (phaseRef.current === "idle") {
      start();
    } else {
      stop();
    }
  }, [start, stop]);

  useVoiceDictationEscapeCancel(
    enabled && supported,
    () => phaseRef.current === "loading" || phaseRef.current === "recording",
    cancel,
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
      engine.cancel();
    },
    [engine],
  );

  // SpeechRecognition exposes no audio level; 0 keeps the shared button's meter at its baseline.
  return { supported, phase, level: 0, preview, start, stop, cancel, toggle };
}
