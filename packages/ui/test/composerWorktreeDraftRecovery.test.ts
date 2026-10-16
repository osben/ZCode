import { describe, expect, it } from "vitest";
import { mergeWithdrawnWorktreeDraftText } from "@/v4/composer/composerWorktreeDraftRecovery.js";

describe("mergeWithdrawnWorktreeDraftText", () => {
  it("restores the frozen message when no later text exists", () => {
    expect(mergeWithdrawnWorktreeDraftText("submitted", "")).toBe("submitted");
  });

  it("keeps both the withdrawn message and text entered while creation was pending", () => {
    expect(mergeWithdrawnWorktreeDraftText("submitted", "new draft")).toBe(
      "submitted\n\nnew draft",
    );
  });

  it("does not duplicate a queued prefix already present in the current draft", () => {
    expect(mergeWithdrawnWorktreeDraftText("submitted", "submitted\n\nnew draft")).toBe(
      "submitted\n\nnew draft",
    );
  });
});
