// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { FirstSubmissionStatus } from "@/v4/composer/ComposerWorktreeRecovery.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

afterEach(cleanup);

// The user bubble itself is the timeline's optimistic first-input row; this component renders
// beneath it only what the user must act on or wait out knowingly — never a progress label
// (specs/first-submission-instant-ux.md, Status under the message).
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
  it("shows the frozen-context chip without a progress label while active", () => {
    status(true, "preparing", {
      text: "",
      recoveryContexts: {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "selected-context" }],
      },
    });
    expect(screen.getByText("Context references: 1")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["preparing", "sending"] as const)(
    "renders nothing for an active %s submission (IUX05: the turn itself is the feedback)",
    (statusValue) => {
      const { container } = status(true, statusValue);
      expect(container.textContent).toBe("");
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("renders nothing for an inactive preparing record (the composer card offers Retry)", () => {
    const { container } = status(false, "preparing");
    expect(container.textContent).toBe("");
  });

  it("reports synchronization for an inactive record with a created command (IUX06/IUX09)", () => {
    // Recovered after a restart mid-send: the command exists, the projection has not arrived.
    status(false, "sending");
    expect(screen.getByRole("status").textContent).toContain(
      "Waiting for the conversation to update",
    );
  });

  it("keeps the failure state visible under the message (IUX07)", () => {
    status(false, "failed");
    expect(screen.getByRole("status").textContent).toContain("Failed to send");
    // DESIGN.md status colors: a failure uses the destructive token, not the subtle foreground.
    expect(screen.getByRole("status").className).toContain("text-destructive");
  });

  it("does not claim a failed send when a sendText command existed (reconciled unknown)", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FirstSubmissionStatus, {
          draft: {
            text: "hello",
            updatedAt: 1,
            firstSubmission: {
              submissionId: "s",
              ownerKey: "o",
              status: "failed",
              commandId: "cmd",
            },
          },
          active: false,
        }),
      ),
    );
    expect(screen.getByRole("status").textContent).toContain("Couldn’t confirm");
    expect(screen.getByRole("status").textContent).not.toContain("Failed to send");
  });

  it("distinguishes an unknown command outcome from a new unsent draft", () => {
    status(false, "unknown");
    expect(screen.getByRole("status").textContent).toContain("Checking whether");
    expect(screen.getByRole("status").className).not.toContain("text-destructive");
  });
});
