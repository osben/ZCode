/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownImage } from "@/components/ai-elements/markdown-image.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

let optionalServices: {
  fileService: {
    readMediaPreview: () => Promise<{
      dataBase64: string;
      mediaType: string;
    }>;
  };
} | null = null;

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => optionalServices,
}));

function renderMarkdownImage(src: string, workspacePath?: string) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(MarkdownImage, { alt: "示例图", src, workspacePath }),
    ),
  );
}

afterEach(() => {
  cleanup();
  optionalServices = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MarkdownImage loading state", () => {
  it("远程图片加载完成前显示状态，完成后显示图片", () => {
    renderMarkdownImage("https://example.com/image.png");

    const loading = screen.getByRole("status");
    expect(loading.className).toContain("markdown-image-loading-shimmer");
    expect(loading.querySelector("svg")).not.toBeNull();
    const trigger = document.querySelector<HTMLButtonElement>("[data-markdown-image-trigger]")!;
    expect(trigger.className.split(" ")).toContain("!w-44");
    expect(trigger.className.split(" ")).toContain("!h-44");
    const image = document.querySelector<HTMLImageElement>("img[data-markdown-image]")!;
    expect(image.className).toContain("invisible");

    fireEvent.load(image);

    expect(screen.queryByRole("status")).toBeNull();
    expect(trigger.className.split(" ")).not.toContain("!w-44");
    expect(trigger.className.split(" ")).not.toContain("!h-44");
    expect(image.className).not.toContain("invisible");
  });

  it("远程图片加载失败后显示不可用状态", () => {
    renderMarkdownImage("https://example.com/missing.png");

    fireEvent.error(document.querySelector<HTMLImageElement>("img[data-markdown-image]")!);

    expect(screen.queryByRole("status")).toBeNull();
    const unavailable = document.querySelector('[data-markdown-image-state="error"]')!;
    expect(unavailable.querySelector("svg")).not.toBeNull();
  });

  it("src 切换后忽略旧图片的失败事件", () => {
    const view = renderMarkdownImage("https://example.com/old.png");
    const oldImage = document.querySelector<HTMLImageElement>("img[data-markdown-image]")!;

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(MarkdownImage, {
          alt: "示例图",
          src: "https://example.com/new.png",
        }),
      ),
    );
    fireEvent.error(oldImage);

    expect(screen.getByRole("status")).not.toBeNull();
    expect(document.querySelector('[data-markdown-image-state="error"]')).toBeNull();
  });

  it("卸载时清理预览关闭后的焦点恢复任务", () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = renderMarkdownImage("https://example.com/image.png");
    const image = document.querySelector<HTMLImageElement>("img[data-markdown-image]")!;
    fireEvent.load(image);
    fireEvent.click(document.querySelector("[data-markdown-image-trigger]")!);
    fireEvent.click(document.querySelector('[role="dialog"] button')!);
    focus.mockClear();

    view.unmount();
    vi.runAllTimers();

    expect(focus).not.toHaveBeenCalled();
  });

  it("本地预览数据无法解码时显示失败状态", async () => {
    optionalServices = {
      fileService: {
        readMediaPreview: async () => ({
          dataBase64: "broken",
          mediaType: "image/png",
        }),
      },
    };
    renderMarkdownImage("./broken.png", "/workspace");

    const image = await waitFor(() => screen.getByRole("img"));
    fireEvent.error(image);

    expect(document.querySelector('[data-markdown-image-state="error"]')).not.toBeNull();
  });
});
