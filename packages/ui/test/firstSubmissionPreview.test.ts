// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { FirstSubmissionPreview } from "@/v4/composer/ComposerWorktreeRecovery.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

afterEach(cleanup);

function preview(
  text: string,
  active: boolean,
  status: NonNullable<V4ComposerDraft["firstSubmission"]>["status"] = "preparing",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(FirstSubmissionPreview, {
        active,
        draft: {
          text,
          recoveryAttachments: [{ id: "image", filename: "frozen-image.png" }],
          firstSubmission: { submissionId: "frozen", ownerKey: "pane", status },
          updatedAt: 0,
        },
      }),
    ),
  );
}

describe("first-submission message-first presentation (FSL01/FSL04/FSL09)", () => {
  it("shows structured context when there is no text or file", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FirstSubmissionPreview, {
          active: true,
          draft: {
            text: "",
            updatedAt: 0,
            recoveryContexts: {
              sharedContextRefs: [
                { kind: "shared_context_import", context_id: "selected-context" },
              ],
            },
          },
        }),
      ),
    );
    expect(screen.getByText("Context references: 1")).toBeTruthy();
  });
  it("shows complete multiline text and files above preparation", () => {
    const text = Array.from({ length: 12 }, (_, index) => `Line ${index}`).join("\n");
    const { container } = preview(text, true);
    const message = container.querySelector("[data-first-submission-message]")!;
    const status = screen.getByRole("status");
    expect(message.textContent).toContain(text);
    expect(message.textContent).toContain("frozen-image.png");
    expect(container.querySelector("[class*='line-clamp']")).toBeNull();
    expect(message.compareDocumentPosition(status)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(status.textContent).toContain("Preparing conversation");
  });

  it("keeps attachment-only submissions visible", () => {
    preview("", true);
    expect(screen.getByText("frozen-image.png")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("restores saved intent without suggesting execution resumed", () => {
    preview("Saved before restart", false);
    expect(screen.getByText("Saved before restart")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Unsent message saved");
    expect(screen.queryByText("Preparing conversation…")).toBeNull();
  });

  it("distinguishes an unknown command outcome from a new unsent draft", () => {
    preview("Keep original command", false, "unknown");
    expect(screen.getByRole("status").textContent).toContain("Checking whether");
    expect(screen.getByText("Keep original command")).toBeTruthy();
  });
});
