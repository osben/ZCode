import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { isShortcutRecordingActive, matchesShortcutBinding } from "@/shortcuts/bindings.js";
import { isVoiceShortcutReleased } from "@/lib/voiceDictationShortcut.js";
import {
  VOICE_MIN_RECORDING_MS,
  float32ToPcm16Le,
  samplesToMilliseconds,
} from "@/lib/voiceDictationAudio.js";
import { VoiceDictationRecorder } from "@/lib/voiceDictationRecorder.js";

export type VoiceDictationPhase = "idle" | "recording" | "transcribing";

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

  const [phase, setPhase] = useState<VoiceDictationPhase>("idle");
  const [level, setLevel] = useState(0);
  const [recorder] = useState(() => new VoiceDictationRecorder());
  const phaseRef = useRef<VoiceDictationPhase>("idle");
  const startedAtRef = useRef(0);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const heldBindingRef = useRef<string | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const updatePhase = useCallback((next: VoiceDictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (!enabled || phaseRef.current !== "idle" || recorder.isRecording) return;
    if (!voiceDictationService) return;
    if (!modelId) {
      toast(intl.formatMessage({ id: "voiceDictation.noModelSelected" }));
      return;
    }
    const pending = recorder
      .start({ deviceId: microphoneDeviceId, onLevel: setLevel })
      .then(() => {
        startedAtRef.current = Date.now();
        updatePhase("recording");
      })
      .catch((error: unknown) => {
        logger.warn("voice dictation microphone unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "voiceDictation.microphoneFailed" }));
      });
    startPromiseRef.current = pending;
    await pending;
  }, [enabled, intl, microphoneDeviceId, modelId, recorder, updatePhase, voiceDictationService]);

  const stop = useCallback(async (): Promise<void> => {
    // 按住后很快松开时，录音可能还在等待麦克风授权；等它就绪后再结束，保证松开的动作不丢失。
    await startPromiseRef.current;
    startPromiseRef.current = null;
    if (!recorder.isRecording) return;
    const durationMs = Date.now() - startedAtRef.current;
    const samples = recorder.stop();
    setLevel(0);
    if (durationMs < VOICE_MIN_RECORDING_MS || samples.length === 0 || !voiceDictationService) {
      updatePhase("idle");
      return;
    }
    updatePhase("transcribing");
    try {
      const result = await voiceDictationService.transcribe({
        modelId: modelId ?? "",
        pcm: float32ToPcm16Le(samples),
        language,
      });
      const text = result.text.trim();
      if (text) onTranscriptRef.current(text);
    } catch (error) {
      logger.warn("voice dictation transcription failed", {
        durationMs: samplesToMilliseconds(samples.length),
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "voiceDictation.transcribeFailed" }));
    } finally {
      updatePhase("idle");
    }
  }, [intl, language, modelId, recorder, updatePhase, voiceDictationService]);

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
      if (recorder.isRecording) {
        recorder.cancel();
        setLevel(0);
        updatePhase("idle");
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
  ]);

  useEffect(() => () => recorder.cancel(), [recorder]);

  return { phase, level, start, stop, toggle };
}
