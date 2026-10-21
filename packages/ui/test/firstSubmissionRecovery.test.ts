// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
import {
  V4_DRAFT_SCOPE_ROOT,
  V4_WORKTREE_RECOVERY_PENDING_SCOPE,
  getV4WorktreeRecoveryScope,
  moveV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  updateV4FirstSubmission,
} from "@/v4/composer/composerDraftStore.js";

const WORKSPACE = "/first-submission-recovery";
const SUBMISSION = "submission-frozen";
const PENDING = `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:${SUBMISSION}`;

afterEach(() => localStorage.clear());

describe("first-submission recovery (FSL04/FSL08/FSL09)", () => {
  it("retains the complete frozen intent and profile through binding and failed preparation", () => {
    const frozen = {
      text: "First line\nSecond line\nThird line\nFourth line\nFifth line",
      mode: "build" as const,
      recoveryAttachments: [{ id: "frozen-file", filename: "image.png" }],
      firstSubmission: {
        submissionId: SUBMISSION,
        ownerKey: "original-pane",
        status: "preparing" as const,
        incognito: INCOGNITO_LOCKDOWN_PROFILE,
      },
    };
    expect(persistV4ComposerDraft(WORKSPACE, undefined, PENDING, frozen)).toBe(true);
    const bound = getV4WorktreeRecoveryScope("session-reserved", SUBMISSION);
    expect(moveV4ComposerDraft(WORKSPACE, undefined, PENDING, bound)).toBe(true);
    updateV4FirstSubmission(WORKSPACE, undefined, SUBMISSION, { status: "failed" });

    const recovered = readV4WorktreeRecoveryDrafts(WORKSPACE, undefined, "session-reserved");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.draft).toMatchObject({
      ...frozen,
      firstSubmission: { ...frozen.firstSubmission, status: "failed" },
    });
    expect(readV4ComposerDraft(WORKSPACE, undefined, PENDING)).toBeNull();
  });

  it("does not overwrite the next draft or another remote attachment at the same path", () => {
    const firstIdentity = "remote-attachment-one";
    const secondIdentity = "remote-attachment-two";
    for (const identity of [firstIdentity, secondIdentity]) {
      expect(
        persistV4ComposerDraft(WORKSPACE, identity, PENDING, {
          text: `Frozen ${identity}`,
          firstSubmission: {
            submissionId: SUBMISSION,
            ownerKey: identity,
            status: "sending",
            commandId: "original-command",
          },
        }),
      ).toBe(true);
    }
    expect(
      persistV4ComposerDraft(WORKSPACE, firstIdentity, V4_DRAFT_SCOPE_ROOT, {
        text: "New draft typed during send",
      }),
    ).toBe(true);
    updateV4FirstSubmission(WORKSPACE, firstIdentity, SUBMISSION, { status: "unknown" });

    expect(readV4ComposerDraft(WORKSPACE, firstIdentity, PENDING)?.firstSubmission).toMatchObject({
      status: "unknown",
      commandId: "original-command",
    });
    expect(readV4ComposerDraft(WORKSPACE, secondIdentity, PENDING)?.firstSubmission).toMatchObject({
      status: "sending",
      ownerKey: secondIdentity,
    });
    expect(readV4ComposerDraft(WORKSPACE, firstIdentity, V4_DRAFT_SCOPE_ROOT)?.text).toBe(
      "New draft typed during send",
    );
  });
});
