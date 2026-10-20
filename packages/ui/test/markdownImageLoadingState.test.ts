/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownImage } from "@/components/ai-elements/markdown-image.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

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
      createElement(MarkdownImage, { alt: "Sample image", src, workspacePath }),
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
  it("shows the loading state until a remote image finishes loading, then shows the image", () => {
    renderMarkdownImage("https://example.com/image.png");

    expect(screen.getByRole("status", { name: expectedCopy("common.loading") })).toBeTruthy();
    const image = screen.getByRole("img", { name: "Sample image" });
    expect(image.className).toContain("invisible");

    fireEvent.load(image);

    expect(screen.queryByRole("status")).toBeNull();
    expect(image.className).not.toContain("invisible");
  });

  it("shows the unavailable state after a remote image fails to load", () => {
    renderMarkdownImage("https://example.com/missing.png");

    fireEvent.error(screen.getByRole("img", { name: "Sample image" }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("img", { name: expectedCopy("codeViewer.imageUnavailable") }),
    ).not.toBeNull();
  });

  it("ignores failure events from the old image after src changes", () => {
    const view = renderMarkdownImage("https://example.com/old.png");
    const oldImage = screen.getByRole("img", { name: "Sample image" });

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(MarkdownImage, {
          alt: "Sample image",
          src: "https://example.com/new.png",
        }),
      ),
    );
    fireEvent.error(oldImage);

    expect(screen.getByRole("status", { name: expectedCopy("common.loading") })).not.toBeNull();
    expect(screen.queryByLabelText(expectedCopy("codeViewer.imageUnavailable"))).toBeNull();
  });

  it("cleans up the focus restoration task scheduled after the preview closes on unmount", () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = renderMarkdownImage("https://example.com/image.png");
    const image = screen.getByRole("img", { name: "Sample image" });
    fireEvent.load(image);
    fireEvent.click(
      screen.getByRole("button", { name: expectedCopy("chat.attachments.preview.open") }),
    );
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.close") }));
    focus.mockClear();

    view.unmount();
    vi.runAllTimers();

    expect(focus).not.toHaveBeenCalled();
  });

  it("shows the failure state when local preview data cannot be decoded", async () => {
    optionalServices = {
      fileService: {
        readMediaPreview: async () => ({
          dataBase64: "broken",
          mediaType: "image/png",
        }),
      },
    };
    renderMarkdownImage("./broken.png", "/workspace");

    const image = await waitFor(() => screen.getByRole("img", { name: "Sample image" }));
    fireEvent.error(image);

    expect(
      screen.getByRole("img", { name: expectedCopy("codeViewer.imageUnavailable") }),
    ).not.toBeNull();
  });
});
