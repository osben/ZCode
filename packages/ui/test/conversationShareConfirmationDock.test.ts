// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConversationShareConfirmationDock error details", () => {
  it("keeps the failed publish phase and its last progress instead of showing 100%", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        progressLabel: "Uploading artifacts",
        progressPhase: "uploading",
        error: {
          issueCount: 1,
          issues: [{ code: "upload_incomplete", scope: "artifact", phase: "uploading" }],
        },
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("58");
    expect(
      progress
        .querySelector('[data-testid="conversation-share-progress-fill"]')
        ?.getAttribute("style"),
    ).toContain("width: 58%");
    expect(
      screen
        .getByTestId("conversation-share-publish-phase-uploading")
        .getAttribute("data-phase-state"),
    ).toBe("failed");
    expect(
      screen
        .getByTestId("conversation-share-publish-phase-collecting")
        .getAttribute("data-phase-state"),
    ).toBe("complete");
  });

  it("keeps retry available after an error even when the disclosure checkbox is not rendered", () => {
    const onConfirm = vi.fn();
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        title: "Share",
        disclosureAccepted: false,
        error: {
          issueCount: 1,
          messageId: "conversationShare.error.network",
          issues: [{ code: "unknown", scope: "transport", phase: "collecting" }],
        },
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm,
      }),
    );

    const retry = screen.getByTestId("conversation-share-confirm");
    expect(retry).toHaveProperty("disabled", false);
    expect(retry.getAttribute("data-size")).toBe("lg");
    fireEvent.click(retry);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps the publish progress in the same dock and removes edit actions", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        progressLabel: "Uploading artifacts",
        progressPhase: "uploading",
        pending: true,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(screen.getByTestId("conversation-share-publish-progress").textContent).toContain(
      "Uploading artifacts",
    );
    expect(screen.queryByTestId("conversation-share-publish-lock-note")).toBeNull();
    expect(screen.queryByTestId("conversation-share-disclosure-checkbox")).toBeNull();
    expect(screen.queryByTestId("conversation-share-back")).toBeNull();
    expect(screen.queryByText("conversationShare.partial.cancel")).toBeNull();
    expect(screen.getByTestId("conversation-share-confirm")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("conversation-share-confirm").getAttribute("data-size")).toBe("lg");
  });

  it("uses one explicit natural-language footer summary for publish metadata", () => {
    expect(zhCN["conversationShare.publish.footerMeta"]).toBe(
      "分享 {selected} 个对话轮次，{access}",
    );
    expect(zhCN["conversationShare.permission.linkEditorSummary"]).toBe("链接持有者可导入并继续");
    expect(zhCN["conversationShare.permission.linkViewerSummary"]).toBe("链接持有者可查看");
    expect(enUS["conversationShare.publish.footerMeta"]).toBe(
      "Share {selected} conversation turn(s), {access}",
    );
    expect(enUS["conversationShare.permission.linkEditorSummary"]).toBe(
      "Link holders can import and continue",
    );
  });

  it("renders publish phases as aligned cards with artifact progress", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 3,
        totalCount: 3,
        progressLabel: "Uploading artifacts",
        progressPhase: "uploading",
        completedArtifacts: 2,
        totalArtifacts: 3,
        pending: true,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(
      screen.getByTestId("conversation-share-publish-phase-uploading").parentElement?.className,
    ).toContain("@min-[640px]/share:grid-cols-3");
    expect(screen.getByTestId("conversation-share-publish-phase-uploading").textContent).toContain(
      "conversationShare.phase.uploadingActive",
    );
  });

  it("keeps disclosure confirmation inside the dock before publishing", () => {
    const onDisclosureAcceptedChange = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm,
        disclosureAccepted: false,
        onDisclosureAcceptedChange,
      }),
    );

    const disclosure = screen.getByTestId("conversation-share-disclosure-checkbox");
    const confirm = screen.getByTestId("conversation-share-confirm");
    expect(screen.getByTestId("conversation-share-disclosure").textContent).not.toContain(
      "conversationShare.publicWarning",
    );
    expect(disclosure).toHaveProperty("checked", false);
    expect(confirm).toHaveProperty("disabled", false);
    expect(screen.queryByTestId("conversation-share-disclosure-confirm")).toBeNull();

    fireEvent.click(disclosure);
    expect(onDisclosureAcceptedChange).toHaveBeenCalledWith(true);

    rerender(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm,
        disclosureAccepted: true,
        onDisclosureAcceptedChange,
      }),
    );
    expect(screen.getByTestId("conversation-share-confirm")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("highlights the review checkbox without publishing and requires a second click after acceptance", () => {
    const props = {
      selectedCount: 1,
      totalCount: 1,
      onCancel: vi.fn(),
      onBack: vi.fn(),
      onConfirm: vi.fn(),
    };
    const onDisclosureAcceptedChange = vi.fn();
    const { rerender } = render(
      createElement(ConversationShareConfirmationDock, {
        ...props,
        onDisclosureAcceptedChange,
      }),
    );
    const disclosure = screen.getByTestId("conversation-share-disclosure");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    disclosure.animate = animate;
    disclosure.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByTestId("conversation-share-disclosure-checkbox"),
    );
    expect(disclosure.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("conversation-share-review-hint")).toBeNull();
    expect(disclosure.className).not.toContain("ring-warning");
    expect(animate).toHaveBeenCalledTimes(1);
    // Checking the checkbox cancels the still-playing pulse animation so no highlight lingers into the confirmed state.
    fireEvent.click(screen.getByTestId("conversation-share-disclosure-checkbox"));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onDisclosureAcceptedChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(animate).toHaveBeenCalledTimes(2);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(animate).toHaveBeenCalledTimes(2);
    // With reduced motion, positioning and focus still happen — only the highlight animation is skipped.
    expect(disclosure.scrollIntoView).toHaveBeenCalledTimes(3);
    rerender(
      createElement(ConversationShareConfirmationDock, { ...props, disclosureAccepted: true }),
    );
    expect(screen.queryByTestId("conversation-share-review-hint")).toBeNull();
    expect(props.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("caps the dock height and scrolls only the body above the pinned actions (SHARE28)", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    // Root cause: window breakpoints cannot reflect the Dock's real width after sidebar squeeze; it must respond to the container's content-box width.
    const dock = screen.getByTestId("conversation-share-confirmation-dock");
    expect(dock.className).toContain("@container/share");
    expect(dock.className).toContain("max-h-[70dvh]");
    expect(dock.className).toContain("flex-col");
    // In a narrow panel the taller form is absorbed by independent body scrolling; the action area must never scroll out of view with the body.
    const body = screen.getByTestId("conversation-share-confirmation-body");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("min-h-0");
    expect(screen.getByTestId("conversation-share-confirmation-actions").className).toContain(
      "shrink-0",
    );
    expect(body.compareDocumentPosition(screen.getByTestId("conversation-share-back"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("stacks the primary action above the secondary actions below the 480px container", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const actions = screen.getByTestId("conversation-share-confirmation-actions");
    const buttonRow = actions.lastElementChild!;
    expect(buttonRow.className).toContain("grid-cols-2");
    expect(buttonRow.className).toContain("@min-[480px]/share:flex");
    const confirm = screen.getByTestId("conversation-share-confirm");
    expect(confirm.className).toContain("col-span-2");
    expect(confirm.className).toContain("@min-[480px]/share:order-last");
    // The primary action comes first in the DOM: on narrow screens (primary action on the first row) visual order matches keyboard order; wide containers use
    // order-last to push it visually to the far right, so Tab order (primary first) and visual order (primary last)
    // point in opposite directions — a documented trade-off in the spec (docs/conversation-share-v1.md SHARE28), not a regression.
    expect(confirm.compareDocumentPosition(screen.getByTestId("conversation-share-back"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // On narrow screens the copy may wrap instead of being clamped to a single truncated line.
    expect(confirm.className).toContain("whitespace-normal");
    expect(confirm.className).not.toContain("truncate");
  });

  it("switches the compact permission grid by container width with full labels", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const radiogroup = screen.getByRole("radiogroup", {
      name: "conversationShare.permissionLabel",
    });
    expect(radiogroup.className).toContain("@min-[640px]/share:grid-cols-3");
    expect(radiogroup.className).not.toContain("md:grid-cols-3");
    // The permission copy wraps in full; truncation via truncate is not allowed.
    const option = screen.getByRole("radio", { name: "conversationShare.permission.linkEditor" });
    const textSpans = [...option.querySelectorAll<HTMLElement>("span > span")];
    expect(textSpans.length).toBeGreaterThan(0);
    for (const span of textSpans) {
      expect(span.className).toContain("whitespace-normal");
      expect(span.className).not.toContain("truncate");
    }
  });

  it("aligns the permission rail with the title rail", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(screen.getByTestId("conversation-share-confirmation-header").className).toContain("p-3");
    expect(
      screen.getByTestId("conversation-share-permission-picker").getAttribute("data-variant"),
    ).toBe("compact");
    expect(screen.getByTestId("conversation-share-permission-label").className).toContain(
      "text-ui-sm",
    );
    expect(screen.getByTestId("conversation-share-permission-picker").className).not.toContain(
      "p-2",
    );
  });

  it("defaults to the importable link permission when no access mode is provided", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(
      screen
        .getByRole("radio", { name: "conversationShare.permission.linkEditor" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "conversationShare.permission.private" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("uses the designed warning surface for the sensitive-content acknowledgement", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const disclosure = screen.getByTestId("conversation-share-disclosure");
    expect(disclosure.className).toContain("mx-3");
    expect(disclosure.className).toContain("mt-3");
    expect(disclosure.className).toContain("border-l-2");
    expect(disclosure.className).toContain("border-l-warning");
    expect(disclosure.className).toContain("bg-surface");
    expect(disclosure.className).toContain("rounded-xl");
    expect(screen.getByTestId("conversation-share-disclosure-icon")).toBeTruthy();
    expect(screen.getByTestId("conversation-share-disclosure-checkbox")).toBeTruthy();
  });

  it("opens the sensitive-content review scope above the disclosure and toggles it closed", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const trigger = screen.getByTestId("conversation-share-disclosure-scope-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("conversation-share-disclosure-scope-content")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const content = screen.getByTestId("conversation-share-disclosure-scope-content");
    expect(content.textContent).toContain("conversationShare.disclosure.scope.title");
    expect(content.textContent).toContain("conversationShare.disclosure.scope.conversation");
    expect(content.textContent).toContain("conversationShare.disclosure.scope.sensitive");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("conversation-share-disclosure-scope-content")).toBeNull();
  });

  it("keeps the disclosure copy and review-scope action on one content row", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const contentRow = screen.getByTestId("conversation-share-disclosure-content-row");
    const supportingRow = screen.getByTestId("conversation-share-disclosure-supporting-row");
    expect(contentRow.textContent).toContain("conversationShare.disclosure.checkbox");
    expect(contentRow.textContent).toContain("conversationShare.disclosure.description");
    expect(contentRow.textContent).toContain("conversationShare.disclosure.scope.trigger");
    expect(supportingRow.className).toContain("ml-auto");
    expect(supportingRow.className).toContain("justify-end");
    expect(supportingRow.className).toContain("text-ui-xs");
  });

  it("renders actionable artifact details and deselects the affected turn", () => {
    const onDeselectTurn = vi.fn();
    const onCopyRequestId = vi.fn();
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 2,
        title: "Share",
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          issueCount: 1,
          requestId: "server-request-123",
          issues: [
            {
              code: "artifact_type_not_allowed",
              scope: "artifact",
              // turnOrdinal is copy-only; "cancel this turn" targets by productTurnId.
              turnOrdinal: 2,
              productTurnId: "product-turn-2",
              artifactDisplayName: "晨报.pdf",
              artifactType: "pdf",
              extension: "pdf",
              mimeType: "application/pdf",
              allowedFormats: ["PPTX (.pptx)", "DOCX (.docx)"],
            },
          ],
        },
        onDeselectTurn,
        onCopyRequestId,
      }),
    );

    expect(screen.getByTestId("conversation-share-error-details").textContent).toContain(
      "晨报.pdf",
    );
    expect(screen.getByTestId("conversation-share-error-details").textContent).toContain("pdf");
    const errorDetails = screen.getByTestId("conversation-share-error-details");
    expect(errorDetails.textContent).not.toContain("server-request-123");
    expect(screen.queryByTestId("conversation-share-request-id-content")).toBeNull();
    const requestDetailsTrigger = screen.getByTestId("conversation-share-request-id-trigger");
    expect(requestDetailsTrigger.getAttribute("aria-label")).toBe(
      "conversationShare.issue.details",
    );
    fireEvent.click(requestDetailsTrigger);
    expect(screen.getByTestId("conversation-share-request-id-content").textContent).toContain(
      "server-request-123",
    );
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.issue.copyRequestId" }));
    expect(onCopyRequestId).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.issue.deselectTurn" }));
    expect(onDeselectTurn).toHaveBeenCalledWith("product-turn-2");
  });

  it("shows a stable missing request id state without a copy action", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          issueCount: 1,
          issues: [{ code: "unknown", scope: "transport" }],
        },
      }),
    );

    expect(screen.queryByTestId("conversation-share-request-id-content")).toBeNull();
    fireEvent.click(screen.getByTestId("conversation-share-request-id-trigger"));
    expect(screen.getByTestId("conversation-share-request-id-content").textContent).toContain(
      "conversationShare.issue.requestIdMissing",
    );
    expect(
      screen.queryByRole("button", { name: "conversationShare.issue.copyRequestId" }),
    ).toBeNull();
  });

  it("keeps the request id hidden until the inline error details button is opened", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          messageId: "conversationShare.error.invalidConversation",
          issueCount: 1,
          requestId: "server-request-456",
          issues: [{ code: "invalid_conversation", scope: "conversation" }],
        },
        onCopyRequestId: vi.fn(),
      }),
    );

    expect(screen.getByTestId("conversation-share-error-message").textContent).toContain(
      "conversationShare.error.invalidConversation",
    );
    expect(screen.getByTestId("conversation-share-error-message").textContent).not.toContain(
      "server-request-456",
    );
    expect(screen.queryByText("server-request-456")).toBeNull();

    fireEvent.click(screen.getByTestId("conversation-share-request-id-trigger"));

    expect(screen.getByTestId("conversation-share-request-id-content").textContent).toContain(
      "server-request-456",
    );
  });

  it("shows the actionable publish error instead of a generic transport issue", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          messageId: "conversationShare.error.authenticationRequired",
          issueCount: 1,
          issues: [{ code: "unknown", scope: "transport", phase: "collecting" }],
        },
      }),
    );

    const details = screen.getByTestId("conversation-share-error-details");
    expect(screen.getByTestId("conversation-share-confirmation-header").textContent).toContain(
      "conversationShare.publish.failedTitle",
    );
    expect(screen.getByTestId("conversation-share-publish-progress")).toBeTruthy();
    expect(screen.queryByTestId("conversation-share-permission-picker")).toBeNull();
    expect(details.textContent).toContain("conversationShare.error.authenticationRequired");
    expect(details.textContent).not.toContain("conversationShare.issue.unknown");
  });

  it("keeps a single-line publish error vertically centered in a compact card", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          messageId: "conversationShare.error.invalidConversation",
          issueCount: 1,
          issues: [{ code: "invalid_conversation", scope: "conversation" }],
        },
      }),
    );

    const errorCard = screen.getByTestId("conversation-share-error-details");
    const errorRow = screen.getByTestId("conversation-share-error-row");
    expect(errorCard.className).toContain("p-2");
    expect(errorCard.className).not.toContain("p-2.5");
    expect(errorCard.className).toContain("mb-2");
    expect(errorCard.className).not.toContain("mb-3");
    expect(errorRow.className).toContain("items-center");
    expect(errorRow.className).not.toContain("mb-1.5");
  });

  it("uses one 24px center line for the error copy, details button, and dismiss action", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onBack: vi.fn(),
        onConfirm: vi.fn(),
        onDismissError: vi.fn(),
        error: {
          messageId: "conversationShare.error.invalidConversation",
          issueCount: 1,
          issues: [{ code: "invalid_conversation", scope: "conversation" }],
        },
      }),
    );

    const errorMessage = screen.getByTestId("conversation-share-error-message");
    const dismiss = screen.getByTestId("conversation-share-error-dismiss");
    expect(errorMessage.className).toContain("items-center");
    expect(errorMessage.className).toContain("leading-6");
    expect(dismiss.className).toContain("leading-6");
  });
});
