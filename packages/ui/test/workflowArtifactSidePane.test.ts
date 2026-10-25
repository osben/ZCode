// @vitest-environment jsdom

// `workflow-artifact` tab: full-size viewing of a user-facing artifact
// (docs/dynamic-workflow/authoring.md "How the user sees them" + the
// "body renderer" rows).
//
// Terminology: the artifact here is what a script delivers to the user via
// `artifact.*`, not the engine-internal homonym "script top-level return value"
// (the spec's terminology table is the only disambiguation).
//
// Pin four things:
//   1. the body dispatches by the journal record's `contentType` to the
//      existing leaf viewers (zero new render dependencies);
//   2. the version stepper pages through the **array of known versions**, not
//      a fabricated 1..n derived from the latest version number;
//   3. the gates for "Reveal in workspace" and html's "Open in browser"
//      (desktop-local ∧ sourcePath ∧ latest version).
//   4. "Open as file": the entry appears only when the host can materialize a
//      copy, and the bytes written are the ones of **the version being viewed**.
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_WORKFLOW_ARTIFACT_PANE, type IPlatformService } from "@zcode/shared";
import type {
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  WorkflowRunArtifact,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowArtifactSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

const toast = vi.fn();
vi.mock("@/components/ui/toast.js", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

const workflowRunArtifacts = vi.fn<() => Promise<V4ConversationWorkflowRunArtifactsResult>>();
const workflowRunArtifactData = vi.fn<() => Promise<V4ConversationWorkflowRunArtifactDataResult>>();
const workflowRunArtifactRead =
  vi.fn<
    (params: {
      version: number;
      offset: number;
      limit: number;
    }) => Promise<V4ConversationWorkflowRunArtifactReadResult>
  >();
const release = vi.fn();
// layer must be a stable reference: the lease effect depends on it (same note
// as workflowRunSidePane.test.ts).
const layer = { acquire: vi.fn(() => ({ release })) };

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => ({
    layer,
    workflowRunArtifacts,
    workflowRunArtifactData,
    workflowRunArtifactRead,
  }),
}));

let snapshot: unknown = null;
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({ snapshot }),
}));

// The three heavyweight leaf viewers need pdf.js / docx-preview / xlsx wasm;
// slow in jsdom and irrelevant here. The stubs put their props onto the DOM so
// we can assert "who got the body and what it was fed".
vi.mock("@/previewPanePdfContent.js", () => ({
  PdfPreviewContent: ({ source }: { source: Blob }) =>
    createElement("div", { "data-testid": "pdf-viewer", "data-size": String(source.size) }),
}));
vi.mock("@/previewPanePptxContent.js", () => ({
  PptxPreviewContent: ({ data, fileName }: { data: ArrayBuffer; fileName?: string }) =>
    createElement("div", {
      "data-testid": "pptx-viewer",
      "data-file-name": fileName ?? "",
      "data-size": String(data.byteLength),
    }),
}));
vi.mock("@/previewPaneOfficeContent.js", () => ({
  PreviewPaneOfficeContent: ({
    kind,
    preview,
    resolvedTheme,
  }: {
    kind: string;
    preview: { dataBase64: string; totalBytes: number } | null;
    resolvedTheme: string;
  }) =>
    createElement("div", {
      "data-testid": "office-viewer",
      "data-kind": kind,
      "data-resolved-theme": resolvedTheme,
      "data-total-bytes": String(preview?.totalBytes ?? 0),
    }),
}));
vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({ children, theme }: { children?: ReactNode; theme?: string }) =>
    createElement(
      "div",
      { "data-testid": "markdown-response", "data-theme": theme ?? "" },
      children,
    ),
}));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) =>
    createElement("pre", { "data-testid": "code-block", "data-language": language ?? "" }, code),
}));

// eslint-disable-next-line import/first -- the component under test must be imported after all mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowArtifactSidePane } from "@/app-shell/WorkflowArtifactSidePane.js";
// eslint-disable-next-line import/first
import { encodeBytesToBase64 } from "@/hooks/useWorkflowRunArtifactBytes.js";
// eslint-disable-next-line import/first
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const onOpenBrowserUrl = vi.fn();
const onRevealFileInTree = vi.fn();

