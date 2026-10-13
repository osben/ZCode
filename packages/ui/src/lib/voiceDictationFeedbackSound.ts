import voiceDictationStartUrl from "@/assets/notification-sounds/voice-dictation-start.wav";
import voiceDictationStopUrl from "@/assets/notification-sounds/voice-dictation-stop.wav";
import { logger } from "@/logger.js";

export type VoiceDictationFeedbackKind = "start" | "stop";

/** Handy "marimba" chimes (MIT, https://github.com/cjpais/Handy); one sound per recording edge. */
const FEEDBACK_SOUND_URLS: Record<VoiceDictationFeedbackKind, string> = {
  start: voiceDictationStartUrl,
  stop: voiceDictationStopUrl,
};

const feedbackAudios: Partial<Record<VoiceDictationFeedbackKind, HTMLAudioElement>> = {};

function getFeedbackAudio(kind: VoiceDictationFeedbackKind): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }
  let audio = feedbackAudios[kind];
  if (!audio) {
    audio = new Audio(FEEDBACK_SOUND_URLS[kind]);
    audio.preload = "auto";
    feedbackAudios[kind] = audio;
  }
  return audio;
}

/**
 * Play a dictation feedback chime and resolve when playback finishes (or failed to start), so
 * callers can sequence work after the sound — the recording-start chime must be audible before the
 * system output mute applies. Sound is an enhancement: autoplay-policy or device failures only log
 * and resolve. `volumePercent` is clamped to [0, 100].
 */
export function playVoiceDictationFeedbackSound(
  kind: VoiceDictationFeedbackKind,
  volumePercent: number,
): Promise<void> {
  const audio = getFeedbackAudio(kind);
  if (!audio) {
    return Promise.resolve();
  }
  // Reset before replaying: a reused element parked at the end would otherwise stay silent.
  audio.pause();
  audio.currentTime = 0;
  audio.volume = Math.max(0, Math.min(1, volumePercent / 100));
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("ended", finish);
      audio.removeEventListener("error", finish);
      resolve();
    };
    audio.addEventListener("ended", finish);
    audio.addEventListener("error", finish);
    void audio.play().catch((error: unknown) => {
      logger.warn("voice dictation feedback sound failed", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      finish();
    });
  });
}
