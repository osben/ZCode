// WebFetch HTML→Markdown 实体解码单测：
// &amp; 必须最后解码，否则双重编码实体（&amp;lt; 等）被解码两次，
// 字面标签会在送入模型的文本中"复活"（CodeQL js/double-escaping，告警 #66）。
import { describe, expect, it } from "vitest";
import { extractReadableContent } from "../src/tool/handlers/webfetch-content.js";

function htmlPage(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

describe("extractReadableContent entity decoding", () => {
  it("decodes single-encoded entities normally", () => {
    const out = extractReadableContent(htmlPage("<p>&lt;b&gt; &amp; &quot;q&quot;</p>"), "text/html");
    expect(out).toContain('<b> & "q"');
  });

  it("decodes double-encoded entities exactly once", () => {
    const out = extractReadableContent(htmlPage("<p>&amp;lt;script&amp;gt;</p>"), "text/html");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("keeps numeric-encoded ampersand references single-decoded", () => {
    const out = extractReadableContent(htmlPage("<p>&amp;#38;</p>"), "text/html");
    expect(out).toContain("&#38;");
    expect(out).not.toContain("&#38;#38;");
  });
});