function tabOf(overrides: Partial<WorkflowArtifactSidePaneTab> = {}): WorkflowArtifactSidePaneTab {
  return {
    id: "workflow-artifact:%2Fworkspace:parent-a:dwfrun-1:book",
    type: "workflow-artifact",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    parentSessionId: "parent-a",
    runId: "dwfrun-1",
    artifactId: "book",
    ...overrides,
  };
}

function record(overrides: Partial<WorkflowRunArtifact> = {}): WorkflowRunArtifact {
  return {
    id: "book",
    kind: "file",
    title: "Audit report",
    contentType: "application/pdf",
    sourcePath: "out/book.pdf",
    version: 1,
    versions: [{ version: 1, publishedAt: 1, bytes: 8, sourcePath: "out/book.pdf" }],
    itemCount: 0,
    ...overrides,
  };
}

function textChunk(text: string, mediaType: string): V4ConversationWorkflowRunArtifactReadResult {
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  return {
    dataBase64: encodeBytesToBase64(bytes),
    mediaType,
    totalBytes: bytes.length,
    nextOffset: null,
  };
}

function renderPane(
  options: {
    tab?: WorkflowArtifactSidePaneTab;
    locale?: "en-US" | "zh-CN";
    withBrowser?: boolean;
    withReveal?: boolean;
    /** Omitted means no PlatformProvider (consistent with existing cases: no host capabilities). */
    platform?: Partial<IPlatformService>;
  } = {},
) {
  const pane = createElement(WorkflowArtifactSidePane, {
    tab: options.tab ?? tabOf(),
    ...(options.withBrowser === false ? {} : { onOpenBrowserUrl }),
    ...(options.withReveal === false ? {} : { onRevealFileInTree }),
  });
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      options.platform === undefined
        ? pane
        : createElement(PlatformProvider, {
            platform: options.platform as IPlatformService,
            children: pane,
          }),
    ),
  );
}

beforeEach(() => {
  cleanup();
  snapshot = null;
  toast.mockClear();
  onOpenBrowserUrl.mockClear();
  onRevealFileInTree.mockClear();
  layer.acquire.mockClear();
  workflowRunArtifacts.mockReset();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactRead.mockReset();
  workflowRunArtifacts.mockResolvedValue({ artifacts: [record()] });
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
  workflowRunArtifactRead.mockResolvedValue(textChunk("bytes---", "application/pdf"));
  // resolveTheme("system") queries matchMedia; jsdom does not provide it.
  (window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
});

describe("WorkflowArtifactSidePane body dispatch", () => {
  it("pdf goes to the existing PdfViewer fed a Blob (no file on disk, no range transport)", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId("pdf-viewer").getAttribute("data-size")).toBe("8");
    expect(view.getByTestId("workflow-artifact-title").textContent).toBe("Audit report");
  });

  it("markdown goes through MessageResponse and **passes theme** (dark-on-dark was fixed once)", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "notes",
          kind: "markdown",
          contentType: "text/markdown",
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1, bytes: 5 }],
        }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }) });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    expect(view.getByTestId("markdown-response").textContent).toBe("# hi");
    expect(view.getByTestId("markdown-response").getAttribute("data-theme")).toBe("system");
  });

  it("images use a blob object url <img>", async () => {
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () =>
      "blob:artifact-img";
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [record({ id: "shot", contentType: "image/png" })],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("png-bytes", "image/png"));
    const view = renderPane({ tab: tabOf({ artifactId: "shot" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-image")).toBeTruthy());
    expect(view.getByTestId("workflow-artifact-image").getAttribute("src")).toBe(
      "blob:artifact-img",
    );
  });

  it("csv / json use the monospace code viewer", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [record({ id: "rows", contentType: "text/csv" })],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("a,b\n1,2", "text/csv"));
    const view = renderPane({ tab: tabOf({ artifactId: "rows" }) });

    await waitFor(() => expect(view.getByTestId("code-block")).toBeTruthy());
    expect(view.getByTestId("code-block").getAttribute("data-language")).toBe("csv");
  });

  it("docx goes to the existing office viewer fed bytes (not a path)", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "doc",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(
      textChunk("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    );
    const view = renderPane({ tab: tabOf({ artifactId: "doc" }) });

    await waitFor(() => expect(view.getByTestId("office-viewer")).toBeTruthy());
    expect(view.getByTestId("office-viewer").getAttribute("data-kind")).toBe("docx");
    expect(view.getByTestId("office-viewer").getAttribute("data-total-bytes")).toBe("4");
  });

  it("pptx goes to the existing pptx viewer fed an ArrayBuffer", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [record({ id: "deck", contentType, sourcePath: "out/deck.pptx" })],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("pptx-bytes", contentType));
    const view = renderPane({ tab: tabOf({ artifactId: "deck" }) });

    await waitFor(() => expect(view.getByTestId("pptx-viewer")).toBeTruthy());
    expect(view.getByTestId("pptx-viewer").getAttribute("data-size")).toBe("10");
    expect(view.getByTestId("pptx-viewer").getAttribute("data-file-name")).toBe("out/deck.pptx");
  });

  it('off-table types get a metadata card + "Reveal in workspace" instead of pretending to render', async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({ id: "blob", contentType: "application/octet-stream", sourcePath: "out/x.bin" }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("bin", "application/octet-stream"));
    const view = renderPane({ tab: tabOf({ artifactId: "blob" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-unsupported")).toBeTruthy());
    const card = view.getByTestId("workflow-artifact-unsupported");
    expect(card.textContent).toContain("application/octet-stream");
    expect(card.textContent).toContain("out/x.bin");
    fireEvent.click(view.getByTestId("workflow-artifact-unsupported-reveal"));
    // "Reveal in workspace" receives the local absolute path joined from workspacePath.
    expect(onRevealFileInTree).toHaveBeenCalledWith("/workspace/out/x.bin");
  });

  it("preset tables render inside the tab and read **not a single byte**", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "rounds",
          kind: "table",
          contentType: undefined,
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1 }],
          spec: { columns: [{ field: "round" }] },
          itemCount: 1,
        }),
      ],
    });
    workflowRunArtifactData.mockResolvedValue({
      items: [{ sequence: 1, siteId: "report#1", ordinal: 1, item: { round: 7 } }],
      hasMore: false,
    });
    const view = renderPane({ tab: tabOf({ artifactId: "rounds" }) });

    await waitFor(() => expect(view.getByTestId("artifact-table")).toBeTruthy());
    expect(view.getByText("7")).toBeTruthy();
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
  });
});

