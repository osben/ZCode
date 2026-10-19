import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEEDBACK_VOLUME,
  DEFAULT_IDLE_UNLOAD_MINUTES,
  resolveVoiceDictationPreferences,
} from "@/lib/voiceDictationPreferences.js";

describe("resolveVoiceDictationPreferences", () => {
  it("applies the built-in defaults when nothing is saved", () => {
    expect(resolveVoiceDictationPreferences(undefined)).toEqual({
      pushToTalk: true,
      idleUnloadMinutes: DEFAULT_IDLE_UNLOAD_MINUTES,
      feedbackSounds: false,
      feedbackVolume: DEFAULT_FEEDBACK_VOLUME,
      muteWhileRecording: true,
      copyToClipboard: false,
      warmUpOnFocus: true,
    });
    expect(resolveVoiceDictationPreferences({})).toEqual(
      resolveVoiceDictationPreferences(undefined),
    );
  });

  it("keeps the opt-out flags on unless explicitly false", () => {
    const resolved = resolveVoiceDictationPreferences({
      pushToTalk: false,
      muteWhileRecording: false,
      warmUpOnFocus: false,
    });
    expect(resolved.pushToTalk).toBe(false);
    expect(resolved.muteWhileRecording).toBe(false);
    expect(resolved.warmUpOnFocus).toBe(false);
  });

  it("keeps the opt-in flags off unless explicitly true", () => {
    const resolved = resolveVoiceDictationPreferences({
      feedbackSounds: true,
      copyToClipboard: true,
    });
    expect(resolved.feedbackSounds).toBe(true);
    expect(resolved.copyToClipboard).toBe(true);
  });

  it("uses saved numeric values as given, including a zero volume", () => {
    const resolved = resolveVoiceDictationPreferences({
      idleUnloadMinutes: 15,
      feedbackVolume: 0,
    });
    expect(resolved.idleUnloadMinutes).toBe(15);
    expect(resolved.feedbackVolume).toBe(0);
  });
});
