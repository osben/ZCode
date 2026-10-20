import taskNotificationPopUrl from "@/assets/notification-sounds/task-notification-pop.mp3";
import { isTaskNotificationSoundEnabled } from "@/lib/taskNotificationPreferences.js";

let taskNotificationAudio: HTMLAudioElement | null = null;

function getTaskNotificationAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  if (!taskNotificationAudio) {
    taskNotificationAudio = new Audio(taskNotificationPopUrl);
    taskNotificationAudio.preload = "auto";
  }

  return taskNotificationAudio;
}

export async function playTaskNotificationSound(): Promise<void> {
  // Desktop/Web both trigger sound asynchronously after showing the notification.
  // If the sound sub-toggle is not checked here, playback continues after it is disabled in settings,
  // making the setting appear ineffective. Centralize the final decision at the player entry point so all callers behave consistently.
  if (!isTaskNotificationSoundEnabled()) {
    return;
  }

  const audio = getTaskNotificationAudio();
  if (!audio) {
    return;
  }

  try {
    // When the same Audio instance is reused for background notifications, failing to reset it first
    // often makes the next notification silent because it is still at the end of the previous playback.
    // Reset playback position explicitly and absorb autoplay-policy errors so sound failure does not affect the notification path.
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // Sound is an enhancement; playback failure must not interrupt the notification flow.
  }
}
