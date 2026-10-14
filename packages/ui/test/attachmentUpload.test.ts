import { describe, expect, it, vi } from "vitest";
import { uploadComposerAttachments, type AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";

describe("uploadComposerAttachments", () => {
  it("binds inline attachment refs to the requested session", async () => {
    const put = vi.fn<AttachmentPutFn>(async ({ sessionId }) => ({ ref: `artifact:${sessionId}` }));

    const refs = await uploadComposerAttachments(put, "worktree-session", [
      {
        kind: "image",
        filename: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataBase64: "AQID",
      },
    ]);

    expect(put).toHaveBeenCalledWith(
      {
        sessionId: "worktree-session",
        fileName: "screenshot.png",
        mime: "image/png",
        dataBase64: "AQID",
      },
      undefined,
    );
    expect(refs).toEqual([
      { ref: "artifact:worktree-session", fileName: "screenshot.png", mime: "image/png", bytes: 3 },
    ]);
  });
});
