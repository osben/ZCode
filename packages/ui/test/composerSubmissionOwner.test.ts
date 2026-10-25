import { describe, expect, it } from "vitest";
import { isComposerSubmissionOwnerCurrent } from "@/v4/composer/composerSubmissionOwner.js";

describe("submission owner", () => {
  const owner = { workspaceKey: "remote:a:/repo", scopeId: "session-a", revision: 3 };
  it("does not restore or clear another chat or host with the same path", () => {
    expect(isComposerSubmissionOwnerCurrent(owner, { ...owner, scopeId: "session-b" })).toBe(false);
    expect(
      isComposerSubmissionOwnerCurrent(owner, { ...owner, workspaceKey: "remote:b:/repo" }),
    ).toBe(false);
  });
  it("preserves newer text in the same chat", () => {
    expect(isComposerSubmissionOwnerCurrent(owner, { ...owner, revision: 4 })).toBe(false);
    expect(isComposerSubmissionOwnerCurrent(owner, owner)).toBe(true);
    expect(isComposerSubmissionOwnerCurrent({ ...owner, epoch: 1 }, { ...owner, epoch: 3 })).toBe(
      false,
    );
  });
});
