import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
import { expectedCopy } from "./helpers/uiCopy.js";

// SG-01 injection boundary: the timeline no longer statically imports OpenSplitButton (keeps
// the open-with subtree out of the public page bundle); consumers inject it via
// artifactOpenAction instead. The test verifies the same injection contract with a stub.
const openActionProps: { values: Array<Record<string, unknown>> } = { values: [] };

function StubArtifactOpenAction(props: Record<string, unknown>) {
  openActionProps.values.push(props);
  const target = props.target as
    | {
        path?: string;
        previewSource?: { workspacePath?: string };
      }
    | undefined;
  return createElement(
    "button",
    {
      type: "button",
      "data-open-split-button": "true",
      "data-target-path": target?.path ?? "",
      "data-preview-workspace": target?.previewSource?.workspacePath ?? "",
    },
    "Open",
  );
}

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
    text: "请总结今天的新闻",
  },
  {
    rowId: 3,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 3,
    createdAtSeq: 3,
    kind: "assistantText" as const,
    text: "这是 **摘要**",
    state: "complete" as const,
  },
  {
    rowId: 4,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 4,
    createdAtSeq: 4,
    kind: "toolCall" as const,
    toolCallId: "tool-1",
    toolName: "WebSearch",
    status: "success" as const,
    inputText: "query",
    output: { text: "result" },
  },
];

const buildArtifactRow = (rowId: number, artifactVersionId: string) => ({
  rowId,
  turnId: "turn-1",
  productTurnId: "product-turn-1",
  createdAt: rowId,
  createdAtSeq: rowId,
  kind: "artifact" as const,
  artifactVersionId,
  logicalArtifactKey: "report",
  displayName: "晨报.pdf",
  artifactType: "pdf" as const,
  mimeType: "application/pdf",
  sizeBytes: 172_974,
  sha256: "a".repeat(64),
  ref: `zcode-artifact://share/${artifactVersionId}`,
  state: "current" as const,
});

