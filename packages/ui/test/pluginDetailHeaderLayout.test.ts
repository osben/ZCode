import { describe, expect, it } from "vitest";
import { resolveExamplePromptDocumentIcon } from "@/settings/PluginStoreDetailView.js";

describe("Plugin detail header layout", () => {
  it("maps document examples to the bundled product icons", () => {
    expect(resolveExamplePromptDocumentIcon("把我的笔记整理成一份排版好的 Word 文档")).toBe(
      "documents",
    );
    expect(resolveExamplePromptDocumentIcon("把这份 PDF 里的表格提取成电子表格")).toBe("pdf");
    expect(resolveExamplePromptDocumentIcon("用这份 CSV 做一份带图表的 Excel 工作簿")).toBe(
      "spreadsheets",
    );
    expect(resolveExamplePromptDocumentIcon("Summarize this attachment")).toBe("documents");
  });
});
