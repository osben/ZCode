// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { FirstSubmissionStatus } from "@/v4/composer/ComposerWorktreeRecovery.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

afterEach(cleanup);

// The user bubble itself is the timeline's optimistic first-input row; this component is the
// preparation status rendered beneath it (specs/first-submission-instant-ux.md P1/P3).
function status(
  active: boolean,
  statusValue: NonNullable<V4ComposerDraft["firstSubmission"]>["status"] = "preparing",
  draft: Partial<V4ComposerDraft> = {},
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(FirstSubmissionStatus, {
        active,
        draft: {
          text: "Frozen message",
          firstSubmission: { submissionId: "frozen", ownerKey: "pane", status: statusValue },
          updatedAt: 0,
          ...draft,
        },
      }),
    ),
  );
}

describe("first-submission status line under the optimistic turn (FSL01/FSL04/FSL09)", () => {
  it("shows the context chip alongside the status when contexts are frozen", () => {
    status(true, "preparing", {
      text: "",
      recoveryContexts: {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "selected-context" }],
      },
    });
    expect(screen.getByText("Context references: 1")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Preparing conversation");
  });

  it("reports preparation while the submission is active (IUX05)", () => {
    status(true);
    expect(screen.getByRole("status").textContent).toContain("Preparing conversation");
  });

  it("reports synchronization after the command was created (IUX06)", () => {
    // The active flag outranks the recorded status while the chain is live; the
    // synchronizing label surfaces for an inactive record with a created command
    // (e.g. recovered after a restart mid-send).
    status(false, "sending");
    expect(screen.getByRole("status").textContent).toContain(
      "Waiting for the conversation to update",
    );
  });

  it("keeps the failure state visible under the message (IUX07)", () => {
    status(false, "failed");
    expect(screen.getByRole("status").textContent).toContain("Failed to send");
  });

  it("distinguishes an unknown command outcome from a new unsent draft", () => {
    status(false, "unknown");
    expect(screen.getByRole("status").textContent).toContain("Checking whether");
  });
});