describe("WorkflowArtifactSidePane html card", () => {
  const htmlRecord = (sourcePath: string | undefined, versionCount = 1) =>
    record({
      id: "site",
      contentType: "text/html",
      ...(sourcePath === undefined ? { sourcePath: undefined } : { sourcePath }),
      version: versionCount,
      versions: Array.from({ length: versionCount }, (_unused, index) => ({
        version: index + 1,
        publishedAt: index + 1,
        bytes: 4,
      })),
    });

  beforeEach(() => {
    workflowRunArtifactRead.mockResolvedValue(textChunk("<h1>", "text/html"));
  });

  it('local workspace + latest version: offers "Open in browser", opening the file:// URL of the workspace original', async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [htmlRecord("out/site.html")] });
    const view = renderPane({ tab: tabOf({ artifactId: "site" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-html-card")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-in-browser"));
    expect(onOpenBrowserUrl).toHaveBeenCalledWith("file:///workspace/out/site.html");
    // The card must say it opens the workspace copy, not the bytes pinned to this version.
    expect(view.getByTestId("workflow-artifact-note").textContent).toContain("workspace");
  });

  it('a remote workspace (with remoteSessionId) degrades to "local workspace preview only"', async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [htmlRecord("out/site.html")] });
    const view = renderPane({
      tab: tabOf({
        artifactId: "site",
        remoteSessionId: "remote-1",
        workspaceIdentity: "ssh://host/workspace",
      }),
    });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-html-card")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-in-browser")).toBeNull();
    expect(view.getByTestId("workflow-artifact-note").textContent).toContain(
      expectedCopy("chat.toolCall.workflow.run.artifacts.localOnly"),
    );
    expect(view.queryByTestId("workflow-artifact-reveal")).toBeNull();
  });

  it('no "Open in browser" when viewing an old version — the workspace original was overwritten by the same name', async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [htmlRecord("out/site.html", 2)] });
    const view = renderPane({ tab: tabOf({ artifactId: "site", version: 1 }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-html-card")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-in-browser")).toBeNull();
    expect(view.getByTestId("workflow-artifact-html-reveal")).toBeTruthy();
  });
});

