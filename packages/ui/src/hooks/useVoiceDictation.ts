import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/toast.js";
import type { VoiceTranscriptionPreview } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useVoiceDictationRecordingAudio } from "@/hooks/useVoiceDictationRecordingAudio.js";
import { logger } from "@/logger.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { isShortcutRecordingActive, matchesShortcutBinding } from "@/shortcuts/bindings.js";
import { isVoiceShortcutReleased } from "@/lib/voiceDictationShortcut.js";
import {
  VOICE_MIN_RECORDING_MS,
  concatFloat32Chunks,
  float32ToPcm16Le,
  samplesToMilliseconds,
} from "@/lib/voiceDictationAudio.js";
import { VoiceDictationRecorder } from "@/lib/voiceDictationRecorder.js";

export type VoiceDictationPhase = "idle" | "loading" | "recording" | "transcribing";

/**
 * Backlog cap: about 30 seconds at 16 kHz mono. Under normal jitter the backlog stays far below
 * this (256ms/chunk); sustained excess means the Host is stuck, so fail explicitly per spec
 * instead of holding memory indefinitely while the user waits.
 */
const MAX_STREAM_BACKLOG_SAMPLES = 16_000 * 30;

interface UseVoiceDictationOptions {
  /** True only on desktop: transcription runs on the local Desktop Host; Web/remote provide no voice input. */
  enabled: boolean;
  /** Called with non-empty transcribed text; the caller decides where to insert it. */
  onTranscript: (text: string) => void;
  /** The shortcut is active only when this container has focus, so inputs in other panels cannot trigger recording. */
  scopeRef: RefObject<HTMLElement | null>;
}

/**
 * Voice dictation: record (microphone → 16 kHz PCM) → local transcription (services'
 * IVoiceDictationService) → callback insert. Recording state lives only in this hook; model and
 * device preferences are read from settings.voiceDictation.
 * Push-to-talk: hold the shortcut to record, release to finish; when off, press once to start and
 * press again to finish.
 */
