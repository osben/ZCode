import { describe, expect, it } from "vitest";
import { resolveVoiceInputFailureNotice } from "@/voice-input/domain/voiceInputFailure.js";

describe("resolveVoiceInputFailureNotice permission_denied", () => {
  it.each(["mac", "windows"] as const)(
    "opens the permission guide popover instead of a toast on %s",
    (os) => {
      expect(resolveVoiceInputFailureNotice("permission_denied", os)).toEqual({
        permissionGuide: true,
      });
    },
  );

  it("keeps the text-only notice on linux, which has no settings page to open", () => {
    expect(resolveVoiceInputFailureNotice("permission_denied", "linux")).toEqual({
      messageId: "voiceInput.error.permissionDenied.linux",
    });
  });

  it("leaves other failures unchanged", () => {
    expect(resolveVoiceInputFailureNotice("silent", "mac")).toEqual({
      messageId: "voiceInput.error.silent",
      settingsTarget: "privacy",
    });
  });
});