describe("ConversationShareReadonlyTimeline", () => {
  beforeEach(() => {
    openActionProps.values = [];
  });

  it("uses Desktop user bubble, assistant markdown, turn grouping, and tool summary", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows,
        locale: "en-US",
      }),
    );
    expect(html).toContain('data-v4-user-input-bubble="true"');
    expect(html).toContain("这是");
    expect(html).toContain('data-conversation-share-turn="turn-1"');
    expect(html).toContain(expectedCopy("chat.toolCall.kind.search"));
    expect(html).toContain("tool-summary");
    expect(html).not.toContain("<details");
  });

  it("renders shared user input attachments as downloadable file pills", () => {
    const attachmentRows = [
      rows[0],
      {
        ...rows[1],
        attachments: [
          {
            ref: "zcode-artifact://share/share-input-text-1",
            previewRef: "zcode-artifact://share/share-input-text-1",
            fileName: "pasted-text.txt",
            mime: "text/plain",
            bytes: 245_760,
          },
        ],
      },
      rows[2],
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: attachmentRows,
        artifactUrls: new Map([
          ["share-input-text-1", "https://share.example.test/artifacts/text-1"],
        ]),
        locale: "en-US",
      }),
    );
    expect(html).toContain("pasted-text.txt");
    expect(html).toContain("https://share.example.test/artifacts/text-1");
    expect(html).toContain('data-v4-user-input-attachment-pill="true"');
  });

  it("keeps the user prompt before the history status and formats work duration like Desktop", () => {
    const historyRows = [
      {
        ...rows[0],
        activeMs: 165_000,
      },
      rows[1],
      {
        rowId: 7,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 7,
        createdAtSeq: 7,
        kind: "reasoning" as const,
        text: "先整理数据，再输出结论。",
        state: "complete" as const,
        durationMs: 2_000,
      },
      rows[2],
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: historyRows,
        locale: "en-US",
      }),
    );
    expect(html.indexOf('data-v4-user-input-bubble="true"')).toBeLessThan(
      html.indexOf('data-conversation-share-history-trigger="true"'),
    );
    expect(html).toContain(expectedCopy("chat.history.workedFor", { duration: "2m 45s" }));
  });

  it("renders headings and tables through the Desktop MessageResponse pipeline", () => {
    const markdownRows = [
      rows[0],
      rows[1],
      {
        ...rows[2],
        text: [
          "普通段落",
          "",
          "---",
          "",
          "# 标题",
          "",
          "## 二级标题",
          "",
          "| 项目 | 内容 |",
          "| --- | --- |",
          "| 公司 | **ZCode** |",
          "",
          "```ts",
          "const answer = 42;",
          "```",
        ].join("\n"),
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: markdownRows,
        locale: "en-US",
      }),
    );
    expect(html).toContain('data-streamdown="heading-1"');
    expect(html).toContain('data-streamdown="heading-2"');
    expect(html).toContain("<table");
    expect(html).toContain("data-markdown-table-toolbar");
    expect(html).not.toContain("# 标题");
    expect(html).not.toContain("| 项目 | 内容 |");
  });

  it("uses Desktop execute grouping for consecutive shell tool rows", () => {
    const executeRows = [
      rows[0],
      rows[1],
      rows[2],
      {
        rowId: 5,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 5,
        createdAtSeq: 5,
        kind: "toolCall" as const,
        toolCallId: "execute-1",
        toolName: "Bash",
        status: "success" as const,
        inputText: "echo one",
        input: { command: "echo one" },
        output: { text: "one" },
      },
      {
        rowId: 6,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 6,
        createdAtSeq: 6,
        kind: "toolCall" as const,
        toolCallId: "execute-2",
        toolName: "Bash",
        status: "success" as const,
        inputText: "echo two",
        input: { command: "echo two" },
        output: { text: "two" },
      },
    ];

    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: executeRows,
        locale: "en-US",
      }),
    );

    expect(html).toContain('data-conversation-share-work-group="executeGroup"');
    expect(html).toContain(expectedCopy("chat.toolCall.executeGroup.command.other", { count: 2 }));
    expect(html).toContain(expectedCopy("chat.toolCall.executeGroup.label"));
  });

  it("renders the public query summary for search rows", () => {
    const searchRows = [
      rows[0],
      rows[1],
      rows[2],
      {
        ...rows[3],
        input: { query: "AI coding" },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: searchRows,
        locale: "en-US",
      }),
    );

    expect(html).toContain("AI coding");
  });

  it("markers no longer print enum names as copy", () => {
    // Bug root cause: row.marker.type used to be rendered directly, so the share page showed a
    // divider with the literal text "compact".
    const markerRows = [
      rows[0],
      rows[1],
      {
        rowId: 90,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 90,
        createdAtSeq: 90,
        kind: "timelineMarker" as const,
        lane: "turnTailBoundary" as const,
        marker: { type: "compact" as const, origin: "auto" as const, status: "success" as const },
      },
      {
        rowId: 91,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 91,
        createdAtSeq: 91,
        kind: "timelineMarker" as const,
        lane: "turnTailBoundary" as const,
        marker: { type: "goalVerify" as const, iteration: 1, outcome: "pass" as const },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: markerRows as never,
        locale: "en-US",
      }),
    );

    expect(html).toContain(expectedCopy("conversationShare.readonly.markerCompact"));
    expect(html).not.toContain(">compact<");
    // Unrecognized types drop the whole row instead of degrading into printing the enum name.
    expect(html).not.toContain("goalVerify");
  });

  it("artifacts show public file metadata and a download entry", () => {
    const artifactRows = [
      rows[0],
      rows[1],
      {
        rowId: 80,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 80,
        createdAtSeq: 80,
        kind: "artifact" as const,
        artifactVersionId: "artifact-1",
        logicalArtifactKey: "report",
        displayName: "晨报.pdf",
        artifactType: "pdf" as const,
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "a".repeat(64),
        ref: "zcode-artifact://share/artifact-1",
        state: "current" as const,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "en-US",
        artifactUrls: new Map([["artifact-1", "https://example.invalid/a.pdf"]]),
      }),
    );

    // The subtitle reuses the same vocabulary as the body and no longer prints raw bytes.
    expect(html).toContain(expectedCopy("chat.previewCards.pdf"));
    expect(html).toContain("169 KB");
    expect(html).not.toContain("172974 bytes");
    expect(html).toContain('data-share-preview-button="true"');
  });

  it("renders OpenSplitButton for local artifacts of the Desktop import copy", () => {
    const artifactRows = [
      rows[0],
      rows[1],
      {
        rowId: 80,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 80,
        createdAtSeq: 80,
        kind: "artifact" as const,
        artifactVersionId: "artifact-1",
        logicalArtifactKey: "report",
        displayName: "晨报.pdf",
        artifactType: "pdf" as const,
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "a".repeat(64),
        ref: "zcode-artifact://share/artifact-1",
        state: "current" as const,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "en-US",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/晨报.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain('data-open-split-button="true"');
    expect(html).toContain(
      'data-target-path="/workspace/.zcode-share/share-1/shared-artifacts/晨报.pdf"',
    );
    expect(openActionProps.values).toHaveLength(1);
    expect(openActionProps.values[0]?.target).toMatchObject({
      type: "file",
      path: "/workspace/.zcode-share/share-1/shared-artifacts/晨报.pdf",
      title: "晨报.pdf",
      label: "晨报.pdf",
      previewSource: {
        type: "file",
        title: "晨报.pdf",
        path: "/workspace/.zcode-share/share-1/shared-artifacts/晨报.pdf",
        workspacePath: "/workspace",
      },
    });
  });

  it("without an injected artifactOpenAction, local artifacts render no open controls", () => {
    // Runtime negative complementing the static guard (conversationShareBundleBoundary.test.ts):
    // the public page (packages/web/src/share) passes no artifactOpenAction. This pins the
    // !artifactOpenAction condition in the ArtifactOpenContext gate — even with workspacePath,
    // a valid relative path, and an open callback all present, it must fall back to the pure
    // read-only card, preventing a later default fallback from re-enabling a local open entry
    // on the public page.
    const artifactRows = [rows[0], rows[1], buildArtifactRow(80, "artifact-1")];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "en-US",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/晨报.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(html).not.toContain('data-share-preview-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it("rejects out-of-bounds artifact paths in the import copy", () => {
    const artifactRows = [
      rows[0],
      rows[1],
      {
        rowId: 80,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 80,
        createdAtSeq: 80,
        kind: "artifact" as const,
        artifactVersionId: "artifact-1",
        logicalArtifactKey: "report",
        displayName: "晨报.pdf",
        artifactType: "pdf" as const,
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "a".repeat(64),
        ref: "zcode-artifact://share/artifact-1",
        state: "current" as const,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "en-US",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([["artifact-1", "../secret.pdf"]]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it("rejects absolute artifact paths in the import copy", () => {
    // Public page privacy boundary: all three absolute path shapes — posix / Windows drive /
    // UNC — must fall back to the pure read-only card.
    const artifactRows = [
      rows[0],
      rows[1],
      buildArtifactRow(80, "artifact-1"),
      buildArtifactRow(81, "artifact-2"),
      buildArtifactRow(82, "artifact-3"),
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "en-US",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", "/etc/passwd"],
          ["artifact-2", "C:\\x\\a.pdf"],
          ["artifact-3", "\\\\srv\\share\\a.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it("rejects artifact paths whose segment count is not 4 or that contain ./.. segments", () => {
    // "../secret.pdf" is already rejected by the segment-count check; this case specifically
    // covers 4-segment escapes whose segments contain "..".
    const artifactRows = [
      rows[0],
      rows[1],
      buildArtifactRow(80, "artifact-1"),
      buildArtifactRow(81, "artifact-2"),
      buildArtifactRow(82, "artifact-3"),
      buildArtifactRow(83, "artifact-4"),
      buildArtifactRow(84, "artifact-5"),
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "en-US",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          // Nested subdirectory: 5 segments.
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/sub/a.pdf"],
          // Shallow path: 3 segments.
          ["artifact-2", ".zcode-share/share-1/a.pdf"],
          // 4 segments but the 2nd is "..": equivalent to escaping this share directory.
          ["artifact-3", ".zcode-share/../shared-artifacts/a.pdf"],
          // 4 segments but the file name is ".": not a valid artifact file.
          ["artifact-4", ".zcode-share/share-1/shared-artifacts/."],
          // Backslash separators cannot bypass the segment check.
          ["artifact-5", ".zcode-share\\share-1\\shared-artifacts\\a.pdf\\..\\b.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it.each([
    ["zh-CN", "下载文件"],
    ["en-US", "Download file"],
  ])(`when both artifactUrls and a local path exist, the url must win (%s)`, (locale, label) => {
    // Key premise of the public page privacy boundary: ArtifactPresentation resolves local
    // paths only when !url; with a url present it must render the window.open button instead of
    // an OpenSplitButton that can reach the local file service.
    const artifactRows = [rows[0], rows[1], buildArtifactRow(80, "artifact-1")];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale,
        workspacePath: "/workspace",
        artifactUrls: new Map([["artifact-1", "https://example.invalid/a.pdf"]]),
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/晨报.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    // The resource URL actually downloads the file, so the button copy must match downloading,
    // and the injected local open action stays completely unmounted.
    expect(html).toContain(label);
    expect(html).not.toContain("预览文件");
    expect(html).not.toContain("Preview file");
    expect(html).toContain('data-share-preview-button="true"');
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  // Bug regression: the public share page passes no workspacePath/readAttachment, so
  // MarkdownImage would fall back to <img src={remote}> and an anonymous visitor would fire
  // requests to third parties on open (leaking IP/UA/Referer). Both the body and tool outputs
  // must keep only links, with no auto-loading <img>.
  it("renders no auto-loading img for remote images in the body or tool outputs", () => {
    const remoteImageRows = [
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
        kind: "assistantText" as const,
        text: "看图 ![tracker](https://tracker.invalid/pixel.png)",
        state: "complete" as const,
      },
      {
        rowId: 3,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 3,
        createdAtSeq: 3,
        kind: "toolCall" as const,
        toolCallId: "tool-1",
        toolName: "WebSearch",
        status: "success" as const,
        inputText: "query",
        output: { text: "结果 ![tracker](https://tracker.invalid/tool.png)" },
      },
    ];

    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: remoteImageRows as never,
        locale: "en-US",
      }),
    );

    // What matters is not whether the URL appears in the HTML (a link title attribute carrying
    // it is harmless), but that no <img src> fires requests automatically.
    expect(html).not.toContain("<img");
    expect(html).not.toContain('src="https://tracker.invalid');
    // No information loss: after degrading to an external link the URL is still explicitly
    // clickable by visitors.
    expect(html).toContain('title="https://tracker.invalid/pixel.png"');
    expect(html).toContain("tracker");
  });
});

it("the share page renders the static workflow graph without a desktop host or execution callbacks", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationShareReadonlyTimeline, {
      locale: "en-US",
      rows: [
        ...rows,
        {
          rowId: 5,
          turnId: "turn-1",
          productTurnId: "product-turn-1",
          createdAt: 5,
          createdAtSeq: 5,
          kind: "toolCall",
          toolCallId: "workflow-test",
          toolName: "CreateWorkflow",
          status: "success",
          inputText: "{}",
          input: { name: "调研工作流" },
          display: {
            kind: "create_workflow",
            ok: true,
            errorCount: 0,
            diagnostics: [],
            causalityGraph: {
              steps: [{ id: "s", kind: "ask", label: "检索", lane: "l", phase: "p" }],
              lanes: [{ id: "l", name: "研究员" }],
              participants: [{ id: "a", phase: "p", lane: "l", steps: ["s"] }],
              handoffs: [],
              phases: [{ id: "p", name: "调研阶段" }],
              phaseEdges: [],
              exits: ["p"],
            },
          },
        },
      ],
    }),
  );
  expect(html).toContain("调研工作流");
  expect(html).toContain("调研阶段");
  expect(html).toContain("研究员");
  expect(html).toContain(expectedCopy("conversationShare.workflowSnapshot"));
  expect(html).not.toContain('data-testid="workflow-card-resume"');
});