export function useVoiceDictation({ enabled, onTranscript, scopeRef }: UseVoiceDictationOptions) {
  const { intl } = useZCodeIntl();
  const { voiceDictationService } = useServices();
  const { settings } = useSettings();
  const bindings = useEffectiveShortcutBindings();
  const voice = settings?.voiceDictation;
  const modelId = voice?.modelId ?? null;
  const microphoneDeviceId = voice?.microphoneDeviceId ?? null;
  const language = voice?.language ?? "auto";
  const pushToTalk = voice?.pushToTalk !== false;
  const idleUnloadMinutes = voice?.idleUnloadMinutes ?? 5;
  const muteWhileRecording = voice?.muteWhileRecording === true;
  const recordingAudio = useVoiceDictationRecordingAudio();

  const [phase, setPhase] = useState<VoiceDictationPhase>("idle");
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<VoiceTranscriptionPreview | null>(null);
  const [recorder] = useState(() => new VoiceDictationRecorder());
  const phaseRef = useRef<VoiceDictationPhase>("idle");
  const startedAtRef = useRef(0);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const streamQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** PCM chunks awaiting send; merged and sent by the serial flush task, so a transiently slow RPC versus the microphone only backs up and never fails. */
  const streamBacklogRef = useRef<Float32Array[]>([]);
  const streamFlushScheduledRef = useRef(false);
  const streamErrorRef = useRef<unknown>(null);
  const startGenerationRef = useRef(0);
  const heldBindingRef = useRef<string | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const updatePhase = useCallback((next: VoiceDictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const cancelServiceStream = useCallback(
    (streamId: string) => {
      void voiceDictationService?.cancelStream(streamId).catch((error: unknown) => {
        logger.warn("voice dictation stream cancellation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [voiceDictationService],
  );

  const failStream = useCallback(
    (streamId: string, error: unknown) => {
      if (streamIdRef.current !== streamId) return;
      streamErrorRef.current = error;
      streamIdRef.current = null;
      streamBacklogRef.current = [];
      recorder.cancel();
      // Recording aborted: release the mute silently (cancellation paths stay quiet per spec).
      void recordingAudio.releaseSystemMute();
      setLevel(0);
      setPreview(null);
      updatePhase("idle");
      logger.warn("voice dictation streaming failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "voiceDictation.transcribeFailed" }));
      cancelServiceStream(streamId);
    },
    [cancelServiceStream, intl, recorder, recordingAudio, updatePhase],
  );

  const flushStreamBacklog = useCallback(
    (streamId: string) => {
      if (!voiceDictationService) return;
      const next = streamQueueRef.current
        .then(async () => {
          // Reset the scheduling flag as soon as the task starts: chunks arriving after this can
          // queue again, keeping queue depth at most two.
          streamFlushScheduledRef.current = false;
          if (streamIdRef.current !== streamId || streamErrorRef.current) return;
          const backlog = streamBacklogRef.current;
          streamBacklogRef.current = [];
          if (backlog.length === 0) return;
          const batched = concatFloat32Chunks(backlog);
          const update = await voiceDictationService.feedStream(
            streamId,
            float32ToPcm16Le(batched),
          );
          if (streamIdRef.current === streamId) setPreview(update);
        })
        .catch((error: unknown) => failStream(streamId, error));
      streamQueueRef.current = next;
      streamFlushScheduledRef.current = true;
    },
    [failStream, voiceDictationService],
  );

  const enqueueStreamChunk = useCallback(
    (samples: Float32Array) => {
      const streamId = streamIdRef.current;
      if (!streamId || streamErrorRef.current || !voiceDictationService) return;
      // ScriptProcessor delivers chunks on a fixed cadence, so the RPC being briefly slower
      // (slow machines, scheduling jitter) is normal; hitting the cap previously called
      // failStream directly and discarded the whole recorded audio. Back up and batch-merge
      // instead; ordering is guaranteed by the single serial flush task.
      streamBacklogRef.current.push(samples);
      // Spec requires a "bounded ordered queue + explicit failure": exceeding the cap means the
      // Host persistently cannot consume, so terminate this dictation.
      const backlogSamples = streamBacklogRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
      if (backlogSamples > MAX_STREAM_BACKLOG_SAMPLES) {
        failStream(streamId, new Error("voice dictation stream exceeded its bounded PCM backlog"));
        return;
      }
      if (streamFlushScheduledRef.current) return;
      flushStreamBacklog(streamId);
    },
    [flushStreamBacklog, voiceDictationService],
  );

  const start = useCallback(async (): Promise<void> => {
    if (!enabled || phaseRef.current !== "idle" || recorder.isRecording) return;
    if (!voiceDictationService) return;
    if (!modelId) {
      toast(intl.formatMessage({ id: "voiceDictation.noModelSelected" }));
      return;
    }
    const generation = ++startGenerationRef.current;
    streamErrorRef.current = null;
    streamBacklogRef.current = [];
    streamFlushScheduledRef.current = false;
    streamQueueRef.current = Promise.resolve();
    setLevel(0);
    setPreview(null);
    updatePhase("loading");
    const pending = (async () => {
      let streamId: string | null;
      try {
        try {
          await voiceDictationService.setIdleUnloadMinutes(idleUnloadMinutes);
        } catch (error) {
          if (!isMissingIdleUnloadMethod(error)) throw error;
          // Older Desktop Hosts do not implement this preference RPC yet; keep the Host's default
          // unload time rather than blocking recording and transcription over it.
          logger.warn(
            "voice dictation host does not support idle unload preference; using host default",
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
        streamId = await voiceDictationService.beginStream({ modelId, language });
      } catch (error) {
        logger.warn("voice dictation model stream initialization failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (generation === startGenerationRef.current) {
          updatePhase("idle");
          toast(intl.formatMessage({ id: "voiceDictation.transcribeFailed" }));
        }
        return;
      }
      if (generation !== startGenerationRef.current) {
        if (streamId) cancelServiceStream(streamId);
        return;
      }
      streamIdRef.current = streamId;
      try {
        await recorder.start({
          deviceId: microphoneDeviceId,
          onLevel: setLevel,
          onChunk: enqueueStreamChunk,
          collectSamples: streamId === null,
        });
        if (generation !== startGenerationRef.current) {
          recorder.cancel();
          if (streamId) {
            streamIdRef.current = null;
            cancelServiceStream(streamId);
          }
          return;
        }
        startedAtRef.current = Date.now();
        updatePhase("recording");
        // Handy ordering: the readiness chime plays first and the system mute applies only after
        // it finishes, so the cue stays audible; a release that already happened (quick tap,
        // blur) must not mute a recording that no longer exists.
        const chime = recordingAudio.playStartChime();
        if (muteWhileRecording) {
          void chime.then(() => {
            if (generation !== startGenerationRef.current || phaseRef.current !== "recording") {
              return;
            }
            recordingAudio.applySystemMute();
          });
        }
      } catch (error) {
        recorder.cancel();
        streamIdRef.current = null;
        if (streamId) cancelServiceStream(streamId);
        setLevel(0);
        setPreview(null);
        if (generation === startGenerationRef.current) {
          updatePhase("idle");
          logger.warn("voice dictation microphone unavailable", {
            error: error instanceof Error ? error.message : String(error),
          });
          toast(intl.formatMessage({ id: "voiceDictation.microphoneFailed" }));
        }
      }
    })();
    startPromiseRef.current = pending;
    await pending;
  }, [
    cancelServiceStream,
    enabled,
    enqueueStreamChunk,
    intl,
    idleUnloadMinutes,
    language,
    microphoneDeviceId,
    modelId,
    muteWhileRecording,
    recorder,
    recordingAudio,
    updatePhase,
    voiceDictationService,
  ]);

  const stop = useCallback(async (): Promise<void> => {
    // When released quickly after a press, recording may still be waiting for microphone
    // authorization; wait for it to be ready before finishing so the release is not lost.
    await startPromiseRef.current;
    startPromiseRef.current = null;
    if (!recorder.isRecording) return;
    const generation = startGenerationRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    const samples = recorder.stop();
    setLevel(0);
    // Release the system mute before the stop chime so the chime is not swallowed by the mute.
    recordingAudio.handleRecordingStopped();
    const streamId = streamIdRef.current;
    if (
      durationMs < VOICE_MIN_RECORDING_MS ||
      (!streamId && samples.length === 0) ||
      !voiceDictationService
    ) {
      streamIdRef.current = null;
      if (streamId) cancelServiceStream(streamId);
      setPreview(null);
      updatePhase("idle");
      return;
    }
    updatePhase("transcribing");
    try {
      let result;
      if (streamId) {
        await streamQueueRef.current;
        if (streamErrorRef.current) throw streamErrorRef.current;
        result = await voiceDictationService.finalizeStream(streamId);
        streamIdRef.current = null;
      } else {
        result = await voiceDictationService.transcribe({
          modelId: modelId ?? "",
          pcm: float32ToPcm16Le(samples),
          language,
        });
      }
      const text = result.text.trim();
      if (text && generation === startGenerationRef.current) onTranscriptRef.current(text);
    } catch (error) {
      if (streamId && streamIdRef.current === streamId) {
        streamIdRef.current = null;
        cancelServiceStream(streamId);
      }
      logger.warn("voice dictation transcription failed", {
        durationMs: samplesToMilliseconds(samples.length),
        error: error instanceof Error ? error.message : String(error),
      });
      if (!streamErrorRef.current) {
        toast(intl.formatMessage({ id: "voiceDictation.transcribeFailed" }));
      }
    } finally {
      streamIdRef.current = null;
      streamBacklogRef.current = [];
      setPreview(null);
      updatePhase("idle");
    }
  }, [
    cancelServiceStream,
    intl,
    language,
    modelId,
    recorder,
    recordingAudio,
    updatePhase,
    voiceDictationService,
  ]);

  const toggle = useCallback(async (): Promise<void> => {
    if (recorder.isRecording) {
      await stop();
    } else {
      await start();
    }
  }, [recorder, start, stop]);

  useEffect(() => {
    if (!enabled) return;
    const isInScope = (target: EventTarget | null) => {
      const scope = scopeRef.current;
      return Boolean(scope && target instanceof Node && scope.contains(target));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isShortcutRecordingActive() || !isInScope(event.target)) return;
      const binding = bindings.voiceDictation.find((candidate) =>
        matchesShortcutBinding(event, candidate),
      );
      if (!binding) return;
      event.preventDefault();
      if (event.repeat) return;
      if (pushToTalk) {
        heldBindingRef.current = binding;
        void start();
      } else {
        void toggle();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      const held = heldBindingRef.current;
      if (!held || !isVoiceShortcutReleased(event, held)) return;
      heldBindingRef.current = null;
      void stop();
    };
    const handleBlur = () => {
      // Key release during window blur produces no keyup; cancel recording directly to avoid
      // recording forever.
      heldBindingRef.current = null;
      if (phaseRef.current === "loading" || recorder.isRecording) {
        startGenerationRef.current += 1;
        recorder.cancel();
        void recordingAudio.releaseSystemMute();
        setLevel(0);
        setPreview(null);
        updatePhase("idle");
        const streamId = streamIdRef.current;
        streamIdRef.current = null;
        streamBacklogRef.current = [];
        if (streamId) {
          void streamQueueRef.current
            .then(() => voiceDictationService?.cancelStream(streamId))
            .catch((error: unknown) => {
              logger.warn("voice dictation stream cancellation failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [
    bindings.voiceDictation,
    enabled,
    pushToTalk,
    recorder,
    recordingAudio,
    scopeRef,
    start,
    stop,
    toggle,
    updatePhase,
    voiceDictationService,
  ]);

  useEffect(
    () => () => {
      startGenerationRef.current += 1;
      recorder.cancel();
      void recordingAudio.releaseSystemMute();
      const streamId = streamIdRef.current;
      streamIdRef.current = null;
      streamBacklogRef.current = [];
      if (streamId) {
        void streamQueueRef.current
          .then(() => voiceDictationService?.cancelStream(streamId))
          .catch((error: unknown) => {
            logger.warn("voice dictation stream cancellation failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    },
    [recorder, recordingAudio, voiceDictationService],
  );

  return { phase, level, preview, start, stop, toggle };
}

function isMissingIdleUnloadMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "Method not found: setIdleUnloadMinutes";
}
