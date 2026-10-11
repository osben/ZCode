import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/toast.js";
import type { VoiceTranscriptionPreview } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
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

interface UseVoiceDictationOptions {
  /** 仅桌面端为 true：转写由本机 Desktop Host 执行，Web/远端不提供语音输入。 */
  enabled: boolean;
  /** 转写得到非空文本时回调，由调用方决定插入位置。 */
  onTranscript: (text: string) => void;
  /** 快捷键只在该容器内有焦点时生效，避免其他面板的输入触发录音。 */
  scopeRef: RefObject<HTMLElement | null>;
}

/**
 * 语音输入：录音（麦克风 → 16 kHz PCM）→ 本机转写（services 的 IVoiceDictationService）→ 回调插入。
 * 录音状态只在本 hook 持有；模型与设备偏好读取自 settings.voiceDictation。
 * push-to-talk：按住快捷键录音，松开结束；关闭时按一下开始、再按一下结束。
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

  const [phase, setPhase] = useState<VoiceDictationPhase>("idle");
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<VoiceTranscriptionPreview | null>(null);
  const [recorder] = useState(() => new VoiceDictationRecorder());
  const phaseRef = useRef<VoiceDictationPhase>("idle");
  const startedAtRef = useRef(0);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const streamQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** 待发送的 PCM 块；由串行 flush 任务合并发送，RPC 短暂慢于麦克风时只积压、不失败。 */
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
      setLevel(0);
      setPreview(null);
      updatePhase("idle");
      logger.warn("voice dictation streaming failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "voiceDictation.transcribeFailed" }));
      cancelServiceStream(streamId);
    },
    [cancelServiceStream, intl, recorder, updatePhase],
  );

  const flushStreamBacklog = useCallback(
    (streamId: string) => {
      if (!voiceDictationService) return;
      const next = streamQueueRef.current
        .then(async () => {
          // 任务开始即复位调度标记：此后送来的新块可以再次排队，队列深度因此不超过两条。
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
      // ScriptProcessor 固定周期送块，RPC 短暂变慢（慢机器、调度抖动）属正常现象；
      // 之前达到上限直接 failStream 会丢掉整段已录语音，这里改为积压成批合并发送，
      // 顺序由单一串行 flush 任务保证。
      streamBacklogRef.current.push(samples);
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
          // 旧 Desktop Host 尚未实现此偏好 RPC；保留 Host 默认卸载时间，不能因此阻止录音和转写。
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
    recorder,
    updatePhase,
    voiceDictationService,
  ]);

  const stop = useCallback(async (): Promise<void> => {
    // 按住后很快松开时，录音可能还在等待麦克风授权；等它就绪后再结束，保证松开的动作不丢失。
    await startPromiseRef.current;
    startPromiseRef.current = null;
    if (!recorder.isRecording) return;
    const generation = startGenerationRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    const samples = recorder.stop();
    setLevel(0);
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
  }, [cancelServiceStream, intl, language, modelId, recorder, updatePhase, voiceDictationService]);

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
      // 窗口失焦时松开键不会收到 keyup；直接取消录音，避免一直录音。
      heldBindingRef.current = null;
      if (phaseRef.current === "loading" || recorder.isRecording) {
        startGenerationRef.current += 1;
        recorder.cancel();
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
    [recorder, voiceDictationService],
  );

  return { phase, level, preview, start, stop, toggle };
}

function isMissingIdleUnloadMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "Method not found: setIdleUnloadMinutes";
}