describe("WorkflowArtifactSidePane version stepper", () => {
  it("with a single version the whole block is absent, leaving just the version number", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-version-stepper")).toBeNull();
    expect(view.getByTestId("workflow-artifact-version").textContent).toBe(
      expectedCopy("chat.toolCall.workflow.run.artifacts.version", { version: 1 }),
    );
  });

  it("with multiple versions it pages through the **array of known versions** and re-reads bytes per selection", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          version: 3,
          versions: [
            { version: 1, publishedAt: 1, bytes: 2 },
            { version: 2, publishedAt: 2, bytes: 4 },
            { version: 3, publishedAt: 3, bytes: 8 },
          ],
        }),
      ],
    });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("workflow-artifact-version-stepper")).toBeTruthy());
    // The default landing point is the latest version (the chip carries no version).
    expect(view.getByTestId("workflow-artifact-version").textContent).toBe(
      expectedCopy("chat.toolCall.workflow.run.artifacts.versionOf", { version: 3, total: 3 }),
    );
    expect(view.getByTestId("workflow-artifact-version-next").hasAttribute("disabled")).toBe(true);

    fireEvent.click(view.getByTestId("workflow-artifact-version-previous"));
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-version").textContent).toBe(
        expectedCopy("chat.toolCall.workflow.run.artifacts.versionOf", { version: 2, total: 3 }),
      ),
    );
    await waitFor(() => expect(workflowRunArtifactRead.mock.calls.at(-1)?.[0]?.version).toBe(2));
  });

  it("does not fabricate 1..n from the latest version number when the journal has no version history", async () => {
    // Only the live projection summary is present: the stepper must disappear
    // instead of offering version numbers whose bytes cannot be fetched.
    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    snapshot = {
      workflowRuns: {
        revision: 1,
        runs: [
          {
            runId: "dwfrun-1",
            status: "completed",
            usage: { spentTokens: 0, nodesUsed: 0 },
            actors: [],
            nodes: [],
            lastEventSequence: 0,
            artifacts: [
              {
                id: "book",
                kind: "file",
                title: "Audit report",
                version: 4,
                contentType: "application/pdf",
                bytes: 8,
              },
            ],
          },
        ],
      },
    };
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-version-stepper")).toBeNull();
    expect(view.getByTestId("workflow-artifact-version").textContent).toBe(
      expectedCopy("chat.toolCall.workflow.run.artifacts.version", { version: 4 }),
    );
  });
});

describe("WorkflowArtifactSidePane metadata source and empty states", () => {
  it("run in the live projection: source is marked live and the summary renders first", async () => {
    snapshot = {
      workflowRuns: {
        revision: 1,
        runs: [
          {
            runId: "dwfrun-1",
            status: "running",
            usage: { spentTokens: 0, nodesUsed: 0 },
            actors: [],
            nodes: [],
            lastEventSequence: 0,
            artifacts: [
              { id: "book", kind: "file", version: 1, contentType: "application/pdf", bytes: 8 },
            ],
          },
        ],
      },
    };
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_PANE).getAttribute("data-artifact-source")).toBe(
      "live",
    );
  });

  it("run not in the live projection: source is marked journal (cold recovery uses the durable read)", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_PANE).getAttribute("data-artifact-source")).toBe(
      "journal",
    );
  });

  it('read finished but the id is not in the list: says "no longer available" instead of staying on the loading copy forever', async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [] });
    const view = renderPane();
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-placeholder").textContent).toBe(
        expectedCopy("chat.toolCall.workflow.run.artifacts.missing"),
      ),
    );
  });

  it('session without artifact query support (old CLI) says "details unavailable", not "no longer available"', async () => {
    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const view = renderPane();
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-placeholder").textContent).toBe(
        expectedCopy("chat.toolCall.workflow.run.artifacts.unavailable"),
      ),
    );
  });

  it("the pane subscribes to the **parent session** projection (fresh artifact metadata is part of it)", async () => {
    renderPane();
    await act(async () => {});
    expect(layer.acquire).toHaveBeenCalledWith("parent-a");
  });
});

