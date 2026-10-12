import { describe, expect, it } from "vitest";

import {
  parseConversationShareContext,
  resolveAttachableShareContext,
} from "@/lib/conversationShareContext.js";

/** Trailing share URL blocks that may remain in historical messages; the writer side was removed, so this only verifies the reader strips them cleanly. */
function withShareContextBlock(text: string, payload: Record<string, unknown>): string {
  const block = [
    "# zcode-share-context:",
    "```zcode-share-context",
    JSON.stringify(payload),
    "```",
  ].join("\n");
  return text ? `${text}\n\n${block}` : block;
}

describe("conversation share context reference", () => {
  it("把历史消息里的 share URL 尾块从可见正文剥掉", () => {
    const encoded = withShareContextBlock("继续分析", {
      contextId: "context-1",
      shareUrl: "https://zcode.z.ai/cn/share/share-1",
    });
    expect(parseConversationShareContext(encoded)).toEqual({
      visibleContent: "继续分析",
      reference: {
        contextId: "context-1",
        shareUrl: "https://zcode.z.ai/cn/share/share-1",
      },
    });
  });

  it("rejects signed/download URLs and unknown fields", () => {
    const parsed = parseConversationShareContext(
      [
        "继续分析",
        "",
        "# zcode-share-context:",
        "```zcode-share-context",
        JSON.stringify({
          contextId: "context-1",
          shareUrl: "https://signed.example/download?token=secret",
          markdown: "must-not-cross-ui",
        }),
        "```",
      ].join("\n"),
    );
    expect(parsed.reference).toBeNull();
    expect(parsed.visibleContent).toContain("# zcode-share-context:");
  });
});

/**
 * Production incident regression: the composer used to read handover context from a parallel
 * sharedContextImport prop that SessionPane never passed. As a result the first message never carried
 * sharedContextRefs, the CLI could not advance a single step of pending→reserved→attached, and the
 * hydrator permanently skipped the shared_context message — the read-only block still showed at the top of the conversation while the model never received the shared content, invisible to the eye.
 *
 * It is now derived from the snapshot. These tests pin the "when should refs be attached" decision itself.
 */
describe("resolveAttachableShareContext", () => {
  const pending = {
    contextId: "context-1",
    title: "来自分享：X",
    shareUrl: "https://zcode.z.ai/cn/share/share-1",
    status: "pending",
  };

  it("pending 必须可 attach —— 否则模型永远拿不到分享内容", () => {
    expect(resolveAttachableShareContext(pending)).toEqual(pending);
  });

  it("reserved（已进队列但还没消费）仍然可 attach", () => {
    expect(resolveAttachableShareContext({ ...pending, status: "reserved" })?.status).toBe(
      "reserved",
    );
  });

  it("discarded 不再 attach", () => {
    expect(resolveAttachableShareContext({ ...pending, status: "discarded" })).toBeNull();
  });

  it("legacy 形状（只有 title、没有 contextId）不 attach：构不出 refs", () => {
    expect(resolveAttachableShareContext({ title: "来自分享：X" })).toBeNull();
  });

  it("没有 handover context 时返回 null", () => {
    expect(resolveAttachableShareContext(null)).toBeNull();
    expect(resolveAttachableShareContext(undefined)).toBeNull();
  });
});
