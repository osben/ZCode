/** @vitest-environment jsdom */

import type { IBroadcastService } from "@zcode/services";
import { createElement, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({
    children,
    code,
    style,
  }: {
    children: ReactNode;
    code: string;
    style?: CSSProperties;
  }) =>
    createElement(
      "div",
      { "data-testid": "code-block", style },
      children,
      createElement("pre", null, code),
    ),
  CodeBlockActions: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CodeBlockCopyButton: (props: ComponentProps<"button">) =>
    createElement("button", { ...props, type: "button" }),
  CodeBlockHeader: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CodeBlockTitle: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CodeBlockWrapButton: (props: ComponentProps<"button">) =>
    createElement("button", { ...props, type: "button" }),
}));

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

const displayModel = {
  inlinePreview: { type: "none" as const },
  planResult: null,
  viewerSource: null,
  viewerLabelId: "codeViewer.viewCode" as const,
  showSummaryFileLink: false,
  showInput: false,
  showOutput: false,
  showKind: false,
};

function renderImageToolCall(source?: "browser_turn_end", imageCount = 1) {
  const toolCall = {
    toolId: source ? "tool-browser-turn-screenshot" : "tool-node-repl-image",
    toolName: "mcp__node_repl__js",
    kind: "mcp__node_repl__js",
    input: source ? { source } : { code: "nodeRepl.emitImage(await tab.screenshot());" },
    output: "",
    raw: {
      schemaVersion: 1,
      display: {
        kind: "node_repl_images",
        ...(source ? { source } : {}),
        images: Array.from({ length: imageCount }, (_, index) => ({
          base64: index === 0 ? "AAAA" : "BBBB",
          mimeType: "image/png",
        })),
      },
    },
    status: "completed" as const,
  };

  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
      createElement(
        StoreProvider,
        { broadcastService: mockBroadcastService },
        createElement(
          TooltipProvider,
          null,
          createElement(NodeReplToolCallBlock, {
            toolCallNode: { toolCall, childToolCalls: [] },
            workspacePath: "/workspace",
            displayModel,
            viewerSource: null,
            rawFileSummaries: [],
            isRunning: false,
            statusLabel: expectedCopy("chat.toolCall.status.completed"),
            childToolList: null,
            forceOpen: true,
            canToggle: true,
            showIcon: true,
          }),
        ),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("node repl tool interaction", () => {
  it("renders a short single-line result as secondary text instead of a code block", () => {
    const toolCall = {
      toolId: "tool-node-repl-compact-result",
      toolName: "js",
      kind: "js",
      input: {
        code: "return await tab.title();",
        title: "Read the page title",
      },
      output: { type: "text", value: "Example page" },
      status: "completed" as const,
    };

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(
          StoreProvider,
          { broadcastService: mockBroadcastService },
          createElement(
            TooltipProvider,
            null,
            createElement(NodeReplToolCallBlock, {
              toolCallNode: { toolCall, childToolCalls: [] },
              workspacePath: "/workspace",
              displayModel,
              viewerSource: null,
              rawFileSummaries: [],
              isRunning: false,
              statusLabel: expectedCopy("chat.toolCall.status.completed"),
              childToolList: null,
              forceOpen: true,
              canToggle: true,
              showIcon: true,
            }),
          ),
        ),
      ),
    );

    const resultSurface = screen.getByTestId("node-repl-result-surface");
    expect(resultSurface.textContent).toBe("Example page");
    expect(screen.queryByTestId("code-block")).toBeNull();
  });

  it.each([
    ["explicit Node REPL image", undefined],
    ["auto browser-turn-end image", "browser_turn_end" as const],
  ])("opens and closes the fullscreen preview for %s", async (_name, source) => {
    renderImageToolCall(source);

    const thumbnail = screen.getByRole("button", {
      name: `${expectedCopy("chat.attachments.preview.open")} 1`,
    });
    expect(screen.queryByTestId("node-repl-image-lightbox")).toBeNull();

    fireEvent.click(thumbnail);

    const previewImage = screen.getByTestId("node-repl-image-lightbox-image");
    expect(previewImage.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(previewImage.getAttribute("draggable")).toBe("false");
    expect(screen.getByText("100%")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: expectedCopy("markdownImage.download") }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: expectedCopy("markdownImage.previous") }),
    ).toBeNull();

    fireEvent.click(previewImage);
    expect(screen.getByTestId("node-repl-image-lightbox")).toBeTruthy();

    const previewViewport = previewImage.parentElement as HTMLDivElement;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    previewViewport.setPointerCapture = setPointerCapture;
    previewViewport.hasPointerCapture = vi.fn(() => true);
    previewViewport.releasePointerCapture = releasePointerCapture;

    fireEvent.pointerDown(previewViewport, {
      clientX: 100,
      clientY: 100,
      pointerId: 7,
    });
    fireEvent.pointerUp(previewViewport, {
      clientX: 100,
      clientY: 100,
      pointerId: 7,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);

    fireEvent.keyDown(screen.getByTestId("node-repl-image-lightbox"), {
      key: "Escape",
      code: "Escape",
    });
    await waitFor(() => expect(screen.queryByTestId("node-repl-image-lightbox")).toBeNull());
    expect(document.activeElement).toBe(thumbnail);

    fireEvent.click(thumbnail);
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.close") }));
    await waitFor(() => expect(screen.queryByTestId("node-repl-image-lightbox")).toBeNull());
    expect(document.activeElement).toBe(thumbnail);
  });

  it("groups Browser Use result images and navigates inside the shared preview", () => {
    renderImageToolCall(undefined, 2);

    fireEvent.click(
      screen.getByRole("button", { name: `${expectedCopy("chat.attachments.preview.open")} 1` }),
    );
    expect(screen.getByTestId("node-repl-image-lightbox-image").getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );

    fireEvent.click(screen.getByRole("button", { name: expectedCopy("markdownImage.next") }));
    expect(screen.getByTestId("node-repl-image-lightbox-image").getAttribute("src")).toBe(
      "data:image/png;base64,BBBB",
    );

    fireEvent.keyDown(screen.getByTestId("node-repl-image-lightbox"), {
      key: "ArrowLeft",
      code: "ArrowLeft",
    });
    expect(screen.getByTestId("node-repl-image-lightbox-image").getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("falls back to browser-native navigation when a remote image rejects CORS fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(ImagePreviewDialog, {
          initialIndex: 0,
          items: [
            {
              alt: "remote cat",
              src: "https://images.example.test/no-cors-cat.png",
            },
          ],
          onOpenChange: vi.fn(),
          open: true,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: expectedCopy("markdownImage.download") }));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(
      document.querySelector('a[href="https://images.example.test/no-cors-cat.png"]'),
    ).toBeNull();
  });

  it("navigates from an image to a video in the shared media gallery", () => {
    const onActiveIndexChange = vi.fn();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(ImagePreviewDialog, {
          initialIndex: 0,
          items: [
            { alt: "shot.png", mediaType: "image/png", src: "blob:image" },
            { alt: "demo.mp4", mediaType: "video/mp4", src: "blob:video" },
          ],
          onActiveIndexChange,
          onOpenChange: vi.fn(),
          open: true,
        }),
      ),
    );

    expect(screen.getByRole("img", { name: "shot.png" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: expectedCopy("markdownImage.download") }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: expectedCopy("markdownImage.next") }));

    const video = document.querySelector("video");
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    expect(video?.getAttribute("src")).toBe("blob:video");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(
      screen.queryByRole("button", { name: expectedCopy("markdownImage.download") }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: expectedCopy("markdownImage.zoomIn") })).toBeNull();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole("img", { name: "shot.png" })).not.toBeNull();
    expect(pause).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: expectedCopy("markdownImage.next") }));
    const reopenedVideo = document.querySelector("video");
    fireEvent.error(reopenedVideo!);
    expect(screen.getByRole("alert").textContent).toContain(
      expectedCopy("chat.attachments.preview.videoUnsupported"),
    );
    expect(
      screen.getByRole("button", { name: expectedCopy("markdownImage.previous") }),
    ).not.toBeNull();
  });

  it("does not navigate natively when Content-Length exceeds the Web download limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        body: new ReadableStream(),
        headers: new Headers({
          "content-length": String(50 * 1024 * 1024 + 1),
        }),
        ok: true,
      })),
    );
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(ImagePreviewDialog, {
          initialIndex: 0,
          items: [
            {
              alt: "large remote image",
              src: "https://images.example.test/large.png",
            },
          ],
          onOpenChange: vi.fn(),
          open: true,
        }),
      ),
    );

    const downloadButton = screen.getByRole("button", {
      name: expectedCopy("markdownImage.download"),
    }) as HTMLButtonElement;
    fireEvent.click(downloadButton);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: expectedCopy("markdownImage.download"),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(anchorClick).not.toHaveBeenCalled();
  });
});
