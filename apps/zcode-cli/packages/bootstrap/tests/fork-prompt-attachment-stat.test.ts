import { describe, expect, it } from "vitest";
import { statPromptAttachmentDataUrl } from "../src/app/fork-prompt-attachment-stat.js";

// Bug: Share's attachment stat of an uploaded attachment reported the stored artifact (the base64 data URL's length,
// `text/plain` from the `.txt` file name) while the read served the decoded bytes with the data URL's media type.
describe("statPromptAttachmentDataUrl", () => {
  const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

  it("reports the decoded size and media type the read serves", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1000]) {
      const bytes = Buffer.alloc(length, 7);
      expect(statPromptAttachmentDataUrl(dataUrl("image/PNG", bytes), "image/png")).toEqual({
        totalBytes: length,
        mediaType: "image/png",
      });
    }
  });

  it("takes the part's media type when the header names none", () => {
    expect(statPromptAttachmentDataUrl("data:;base64,JVBERg==", "application/pdf")).toEqual({
      totalBytes: 4,
      mediaType: "application/pdf",
    });
  });

  it("refuses content that is not a strict base64 data URL", () => {
    for (const content of [
      "plain text",
      "data:image/png,AAAA",
      "data:image/png;base64,AAA",
      "data:image/png;base64,AA!A",
    ]) {
      expect(statPromptAttachmentDataUrl(content, "image/png")).toBeUndefined();
    }
  });
});
