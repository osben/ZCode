import { useCallback, useMemo, useRef } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import { playVoiceDictationFeedbackSound } from "@/lib/voiceDictationFeedbackSound.js";

/**
 * Audio feedback and system-mute side channel for voice dictation (spec:
 * docs/ui/voice-dictation-feedback-sounds.md). Reads the feedbackSounds / feedbackVolume /
 * muteWhileRecording preferences and owns the serialized system-mute request chain; the recording
 * hook decides when each piece fires and guards the late mute apply against stale recordings.
 */
export function useVoiceDictationRecordingAudio() {
  const platform = useOptionalPlatform();
  const { settings } = useSettings();
  const voice = settings?.voiceDictation;
  const feedbackSounds = voice?.feedbackSounds === true;
  const feedbackVolume = voice?.feedbackVolume ?? 70;
  const muteWhileRecording = voice?.muteWhileRecording === true;

  /** Whether this renderer requested the system output mute and has not released it yet. */
  const systemMuteActiveRef = useRef(false);
  /** Tail of the serialized system-mute requests; IPC order must match call order (see requestSystemMute). */
  const systemMuteChainRef = useRef<Promise<void>>(Promise.resolve());
  // Latest values for stable callbacks, refreshed during render (same pattern as onTranscriptRef).
  const currentRef = useRef({ platform, feedbackSounds, feedbackVolume, muteWhileRecording });
  currentRef.current = { platform, feedbackSounds, feedbackVolume, muteWhileRecording };

  /**
   * Serialized system-mute requests through the platform capability. The order of IPC calls must
   * match the order of decisions made here, otherwise a release could be overtaken by a
   * still-pending apply and the output would stay muted with no owner left. The returned promise
   * resolves after main finished the OS-level change, so the stop chime can wait for audibility.
   */
  const requestSystemMute = useCallback((active: boolean): Promise<void> => {
    const currentPlatform = currentRef.current.platform;
    const request = currentPlatform?.setDictationSystemMute?.bind(currentPlatform);
    if (!request) return Promise.resolve();
    const next = systemMuteChainRef.current
      .then(() => {
        if (active) {
          systemMuteActiveRef.current = true;
          return request(true);
        }
        if (!systemMuteActiveRef.current) return undefined;
        systemMuteActiveRef.current = false;
        return request(false);
      })
      .catch((error: unknown) => {
        logger.warn("voice dictation system mute request failed", {
          active,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    systemMuteChainRef.current = next;
    return next;
  }, []);

  /** Play the start chime, or resolve immediately when the sounds are disabled. */
  const playStartChime = useCallback((): Promise<void> => {
    const current = currentRef.current;
    if (!current.feedbackSounds) return Promise.resolve();
    return playVoiceDictationFeedbackSound("start", current.feedbackVolume);
  }, []);

  /** Queue the system output mute; the caller must guard against stale recordings. */
  const applySystemMute = useCallback((): void => {
    void requestSystemMute(true);
  }, [requestSystemMute]);

  /** Release the system output mute silently (cancellation/error paths stay quiet per spec). */
  const releaseSystemMute = useCallback((): Promise<void> => {
    return requestSystemMute(false);
  }, [requestSystemMute]);

  /** Release the mute first, then play the stop chime so it is not swallowed by the mute. */
  const handleRecordingStopped = useCallback((): void => {
    const current = currentRef.current;
    const releaseDone = requestSystemMute(false);
    if (current.feedbackSounds) {
      void releaseDone.then(() => playVoiceDictationFeedbackSound("stop", current.feedbackVolume));
    }
  }, [requestSystemMute]);

  // A stable object: the recording hook lists it in effect deps (including the unmount cleanup),
  // so a fresh object per render would tear down recording state on every render.
  return useMemo(
    () => ({ playStartChime, applySystemMute, releaseSystemMute, handleRecordingStopped }),
    [playStartChime, applySystemMute, releaseSystemMute, handleRecordingStopped],
  );
}
