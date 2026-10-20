import { describe, expect, it } from "vitest";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";

describe("normalizeConversationShareMarkdown", () => {
  it("removes local citation paths while retaining a uniquely matched public artifact name", () => {
    const markdown =
      '结论见 ::zcode-file-citation{path="/Users/demo/report.pdf" purpose="output"}。';
    const result = normalizeConversationShareMarkdown(
      markdown,
      new Map([["share-artifact-1", "report.pdf"]]),
    );

    expect(result).toBe("结论见 report.pdf。");
  });

  it("does not rewrite citation-looking text inside a fenced code block", () => {
    const markdown = ["```md", '::zcode-file-citation{path="example.pdf"}', "```"].join("\n");

    expect(normalizeConversationShareMarkdown(markdown)).toBe(markdown);
  });

  // Bug regression: without workspacePath/readAttachment the public share page's MarkdownImage falls back to
  // <img src={remote}>, firing cross-origin requests automatically in anonymous visitors' browsers — equivalent
  // to a publisher-controlled tracking pixel (leaking IP/UA/Referer). Remote images are downgraded to links; requests happen only on click.
  describe("远程图片降级", () => {
    it("把 http/https 图片降级为普通链接", () => {
      expect(normalizeConversationShareMarkdown("![图](https://evil.example/x.png)")).toBe(
        "[图](https://evil.example/x.png)",
      );
      expect(normalizeConversationShareMarkdown("![图](http://evil.example/x.png)")).toBe(
        "[图](http://evil.example/x.png)",
      );
    });

    it("覆盖 title 与尖括号写法，以及协议相对地址", () => {
      expect(normalizeConversationShareMarkdown('![图](https://evil.example/x.png "标题")')).toBe(
        '[图](https://evil.example/x.png "标题")',
      );
      expect(normalizeConversationShareMarkdown("![图](<https://evil.example/a b.png>)")).toBe(
        "[图](<https://evil.example/a b.png>)",
      );
      expect(normalizeConversationShareMarkdown("![图](//evil.example/x.png)")).toBe(
        "[图](//evil.example/x.png)",
      );
    });

    it("保留 data: 与相对路径图片", () => {
      const dataImage = "![本地](data:image/png;base64,AAAA)";
      expect(normalizeConversationShareMarkdown(dataImage)).toBe(dataImage);
      const relative = "![本地](./assets/x.png)";
      expect(normalizeConversationShareMarkdown(relative)).toBe(relative);
    });

    it("不改写代码围栏内的远程图片语法", () => {
      const markdown = ["```md", "![图](https://evil.example/x.png)", "```"].join("\n");
      expect(normalizeConversationShareMarkdown(markdown)).toBe(markdown);
    });

    it("同一段里的多张远程图片全部降级", () => {
      expect(
        normalizeConversationShareMarkdown(
          "前 ![a](https://a.example/1.png) 中 ![b](https://b.example/2.png) 后",
        ),
      ).toBe("前 [a](https://a.example/1.png) 中 [b](https://b.example/2.png) 后");
    });

    it("与 citation 剥离同时生效", () => {
      const result = normalizeConversationShareMarkdown(
        '![图](https://evil.example/x.png) 见 ::zcode-file-citation{path="/Users/demo/report.pdf"}。',
        new Map([["share-artifact-1", "report.pdf"]]),
      );
      expect(result).toBe("[图](https://evil.example/x.png) 见 report.pdf。");
    });
  });
});