describe("WorkflowArtifactSidePane header actions", () => {
  it('when the host cannot materialize a copy, "Reveal in workspace" stays alone in the header (desktop-local ∧ sourcePath present)', async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("workflow-artifact-reveal")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-reveal"));
    expect(onRevealFileInTree).toHaveBeenCalledWith("/workspace/out/book.pdf");
  });

  it('markdown has no workspace source, so no "Reveal in workspace", but there is "Copy"', async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "notes",
          kind: "markdown",
          contentType: "text/markdown",
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1, bytes: 4 }],
        }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-copy")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-reveal")).toBeNull();
  });

  it('pdf gets no "Copy" (copying binary as text would be a lie)', async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-copy")).toBeNull();
  });
});

describe("WorkflowArtifactSidePane open as file", () => {
  const markdownRecord = () =>
    record({
      id: "notes",
      kind: "markdown",
      contentType: "text/markdown",
      sourcePath: undefined,
      versions: [{ version: 1, publishedAt: 1, bytes: 4 }],
    });

  function desktopPlatform(overrides: Partial<IPlatformService> = {}) {
    return {
      materializeWorkflowArtifactFile: vi.fn(async (payload: { fileName: string }) => ({
        localPath: `/copies/${payload.fileName}`,
      })),
      openExternalFile: vi.fn(async () => ({ success: true })),
      getInstalledEditors: vi.fn(async () => [
        { id: "vscode", name: "VS Code", iconDataUrl: "data:," },
        { id: "finder", name: "Finder", iconDataUrl: "data:," },
      ]),
      openInEditor: vi.fn(async () => ({ success: true })),
      ...overrides,
    };
  }

  function decode(bytes: unknown): string {
    return new TextDecoder().decode(bytes as Uint8Array);
  }

  it("no entry when the host cannot materialize a copy (mobile remote control / web)", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const view = renderPane({
      tab: tabOf({ artifactId: "notes" }),
      platform: { openExternalFile: vi.fn() },
    });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-as-file")).toBeNull();
  });

  it("preset tables have no bytes, so no entry", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "scores",
          kind: "table",
          contentType: undefined,
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1 }],
          spec: { columns: [{ field: "round" }] },
        }),
      ],
    });
    const view = renderPane({
      tab: tabOf({ artifactId: "scores" }),
      platform: desktopPlatform(),
    });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-title")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-as-file")).toBeNull();
  });

  it("markdown: writes this version's bytes as <id>.md and opens it with the system default app", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));

    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledWith("/copies/notes.md"));
    const payload = platform.materializeWorkflowArtifactFile.mock.calls[0]?.[0] as unknown as {
      runId: string;
      artifactId: string;
      version: number;
      fileName: string;
      bytes: Uint8Array;
    };
    expect(payload).toMatchObject({
      runId: "dwfrun-1",
      artifactId: "notes",
      version: 1,
      fileName: "notes.md",
    });
    expect(decode(payload.bytes)).toBe("# hi");
  });

  it("file: the file name is the selected version's sourcePath basename; stepping to an old version writes that version's bytes", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          version: 2,
          sourcePath: "out/book.pdf",
          versions: [
            { version: 1, publishedAt: 1, bytes: 5, sourcePath: "out/draft.pdf" },
            { version: 2, publishedAt: 2, bytes: 5, sourcePath: "out/book.pdf" },
          ],
        }),
      ],
    });
    workflowRunArtifactRead.mockImplementation(async (params) =>
      textChunk(`pdf-v${params.version}`, "application/pdf"),
    );
    const platform = desktopPlatform();
    const view = renderPane({ platform });

    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledWith("/copies/book.pdf"));
    expect(platform.materializeWorkflowArtifactFile.mock.calls[0]?.[0]).toMatchObject({
      version: 2,
      fileName: "book.pdf",
    });

    fireEvent.click(view.getByTestId("workflow-artifact-version-previous"));
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-version").textContent).toBe(
        expectedCopy("chat.toolCall.workflow.run.artifacts.versionOf", { version: 1, total: 2 }),
      ),
    );
    await waitFor(() =>
      expect(view.getByTestId("pdf-viewer").getAttribute("data-size")).toBe(
        String("pdf-v1".length),
      ),
    );
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() =>
      expect(platform.openExternalFile).toHaveBeenLastCalledWith("/copies/draft.pdf"),
    );
    const second = platform.materializeWorkflowArtifactFile.mock.calls[1]?.[0] as unknown as {
      version: number;
      fileName: string;
      bytes: Uint8Array;
    };
    expect(second).toMatchObject({ version: 1, fileName: "draft.pdf" });
    expect(decode(second.bytes)).toBe("pdf-v1");
  });

  it("opening the same version again re-uses the same copy without re-transferring bytes", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledTimes(2));
    expect(platform.materializeWorkflowArtifactFile).toHaveBeenCalledTimes(1);
  });

  it("shows a toast instead of staying silent when the system app cannot open it", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform({
      openExternalFile: vi.fn(async () => ({ success: false, error: "no app" })),
    });
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expectedCopy("chat.toolCall.workflow.run.artifacts.openAsFileFailed"),
      ),
    );
  });

  it("shows the same toast when writing the copy fails", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform({
      materializeWorkflowArtifactFile: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expectedCopy("chat.toolCall.workflow.run.artifacts.openAsFileFailed"),
      ),
    );
    expect(platform.openExternalFile).not.toHaveBeenCalled();
  });

  it("open with: lists installed apps (file manager first); picking one opens the copy with it", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.pointerDown(view.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => expect(view.getByText("VS Code")).toBeTruthy());
    const names = view.getAllByRole("menuitem").map((item) => item.textContent);
    expect(names.slice(0, 2)).toEqual(["Finder", "VS Code"]);

    fireEvent.click(view.getByText("VS Code"));
    await waitFor(() =>
      expect(platform.openInEditor).toHaveBeenCalledWith("vscode", "/copies/notes.md", {
        pathKind: "file",
      }),
    );
    expect(platform.openExternalFile).not.toHaveBeenCalled();
  });

  it('with a workspace source, "Reveal in workspace" moves into the menu and the header keeps a single file control', async () => {
    const platform = desktopPlatform();
    const view = renderPane({ platform });

    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId("workflow-artifact-open-as-file")).toBeTruthy();
    expect(view.queryByTestId("workflow-artifact-reveal")).toBeNull();

    fireEvent.pointerDown(view.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-open-as-file-reveal")).toBeTruthy(),
    );
    const names = view.getAllByRole("menuitem").map((item) => item.textContent);
    // Location actions come after the apps: first "Reveal in workspace", then
    // "Copy absolute path".
    expect(names.slice(-2)).toEqual([
      expectedCopy("chat.toolCall.workflow.run.artifacts.reveal"),
      expectedCopy("fileActions.copyAbsolutePath"),
    ]);

    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file-reveal"));
    expect(onRevealFileInTree).toHaveBeenCalledWith("/workspace/out/book.pdf");
    // Revealing the location does not materialize a copy.
    expect(platform.materializeWorkflowArtifactFile).not.toHaveBeenCalled();
  });

  it('without a workspace source (markdown) or in a remote workspace, the menu has no "Reveal in workspace"', async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const markdownView = renderPane({
      tab: tabOf({ artifactId: "notes" }),
      platform: desktopPlatform(),
    });
    await waitFor(() => expect(markdownView.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.pointerDown(markdownView.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() =>
      expect(markdownView.getByText(expectedCopy("fileActions.copyAbsolutePath"))).toBeTruthy(),
    );
    expect(markdownView.queryByTestId("workflow-artifact-open-as-file-reveal")).toBeNull();
    cleanup();

    workflowRunArtifacts.mockResolvedValue({ artifacts: [record()] });
    const remoteView = renderPane({
      tab: tabOf({ remoteSessionId: "remote-1", workspaceIdentity: "ssh://host/workspace" }),
      platform: desktopPlatform(),
    });
    await waitFor(() => expect(remoteView.getByTestId("pdf-viewer")).toBeTruthy());
    expect(remoteView.queryByTestId("workflow-artifact-reveal")).toBeNull();
    fireEvent.pointerDown(remoteView.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() =>
      expect(remoteView.getByText(expectedCopy("fileActions.copyAbsolutePath"))).toBeTruthy(),
    );
    expect(remoteView.queryByTestId("workflow-artifact-open-as-file-reveal")).toBeNull();
  });

  it('"Copy path" copies the copy\'s absolute path', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.pointerDown(view.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() =>
      expect(view.getByText(expectedCopy("fileActions.copyAbsolutePath"))).toBeTruthy(),
    );
    fireEvent.click(view.getByText(expectedCopy("fileActions.copyAbsolutePath")));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/copies/notes.md"));
  });
});
