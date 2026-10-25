// @vitest-environment jsdom
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampMarkdownImagePreviewOffset,
  MarkdownImage,
  normalizeConsecutiveMarkdownImageBlocks,
} from "@/components/ai-elements/markdown-image.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { rewriteMarkdownArtifactImageSources } from "@zcode/shared";
import { sanitizeImageSourceForLog } from "@/components/ai-elements/image-preview-dialog.js";

afterEach(() => vi.restoreAllMocks());

describe("artifact-backed Markdown images", () => {
  it("reads an authorized session artifact instead of passing its custom URI to img", async () => {
    const ref = "zcode-artifact://session-1/cua-shot";
    const rewritten = rewriteMarkdownArtifactImageSources(`![shot](${ref})`);
    const src = rewritten.match(/!\[shot\]\(([^)]+)\)/u)?.[1] ?? "";
    const readAttachment = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cua-shot");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const rendered = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(MarkdownImage, {
          alt: "shot",
          src,
          sessionId: "session-1",
          readAttachment,
        }),
      ),
    );

    await waitFor(() =>
      expect(rendered.container.querySelector("img")?.getAttribute("src")).toBe("blob:cua-shot"),
    );
    expect(readAttachment).toHaveBeenCalledWith({ sessionId: "session-1", ref });
    expect(rendered.container.innerHTML).not.toContain("zcode-artifact://");
    rendered.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:cua-shot");
  });
});

describe("sanitizeImageSourceForLog", () => {
  it("strips identity, signature parameters, and fragments from remote image URLs", () => {
    const sanitized = sanitizeImageSourceForLog(
      "https://user:pass@example.com/a.png?token=secret#fragment",
    );
    expect(sanitized).toBe("https://example.com/a.png");
  });

  it("does not write Base64 image contents to logs", () => {
    expect(sanitizeImageSourceForLog("data:image/png;base64,SECRET")).toBe("data-url");
  });
});

describe("normalizeConsecutiveMarkdownImageBlocks", () => {
  it("only removes blank lines between consecutive pure image blocks", () => {
    expect(
      normalizeConsecutiveMarkdownImageBlocks(
        "intro\n\n![one](one.png)\n\n![two](two.png)\n\ncaption",
      ),
    ).toBe("intro\n\n![one](one.png)\n![two](two.png)\n\ncaption");
  });

  it("does not rewrite image syntax inside code fences", () => {
    const markdown = "```md\n![one](one.png)\n\n![two](two.png)\n```";
    expect(normalizeConsecutiveMarkdownImageBlocks(markdown)).toBe(markdown);
  });

  it.each([
    [
      "four backticks are not closed by three backticks",
      "````md\n```\n![one](one.png)\n\n![two](two.png)\n````",
    ],
    [
      "four tildes are not closed by three tildes",
      "~~~~md\n~~~\n![one](one.png)\n\n![two](two.png)\n~~~~",
    ],
    ["an unclosed fence extends to the end of input", "```md\n![one](one.png)\n\n![two](two.png)"],
    ["opening fence with info string", "````markdown\n![one](one.png)\n\n![two](two.png)\n````"],
  ])("%s", (_name, markdown) => {
    expect(normalizeConsecutiveMarkdownImageBlocks(markdown)).toBe(markdown);
  });
});

describe("clampMarkdownImagePreviewOffset", () => {
  it("keeps the image centered when it fits the canvas", () => {
    expect(
      clampMarkdownImagePreviewOffset(
        { x: 80, y: -60 },
        1,
        { width: 400, height: 300 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("clamps the drag bounds once the image is zoomed in", () => {
    expect(
      clampMarkdownImagePreviewOffset(
        { x: 500, y: -500 },
        2,
        { width: 600, height: 400 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 200, y: -100 });
  });
});
