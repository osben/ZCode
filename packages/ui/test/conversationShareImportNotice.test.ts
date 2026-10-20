import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

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
    text: "帮我看下这个报错",
  },
  {
    rowId: 3,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 3,
    createdAtSeq: 3,
    kind: "assistantText" as const,
    text: "根因是 signer 被提前释放",
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
  it("渲染只读的分享对话与分割线", () => {
    const html = render({ rows, locale: "en-US", onOpenShareUrl: () => {} });
    expect(html).toContain('data-conversation-share-import-notice="true"');
    expect(html).toContain('data-conversation-share-import-divider="true"');
    // Reuses the share page renderer: both the user bubble and assistant body should appear.
    expect(html).toContain("帮我看下这个报错");
    expect(html).toContain("根因是 signer 被提前释放");
    expect(html).toContain(expectedCopy("conversationShare.import.dividerLabel"));
  });

  it("可点击时分割线是 button，不可点击时退化为静态行", () => {
    expect(render({ rows, locale: "en-US", onOpenShareUrl: () => {} })).toContain(
      '<button type="button" data-conversation-share-import-divider="true"',
    );
    const staticHtml = render({ rows, locale: "en-US" });
    expect(staticHtml).toContain('data-conversation-share-import-divider="true"');
    expect(staticHtml).not.toContain(
      '<button type="button" data-conversation-share-import-divider="true"',
    );
  });

  it("分割线文案跟随界面语言", () => {
    expect(render({ rows, locale: "en-US" })).toContain("Imported from share");
  });

  it("不给 artifactUrls：结果物不出现点不开的预览按钮", () => {
    // Local artifacts live under .zcode-share/<share-id>/shared-artifacts/ and the renderer's preview
    // button uses window.open, which cannot open local paths; this mirrors the live timeline's ArtifactRowView.
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
          displayName: "报告.pdf",
          artifactType: "pdf" as const,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
          ref: "zcode-artifact://share/artifact-1",
          state: "current" as const,
        },
      ],
      locale: "en-US",
    });
    expect(html).toContain("报告.pdf");
    expect(html).not.toContain("预览文件");
  });

  it("给到本地导入路径时，结果物使用正常预览卡片的打开控件", () => {
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
          displayName: "报告.pdf",
          artifactType: "pdf" as const,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
          ref: "zcode-artifact://share/artifact-1",
          state: "current" as const,
        },
      ],
      locale: "en-US",
      workspacePath: "/workspace",
      artifactWorkspaceRelativePaths: new Map([
        ["artifact-1", ".zcode-share/share-1/shared-artifacts/报告.pdf"],
      ]),
      onOpenCodeViewer: () => undefined,
    });

    expect(html).toContain('data-open-split-button="true"');
    expect(html).toContain(
      'data-target-path="/workspace/.zcode-share/share-1/shared-artifacts/报告.pdf"',
    );
  });
});
