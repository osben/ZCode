import { describe, expect, it } from "vitest";
import {
  resolveComposerSubmitBlockReason,
  type ComposerSubmitBlockReason,
} from "@/v4/composer/composerSubmitBlockReason.js";

// Baseline: everything ready. Each case overrides only the field under test.
const ready = {
  remoteAvailable: true,
  runtimeBlocked: false,
  submissionReady: true,
  submissionConfigured: true,
  sendInProgress: false,
  preparedSessionAwaitingFirstInput: false,
  retrying: false,
  outcomeUnresolved: false,
  attachmentsReady: true,
} as const;

// SessionPane derives submissionReady from createComposerSubmissionConfig, which returns null
// when the stored selection does not resolve to a model; both flags are false in that state.
const unresolvedFromView = {
  ...ready,
  submissionReady: false,
  submissionConfigured: false,
} as const;

describe("resolveComposerSubmitBlockReason: stored model selection cannot be resolved", () => {
  it.each(["provider-not-found", "account-connection-unavailable", "model-not-found"] as const)(
    "names the unavailable model for selectionIssue %s",
    (modelSelectionIssue) => {
      expect(
        resolveComposerSubmitBlockReason({ ...unresolvedFromView, modelSelectionIssue }),
      ).toBe<ComposerSubmitBlockReason>("modelUnavailable");
    },
  );

  it("keeps the stored intent visible as the block reason even when the runtime is also blocked", () => {
    expect(
      resolveComposerSubmitBlockReason({
        ...unresolvedFromView,
        runtimeBlocked: true,
        modelSelectionIssue: "model-not-found",
      }),
    ).toBe("modelUnavailable");
  });

  it("does not hide an unavailable remote host behind the model message", () => {
    expect(
      resolveComposerSubmitBlockReason({
        ...unresolvedFromView,
        remoteAvailable: false,
        modelSelectionIssue: "provider-not-found",
      }),
    ).toBe("remoteUnavailable");
  });
});

describe("resolveComposerSubmitBlockReason: generic not-ready states are unchanged", () => {
  it("keeps sessionNotReady when the selection is missing (new task without a model)", () => {
    expect(
      resolveComposerSubmitBlockReason({
        ...unresolvedFromView,
        modelSelectionIssue: "selection-missing",
      }),
    ).toBe("sessionNotReady");
  });

  it.each(["reasoning-level-missing", "reasoning-level-not-supported"] as const)(
    "keeps sessionNotReady for selectionIssue %s",
    (modelSelectionIssue) => {
      expect(resolveComposerSubmitBlockReason({ ...unresolvedFromView, modelSelectionIssue })).toBe(
        "sessionNotReady",
      );
    },
  );

  it("keeps sessionNotReady when readiness is missing without any selection issue", () => {
    expect(resolveComposerSubmitBlockReason(unresolvedFromView)).toBe("sessionNotReady");
  });

  it("returns null when the selection resolves and everything is ready", () => {
    expect(resolveComposerSubmitBlockReason({ ...ready })).toBeNull();
  });
});
