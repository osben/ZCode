// Recovery context snapshot (specs/composer-worktree-setup-steps.md "recovery record is a typed
// snapshot of the entire frozen submission"): store round-trip incl. old-record compatibility, and
// restore dispatching the frozen contexts through the same add paths a fresh attach uses.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  getV4WorktreeRecoveryScope,
} from "@/v4/composer/composerDraftStore.js";
import { restoreComposerRecoveryContexts } from "@/v4/composer/composerRecoveryContexts.js";
import {
  CODE_COMMENT_ADD_TO_CHAT_EVENT,
  type CodeCommentPayload,
} from "@/lib/codeCommentContext.js";
import {
  getConversationSelectionReferenceScope,
  setConversationSelectionReferenceScope,
  type MarkdownSelectionReference,
} from "@/lib/conversationSelectionReference.js";
import { PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT } from "@/lib/pptxElementReference.js";
import { WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT } from "@/lib/webElementContext.js";

const WORKSPACE = "/recovery-contexts";
const WORKSPACE_KEY = WORKSPACE;

function markdownReference(id: string, text: string): MarkdownSelectionReference {
  return {
    id,
    contentType: "markdown",
    text,
    path: "docs/readme.md",
    senderName: "dev",
    senderId: "dev",
    messageId: "msg-1",
    sentAt: 1,
    sourceKey: "docs/readme.md",
    sourceTitle: "readme",
  };
}

function codeCommentPayload(id: string, comment: string): CodeCommentPayload {
  return {
    id,
    startLine: 3,
    endLine: 5,
    workspacePath: WORKSPACE,
    sourcePath: "src/a.ts",
    sourceTitle: "a.ts",
    selectedText: "const a = 1;",
    comment,
  };
}

afterEach(() => {
  localStorage.clear();
});

describe("recovery context snapshot persistence", () => {
  it("round-trips the typed contexts with a recovery record", () => {
    const scope = getV4WorktreeRecoveryScope("session-1", "submission-1");
    const persisted = persistV4ComposerDraft(WORKSPACE, undefined, scope, {
      text: "frozen",
      recoveryContexts: {
        conversationQuotes: [markdownReference("q1", "quoted text")],
        codeComments: [codeCommentPayload("c1", "looks wrong") as never],
      },
    });
    expect(persisted).toBe(true);
    const restored = readV4ComposerDraft(WORKSPACE, undefined, scope);
    expect(restored?.recoveryContexts).toMatchObject({
      conversationQuotes: [markdownReference("q1", "quoted text")],
      codeComments: [codeCommentPayload("c1", "looks wrong")],
    });
  });

  it("keeps records written before the context snapshot readable", () => {
    const legacy = {
      version: 1,
      scopes: {
        [getV4WorktreeRecoveryScope("session-legacy", "submission-legacy")]: {
          text: "older frozen text",
          recoveryAttachments: [{ id: "f1", filename: "a.png" }],
          updatedAt: 1,
        },
      },
    };
    localStorage.setItem(
      "zcode-v4-composer-drafts:v1:%2Frecovery-contexts",
      JSON.stringify(legacy),
    );
    const restored = readV4ComposerDraft(
      WORKSPACE,
      undefined,
      getV4WorktreeRecoveryScope("session-legacy", "submission-legacy"),
    );
    expect(restored).toMatchObject({
      text: "older frozen text",
      recoveryAttachments: [{ id: "f1", filename: "a.png" }],
    });
    expect(restored?.recoveryContexts).toBeUndefined();
  });

  it("does not drop a contexts-only recovery record as empty", () => {
    const scope = getV4WorktreeRecoveryScope("session-2", "submission-2");
    persistV4ComposerDraft(WORKSPACE, undefined, scope, {
      text: "",
      recoveryContexts: { codeComments: [codeCommentPayload("c2", "ctx only") as never] },
    });
    expect(
      readV4ComposerDraft(WORKSPACE, undefined, scope)?.recoveryContexts?.codeComments,
    ).toHaveLength(1);
  });
});

describe("restoreComposerRecoveryContexts", () => {
  it("replays the frozen contexts through the ordinary add paths", () => {
    const captured: Record<string, unknown[]> = {
      code: [],
      web: [],
      pptx: [],
    };
    const codeListener = (event: Event) => captured.code.push((event as CustomEvent).detail);
    const webListener = (event: Event) => captured.web.push((event as CustomEvent).detail);
    const pptxListener = (event: Event) => captured.pptx.push((event as CustomEvent).detail);
    window.addEventListener(CODE_COMMENT_ADD_TO_CHAT_EVENT, codeListener);
    window.addEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, webListener);
    window.addEventListener(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, pptxListener);
    try {
      setConversationSelectionReferenceScope(null, WORKSPACE_KEY, [
        markdownReference("stale", "next draft quote"),
      ]);
      restoreComposerRecoveryContexts(
        {
          conversationQuotes: [markdownReference("q1", "quoted text")],
          codeComments: [codeCommentPayload("c1", "looks wrong") as never],
          webElements: [
            {
              id: "w1",
              workspacePath: WORKSPACE,
              text: "element text",
            } as never,
          ],
          pptxElements: [{ id: "p1", workspacePath: WORKSPACE } as never],
        },
        {
          sessionId: null,
          workspaceKey: WORKSPACE_KEY,
          workspacePath: WORKSPACE,
        },
      );
    } finally {
      window.removeEventListener(CODE_COMMENT_ADD_TO_CHAT_EVENT, codeListener);
      window.removeEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, webListener);
      window.removeEventListener(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, pptxListener);
    }
    expect(captured.code).toHaveLength(1);
    expect(captured.code[0]).toMatchObject({ id: "c1", comment: "looks wrong" });
    expect(captured.web).toHaveLength(1);
    expect(captured.web[0]).toMatchObject({ id: "w1" });
    expect(captured.pptx).toHaveLength(1);
    expect(captured.pptx[0]).toMatchObject({ id: "p1" });
    // Quotes land in the target scope through the normal selection add path.
    const quotes = getConversationSelectionReferenceScope(null, WORKSPACE_KEY);
    expect(quotes.map((quote) => quote.id)).toEqual(["stale", "q1"]);
  });

  it("is a no-op without a snapshot", () => {
    expect(() =>
      restoreComposerRecoveryContexts(undefined, {
        sessionId: null,
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE,
      }),
    ).not.toThrow();
  });
});
