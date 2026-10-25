import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

vi.mock("@/OpenSplitButton.js", async () => {
  const React = await import("react");
  return {
    OpenSplitButton: (props: Record<string, unknown>) => {
      const target = props.target as { path?: string } | undefined;
      return React.createElement("button", {
        type: "button",
        "data-open-split-button": "true",
        "data-target-path": target?.path ?? "",
      });
    },
  };
});

const rows = [
  {
    rowId: 1,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader" as const,
    origin: "userInput" as const,
    state: "completedSuccess" as const,
    startedAt: 1,
  },
  {
    rowId: 2,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 2,
    createdAtSeq: 2,
    kind: "userInput" as const,
    origin: "realUser" as const,
    text: "Please help me look at this error",
  },
  {
    rowId: 3,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 3,
    createdAtSeq: 3,
    kind: "assistantText" as const,
    text: "The root cause is the signer being released early",
    state: "complete" as const,
  },
];

function render(props: Parameters<typeof ConversationShareImportNotice>[0]) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: props.locale },
      createElement(ConversationShareImportNotice, props),
    ),
  );
}

describe("conversation share import notice", () => {
  it("renders the readonly shared conversation and the divider", () => {
    const html = render({ rows, locale: TEST_LOCALE, onOpenShareUrl: () => {} });
    expect(html).toContain('data-conversation-share-import-notice="true"');
    expect(html).toContain('data-conversation-share-import-divider="true"');
    // Reuses the share-page renderer: both the user bubble and the assistant body should appear.
    expect(html).toContain("Please help me look at this error");
    expect(html).toContain("The root cause is the signer being released early");
    expect(html).toContain(expectedCopy("conversationShare.import.dividerLabel"));
  });

  it("renders the divider as a button when clickable and as a static row when not", () => {
    expect(render({ rows, locale: TEST_LOCALE, onOpenShareUrl: () => {} })).toContain(
      '<button type="button" data-conversation-share-import-divider="true"',
    );
    const staticHtml = render({ rows, locale: TEST_LOCALE });
    expect(staticHtml).toContain('data-conversation-share-import-divider="true"');
    expect(staticHtml).not.toContain(
      '<button type="button" data-conversation-share-import-divider="true"',
    );
  });

  it.each([
    ["en-US", "Imported from share"],
    ["zh-CN", "已从分享导入"],
  ])("divider copy follows the UI locale (%s)", (locale, dividerCopy) => {
    expect(render({ rows, locale: locale as "en-US" | "zh-CN" })).toContain(dividerCopy);
  });

  it("without artifactUrls: artifacts do not show an unopenable preview button", () => {
    // Local artifacts live under .zcode-share/<share-id>/shared-artifacts/; the renderer's preview
    // button uses window.open, which cannot open a local path. This matches the live timeline's
    // ArtifactRowView behavior.
    const html = render({
      rows: [
        ...rows,
        {
          rowId: 4,
          turnId: "turn-1",
          productTurnId: "product-turn-1",
          createdAt: 4,
          createdAtSeq: 4,
          kind: "artifact" as const,
          artifactVersionId: "artifact-1",
          logicalArtifactKey: "report",
          displayName: "report.pdf",
          artifactType: "pdf" as const,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
          ref: "zcode-artifact://share/artifact-1",
          state: "current" as const,
        },
      ],
      locale: TEST_LOCALE,
    });
    expect(html).toContain("report.pdf");
    expect(html).not.toContain(expectedCopy("conversationShare.readonly.artifactPreview"));
  });

  it("with local import paths, artifacts use the normal preview card's open control", () => {
    const html = render({
      rows: [
        ...rows,
        {
          rowId: 4,
          turnId: "turn-1",
          productTurnId: "product-turn-1",
          createdAt: 4,
          createdAtSeq: 4,
          kind: "artifact" as const,
          artifactVersionId: "artifact-1",
          logicalArtifactKey: "report",
          displayName: "report.pdf",
          artifactType: "pdf" as const,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
          ref: "zcode-artifact://share/artifact-1",
          state: "current" as const,
        },
      ],
      locale: TEST_LOCALE,
      workspacePath: "/workspace",
      artifactWorkspaceRelativePaths: new Map([
        ["artifact-1", ".zcode-share/share-1/shared-artifacts/report.pdf"],
      ]),
      onOpenCodeViewer: () => undefined,
    });

    expect(html).toContain('data-open-split-button="true"');
    expect(html).toContain(
      'data-target-path="/workspace/.zcode-share/share-1/shared-artifacts/report.pdf"',
    );
  });
});
