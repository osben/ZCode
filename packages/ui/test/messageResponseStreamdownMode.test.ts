import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildMessageFileLinkTarget,
  buildMessageStreamdownRenderKey,
  messageResponsePropsAreEqual,
  MessageResponse,
  openMessageFileLinkInEditor,
  resolveMessageStreamdownMode,
} from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 13,
        lightTheme: "github-light",
        wrapLongLines: true,
      },
      theme: "zai-light",
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getInstalledEditors: vi.fn().mockResolvedValue([]),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
  }),
  useOptionalPlatform: () => ({
    getInstalledEditors: vi.fn().mockResolvedValue([]),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

describe("resolveMessageStreamdownMode", () => {
  it("invalidates memoized artifact images when their session or reader changes", () => {
    const readAttachment = vi.fn();
    const base = {
      children: "![CUA](zcode-artifact://session-1/shot)",
      sessionId: "session-1",
      readAttachment,
    };

    expect(messageResponsePropsAreEqual(base, base)).toBe(true);
    expect(messageResponsePropsAreEqual(base, { ...base, sessionId: "session-2" })).toBe(false);
    expect(messageResponsePropsAreEqual(base, { ...base, readAttachment: vi.fn() })).toBe(false);
  });

  it("keeps pathKind for Markdown directory links and the remote workspace scope", () => {
    expect(
      buildMessageFileLinkTarget({
        href: "./src/",
        label: "src",
        path: "/workspace/repo/src/",
        workspacePath: "/workspace/repo",
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
        workspaceRemoteSessionId: "wsl-session",
      }),
    ).toEqual({
      path: "/workspace/repo/src/",
      label: "src",
      pathKind: "directory",
      relativePath: "src",
      workspacePath: "/workspace/repo",
      workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
      workspaceRemoteSessionId: "wsl-session",
    });
  });

  it.each([
    ["./src/App.tsx", "/workspace/repo/src/App.tsx"],
    ["./config", "/workspace/repo/config"],
    ["/etc/hosts", "/etc/hosts"],
  ])("Markdown file link %s does not guess the file system type during render", (href, path) => {
    expect(
      buildMessageFileLinkTarget({
        href,
        label: "file",
        path,
        workspacePath: "/workspace/repo",
      }).pathKind,
    ).toBeUndefined();
  });

  it.each(["file", "directory"] as const)(
    "Markdown open passes the real %s type through workspace stat",
    async (type) => {
      const statFile = vi.fn().mockResolvedValue({ type });
      const openInEditor = vi.fn().mockResolvedValue({ success: true });
      const fileLink = buildMessageFileLinkTarget({
        href: "./config",
        label: "config",
        path: "/workspace/repo/config",
        workspacePath: "/workspace/repo",
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
      });
      const remoteTarget = { kind: "wsl" as const, distro: "Ubuntu" };

      await expect(
        openMessageFileLinkInEditor({
          editorId: "vscode",
          fileLink,
          openInEditor,
          remoteTarget,
          statFile,
        }),
      ).resolves.toEqual({ success: true });

      expect(statFile).toHaveBeenCalledWith({ path: "/workspace/repo/config" });
      expect(openInEditor).toHaveBeenCalledWith("vscode", "/workspace/repo/config", {
        pathKind: type,
        remoteTarget,
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
      });
    },
  );

  it("Markdown open does not call the local editor when stat fails", async () => {
    const statFile = vi.fn().mockRejectedValue(new Error("path not found"));
    const openInEditor = vi.fn();
    const fileLink = buildMessageFileLinkTarget({
      href: "./config",
      label: "config",
      path: "/workspace/repo/config",
      workspacePath: "/workspace/repo",
    });

    await expect(
      openMessageFileLinkInEditor({
        editorId: "vscode",
        fileLink,
        openInEditor,
        statFile,
      }),
    ).rejects.toThrow("path not found");
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("out-of-bounds relative Markdown links do not produce a clickable file action target", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          workspacePath: "/workspace",
          onOpenFileLink: vi.fn(),
        },
        "[private](foo/../../private.pdf)",
      ),
    );

    expect(html).toContain("private");
    expect(html).not.toContain("/workspace/foo/../../private.pdf");
    expect(html).not.toContain("cursor-pointer");
  });

  it("Assistant citations render through the existing file links while plain file names stay verbatim", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          [
            "Plain file report.pdf.",
            ':zcode-file-citation{path="docs/年度 报告.pdf" purpose="output" page_number=2}',
            ':::zcode-file-citation{path="docs/论文.pdf" purpose="source"}',
          ].join("\n\n"),
        ),
      ),
    );

    expect(html).toContain("Plain file report.pdf");
    expect(html).not.toContain(":zcode-file-citation");
    expect(html).toContain("<button");
    expect(html).toContain('title="/workspace/docs/年度 报告.pdf"');
    expect(html).toContain('title="/workspace/docs/论文.pdf"');
    expect(html).toContain("年度 报告.pdf");
  });

  it("citations and Markdown file links accept smart quotes without polluting paths", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          [
            'Planning done. Generated: :zcode-file-citation{path=“/workspace/冰岛 行程.pdf” purpose="output"}',
            "[Notes](‘docs/说明.md’)",
          ].join("\n\n"),
        ),
      ),
    );

    expect(html).toContain('title="/workspace/冰岛 行程.pdf"');
    expect(html).toContain('title="/workspace/docs/说明.md"');
    expect(html).not.toContain("/workspace/“");
    expect(html).not.toContain("说明.md’");
    expect(html).not.toContain("[blocked]");
  });

  it("streaming hides an unclosed citation while text after an abnormal newline stays visible", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            streaming: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          'Body text\n::zcode-file-citation{path="docs/report.pdf"',
        ),
      ),
    );
    expect(html).toContain("Body text");
    expect(html).not.toContain("::zcode-file-citation");

    const malformedHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            streaming: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          'Body text\n::zcode-file-citation{path="docs/report.pdf"\nFollow-up notes stay visible.',
        ),
      ),
    );
    expect(malformedHtml).toContain("Follow-up notes stay visible.");
  });

  it.each([
    ["drive-letter path", String.raw`C:\Users\demo\年度 报告.pdf`, "C:/Users/demo/年度 报告.pdf"],
    ["Windows file URL", "file:///C:/Users/demo/report.pdf", "C:/Users/demo/report.pdf"],
  ])(
    "Windows %s in an Assistant citation stays clickable after harden",
    (_case, path, resolvedPath) => {
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(
            MessageResponse,
            {
              renderZCodeFileCitations: true,
              workspacePath: "C:\\workspace",
              onOpenFileLink: vi.fn(),
            },
            `::zcode-file-citation{path="${path}" purpose="output"}`,
          ),
        ),
      );

      expect(html).not.toContain("[blocked]");
      expect(html).toContain("<button");
      expect(html).toContain(`title="${resolvedPath}"`);
    },
  );

  it("out-of-bounds citations stay verbatim and produce no file link", () => {
    const directive = '::zcode-file-citation{path="foo/../../private.pdf"}';
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          renderZCodeFileCitations: true,
          workspacePath: "/workspace",
          onOpenFileLink: vi.fn(),
        },
        directive,
      ),
    );

    expect(html).toContain("::zcode-file-citation");
    expect(html).not.toContain('title="/workspace/foo/../../private.pdf"');
  });

  it("citations are not parsed inside code nodes and Streamdown's default GFM tables are preserved", () => {
    const directive = '::zcode-file-citation{path="docs/report.pdf"}';
    const compatibilityDirective = ':zcode-file-citation{path="docs/legacy.pdf"}';
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(
            MessageResponse,
            {
              renderZCodeFileCitations: true,
              workspacePath: "/workspace",
              onOpenFileLink: vi.fn(),
            },
            [
              `\`${directive}\``,
              `\`${compatibilityDirective}\``,
              "",
              "| File | Status |",
              "| --- | --- |",
              "| report.pdf | done |",
            ].join("\n"),
          ),
        ),
      ),
    );

    expect(html).toContain("::zcode-file-citation");
    expect(html).toContain(":zcode-file-citation");
    expect(html).toContain("<table");
    expect(html).not.toContain('title="/workspace/docs/report.pdf"');
    expect(html).not.toContain('title="/workspace/docs/legacy.pdf"');
  });

  it.each([
    [
      "drive letter with forward slashes",
      "[报告](C:/Users/demo/report.md)",
      "C:/Users/demo/report.md",
    ],
    [
      "drive letter with backslashes",
      String.raw`[报告](C:\Users\demo\report.md)`,
      "C:/Users/demo/report.md",
    ],
    ["Windows file URL", "[报告](file:///C:/Users/demo/report.md)", "C:/Users/demo/report.md"],
    [
      "path with CJK and spaces",
      "[报告](<C:/Users/demo/中文 目录/report.md>)",
      "C:/Users/demo/中文 目录/report.md",
    ],
  ])(
    "Windows absolute Markdown links (%s) stay clickable after harden",
    (_case, markdown, path) => {
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(
            MessageResponse,
            {
              workspacePath: "C:\\workspace",
              onOpenFileLink: vi.fn(),
            },
            markdown,
          ),
        ),
      );

      expect(html).not.toContain("[blocked]");
      expect(html).toContain("<button");
      expect(html).toContain(`title="${path}"`);
    },
  );

  it("Windows absolute Markdown links stay clickable after harden in a UNC workspace", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          MessageResponse,
          {
            workspacePath: "\\\\server\\share\\repo",
            onOpenFileLink: vi.fn(),
          },
          "[报告](C:/Users/demo/report.md)",
        ),
      ),
    );

    expect(html).not.toContain("[blocked]");
    expect(html).toContain("<button");
    expect(html).toContain('title="C:/Users/demo/report.md"');
  });

  it.each([
    ["drive letter with forward slashes", "![截图](C:/Users/demo/screenshot.png)"],
    ["drive letter with backslashes", String.raw`![截图](C:\Users\demo\screenshot.png)`],
    ["Windows file URL", "![截图](file:///C:/Users/demo/screenshot.png)"],
  ])(
    "Windows absolute Markdown images (%s) keep the local path after harden",
    (_case, markdown) => {
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(MessageResponse, { workspacePath: "C:\\workspace" }, markdown),
        ),
      );

      expect(html).not.toContain("[blocked]");
      expect(html).toContain('data-markdown-local-image="loading"');
      expect(html).toContain('title="C:/Users/demo/screenshot.png"');
    },
  );

  it("Windows absolute Markdown images keep the local path after harden in a UNC workspace", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          MessageResponse,
          { workspacePath: "\\\\server\\share\\repo" },
          "![截图](C:/Users/demo/screenshot.png)",
        ),
      ),
    );

    expect(html).not.toContain("[blocked]");
    expect(html).toContain('data-markdown-local-image="loading"');
    expect(html).toContain('title="C:/Users/demo/screenshot.png"');
  });

  it("bare file names in body text stay plain while GFM tables render normally", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(
            MessageResponse,
            {
              workspacePath: "/workspace",
            },
            [
              "| Item | Status |",
              "| --- | --- |",
              "| Word doc | ✅ |",
              "",
              "Generated report.docx.",
            ].join("\n"),
          ),
        ),
      ),
    );

    expect(html).toContain("<table");
    expect(html).toContain("Generated report.docx.");
    expect(html).not.toMatch(/title="[^"]*report\.docx"/);
  });

  it.each([false, true])("only double tildes render strikethrough (streaming=%s)", (streaming) => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { streaming, workspacePath: "/workspace" },
        "~single tilde~ and ~~double tilde~~following text",
      ),
    );

    expect(html).toContain("~single tilde~");
    expect(html).not.toContain("<del>single tilde</del>");
    expect(html).toContain("<del>double tilde</del>following text");
  });

  it("keeps completed messages on Streamdown static mode", () => {
    expect(resolveMessageStreamdownMode(false)).toBe("static");
  });

  it("uses Streamdown streaming mode only while the message is actively streaming", () => {
    expect(resolveMessageStreamdownMode(true)).toBe("streaming");
  });

  it("changes the Streamdown render key when code block rendering settings change", () => {
    const base = buildMessageStreamdownRenderKey({
      codeBlockTheme: "github-light",
      fontSizePx: 12,
      workspacePath: "/workspace",
      wrapLongLines: false,
    });

    expect(
      buildMessageStreamdownRenderKey({
        codeBlockTheme: "github-dark",
        fontSizePx: 12,
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
    expect(
      buildMessageStreamdownRenderKey({
        codeBlockTheme: "github-light",
        fontSizePx: 13,
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
    expect(
      buildMessageStreamdownRenderKey({
        codeBlockTheme: "github-light",
        fontSizePx: 12,
        workspacePath: "/workspace",
        wrapLongLines: true,
      }),
    ).not.toBe(base);
  });

  it("changes the Streamdown render key with artifact permission context", () => {
    const base = buildMessageStreamdownRenderKey({
      attachmentReaderEpoch: 1,
      codeBlockTheme: "github-light",
      fontSizePx: 12,
      sessionId: "session-a",
      workspacePath: "/workspace",
      wrapLongLines: false,
    });

    expect(
      buildMessageStreamdownRenderKey({
        attachmentReaderEpoch: 1,
        codeBlockTheme: "github-light",
        fontSizePx: 12,
        sessionId: "session-b",
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
    expect(
      buildMessageStreamdownRenderKey({
        attachmentReaderEpoch: 2,
        codeBlockTheme: "github-light",
        fontSizePx: 12,
        sessionId: "session-a",
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
  });

  it("renders single-dollar inline math as KaTeX", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "where $c(\\mathbf{r})$ is the speed of sound and $\\omega=2\\pi f$ is the angular frequency.",
      ),
    );

    expect(html).toContain("katex");
    expect(html).not.toContain("$c(\\mathbf{r})$");
    expect(html).not.toContain("$\\omega=2\\pi f$");
  });

  it("rewrites assistant artifact images before Streamdown hardening", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          MessageResponse,
          {
            workspacePath: "/workspace",
            sessionId: "session-1",
            readAttachment: async () => ({
              bytes: new Uint8Array([1]),
              mediaType: "image/png",
            }),
          },
          "![CUA](zcode-artifact://session-1/shot)",
        ),
      ),
    );

    expect(html).toContain('data-markdown-local-image="loading"');
    expect(html).not.toContain("Image blocked");
    expect(html).not.toContain("zcode-artifact://");
  });

  it("keeps paired currency dollars as text", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "Pricing is $5 today and $10 tomorrow.",
      ),
    );

    expect(html).not.toContain("katex");
    expect(html).toContain("Pricing is $5 today and $10 tomorrow.");
  });

  it("keeps compact currency ranges as text", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "Pricing is $5-$10 depending on usage.",
      ),
    );

    expect(html).not.toContain("katex");
    expect(html).toContain("Pricing is $5-$10 depending on usage.");
  });

  it("keeps paired shell environment dollars as text", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "Use $HOME and $PATH to inspect environment variables.",
      ),
    );

    expect(html).not.toContain("katex");
    expect(html).toContain("Use $HOME and $PATH to inspect environment variables.");
  });
});

it("general-mode answers keep the code container and copy entry, lock the wrap entry, and re-render on mode change", () => {
  const codePreviewSettings = {
    darkTheme: "github-dark",
    lightTheme: "github-light",
    fontSizePx: 13,
    wrapLongLines: false,
  };
  const props = { children: "```python\nprint('MODE_CODE_RETAINED')\n```", codePreviewSettings };
  const render = (forceCodeWrap: boolean) =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(MessageResponse, { ...props, forceCodeWrap }),
        ),
      ),
    );
  const general = render(true);
  expect(general).toContain('data-language="python"');
  expect(general).toContain(expectedCopy("codeBlock.copyCode"));
  expect(general).not.toContain(expectedCopy("codeBlock.wrapLines"));
  expect(render(false)).toContain(expectedCopy("codeBlock.wrapLines"));
  expect(codePreviewSettings.wrapLongLines).toBe(false);
  expect(
    messageResponsePropsAreEqual(
      { ...props, forceCodeWrap: true },
      { ...props, forceCodeWrap: false },
    ),
  ).toBe(false);
});
