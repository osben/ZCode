// Dedicated tool cards for escalate / ResolveWorkflowQuestion (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md).
//
// The file name is deliberately `.test.ts` rather than `.test.tsx`: the root vitest
// config only collects `packages/*/test/**/*.test.ts` (vitest.config.ts), so a
// `.test.tsx` case would never be picked up. Like submitResultToolCallBlock.test.ts,
// this uses createElement + renderToStaticMarkup instead of JSX.
//
// The main session and the subagent side pane share one ToolCallBlocks pipeline (the pane
// mounts a nested read-only SessionPane), so asserting "the full chain from the
// ToolCallBlock entry lands on the dedicated card" pins both surfaces at once.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

// CodeBlock depends on shiki / CodeViewer root providers that static rendering cannot run;
// replace it with a stub following the submit-result precedent (this card does not use
// CodeBlock, but the full-chain entry may reach it indirectly — a stub is the safest).
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block", "data-language": language }, code),
}));

// eslint-disable-next-line import/first -- the renderer under test must be imported after the code-block mock.
import { EscalateToolCallBlock } from "../src/ToolCallBlocks/renderers/escalate.js";
// eslint-disable-next-line import/first -- same as above.
import { ResolveWorkflowQuestionToolCallBlock } from "../src/ToolCallBlocks/renderers/resolve-workflow-question.js";
// eslint-disable-next-line import/first -- same; routing assertions need the workflow-family fallback renderer.
import { CreateWorkflowToolCallBlock } from "../src/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- same as above.
import { resolveToolCallRenderer } from "../src/ToolCallBlocks/resolveRenderer.js";
// eslint-disable-next-line import/first -- same; the full-chain routing assertion goes through the real entry component.
import { ToolCallBlock } from "@/ToolCallBlocks.js";

interface ToolCallOverrides {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
  status?: string;
  toolName?: string;
  snapshotRefs?: readonly { field: string; previewBytes: number; fullBytes: number }[];
}

interface ContextOverrides {
  isRunning?: boolean;
  errorText?: string;
  forceOpen?: boolean;
  onLoadFullToolCallFields?: (toolId: string) => void;
}

function buildContext(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  defaultName = "escalate",
) {
  const name = toolCall.toolName ?? defaultName;
  return {
    toolCallNode: {
      toolCall: {
        toolId: "tool-escalation",
        toolName: name,
        kind: name,
        title: name,
        input: toolCall.input,
        output: toolCall.output,
        status: toolCall.status ?? "completed",
        raw: toolCall.raw ?? {},
        snapshotRefs: toolCall.snapshotRefs,
      },
      childToolCalls: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test context fills only fields the renderer reads.
    } as any,
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: true,
      showKind: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above.
    } as any,
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: contextOverrides.isRunning ?? false,
    statusLabel: "Ran",
    errorText: contextOverrides.errorText,
    childToolList: null,
    showIcon: true,
    canToggle: true,
    forceOpen: contextOverrides.forceOpen ?? true,
    onLoadFullToolCallFields: contextOverrides.onLoadFullToolCallFields,
  };
}

function renderEscalate(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  lang: "en-US" | "zh-CN" = "en-US",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: lang },
      createElement(EscalateToolCallBlock, buildContext(toolCall, contextOverrides, "escalate")),
    ),
  );
}

function renderResolve(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  lang: "en-US" | "zh-CN" = "en-US",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: lang },
      createElement(
        ResolveWorkflowQuestionToolCallBlock,
        buildContext(toolCall, contextOverrides, "ResolveWorkflowQuestion"),
      ),
    ),
  );
}

describe("escalation question tool card routing", () => {
  it("routes escalate by name to the dedicated card without hijacking CreateWorkflow", () => {
    expect(resolveToolCallRenderer(buildContext({}, {}, "escalate") as never)).toBe(
      EscalateToolCallBlock,
    );
    expect(resolveToolCallRenderer(buildContext({ toolName: "CreateWorkflow" }) as never)).toBe(
      CreateWorkflowToolCallBlock,
    );
  });

  it("routes ResolveWorkflowQuestion by name, including the snake_case wire spelling", () => {
    for (const toolName of ["ResolveWorkflowQuestion", "resolve_workflow_question"]) {
      expect(resolveToolCallRenderer(buildContext({ toolName }) as never)).toBe(
        ResolveWorkflowQuestionToolCallBlock,
      );
    }
  });

  it("the full chain from the ToolCallBlock entry lands on the dedicated card, not the fallback raw JSON dump", () => {
    const escalateHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "escalate-e2e",
              toolName: "escalate",
              kind: "escalate",
              title: "escalate",
              input: { question: "门坏了吗？" },
              output: "跳过它。",
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );
    expect(escalateHtml).toContain(expectedCopy("chat.toolCall.workflow.escalate.asked"));
    expect(escalateHtml).not.toContain("&quot;toolId&quot;");

    const resolveHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "resolve-e2e",
              toolName: "ResolveWorkflowQuestion",
              kind: "ResolveWorkflowQuestion",
              title: "ResolveWorkflowQuestion",
              input: { question_id: "dwfq-run1-1", answer: "跳过它。" },
              output: "Answer delivered.",
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );
    expect(resolveHtml).toContain(expectedCopy("chat.toolCall.workflow.resolveQuestion.answered"));
    expect(resolveHtml).not.toContain("&quot;toolId&quot;");
  });
});

describe("EscalateToolCallBlock phase copy", () => {
  it.each([
    {
      name: "in_progress (en-US)",
      status: "in_progress",
      isRunning: true,
      lang: "en-US" as const,
      expected: expectedCopy("chat.toolCall.workflow.escalate.asking"),
    },
    {
      name: "pending (en-US)",
      status: "pending",
      isRunning: true,
      lang: "en-US" as const,
      expected: expectedCopy("chat.toolCall.workflow.escalate.asking"),
    },
    {
      name: "completed (en-US)",
      status: "completed",
      isRunning: false,
      lang: "en-US" as const,
      expected: expectedCopy("chat.toolCall.workflow.escalate.asked"),
    },
    {
      name: "in_progress (zh-CN)",
      status: "in_progress",
      isRunning: true,
      lang: "zh-CN" as const,
      expected: "正在询问主代理",
    },
    {
      name: "completed (zh-CN)",
      status: "completed",
      isRunning: false,
      lang: "zh-CN" as const,
      expected: "已询问主代理",
    },
  ])("$name phase renders the expected label", ({ status, isRunning, lang, expected }) => {
    const html = renderEscalate({ input: { question: "门坏了吗？" }, status }, { isRunning }, lang);
    expect(html).toContain(expected);
  });

  it("localizes phase copy in en-US as well", () => {
    const asking = renderEscalate(
      { input: { question: "Is the gate broken?" }, status: "in_progress" },
      { isRunning: true },
      "en-US",
    );
    expect(asking).toContain("Asking the main agent");

    const asked = renderEscalate(
      { input: { question: "Is the gate broken?" }, output: "Yes, skip it." },
      {},
      "en-US",
    );
    expect(asked).toContain("Asked the main agent");
    expect(asked).not.toContain("正在询问主代理");
  });
});

describe("EscalateToolCallBlock body branches", () => {
  it("question + context + answer sections all present", () => {
    const html = renderEscalate({
      input: { question: "门坏了吗？", context: "阈值 96，实际封顶 95。" },
      output: "对，跳过它，用旁路。",
    });
    expect(html).toContain("门坏了吗？");
    expect(html).toContain("阈值 96，实际封顶 95。");
    expect(html).toContain("对，跳过它，用旁路。");
    // All three headings are present.
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.escalate.question"));
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.escalate.context"));
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.escalate.answer"));
  });

  it("while parked (running) only the question shows, no answer section, and the card does not look failed", () => {
    const html = renderEscalate(
      { input: { question: "门坏了吗？" }, status: "in_progress" },
      { isRunning: true },
    );
    expect(html).toContain("门坏了吗？");
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.escalate.asking"));
    // The answer heading must not appear; being parked is not a failure.
    expect(html).not.toContain(expectedCopy("chat.toolCall.status.failed"));
    expect(html).not.toContain("text-destructive");
  });

  it("a budget-exhausted refusal is a plain result — rendered as the answer, never styled as a failure", () => {
    // The handler's formatModelContent only returns a message; the budget-exhausted text
    // arrives as a plain output (status stays completed), and the card must never style it
    // as an error because of its textual content.
    const refusal =
      "You have used all 3 escalations for this ask. Proceed on your own best judgement.";
    const html = renderEscalate({ input: { question: "还能再问吗？" }, output: refusal });
    expect(html).toContain(refusal);
    expect(html).not.toContain(expectedCopy("chat.toolCall.status.failed"));
    expect(html).not.toContain("border-destructive");
  });

  it("with an empty first-frame input there is no expand control and no empty panel", () => {
    const html = renderEscalate(
      { input: {}, status: "pending" },
      { isRunning: true, forceOpen: true },
    );
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.escalate.asking"));
    expect(html).not.toContain('role="button"');
  });
});

describe("ResolveWorkflowQuestionToolCallBlock phase copy", () => {
  it.each([
    {
      name: "in_progress (en-US)",
      status: "in_progress",
      isRunning: true,
      lang: "en-US" as const,
      expected: expectedCopy("chat.toolCall.workflow.resolveQuestion.answering"),
    },
    {
      name: "completed (en-US)",
      status: "completed",
      isRunning: false,
      lang: "en-US" as const,
      expected: expectedCopy("chat.toolCall.workflow.resolveQuestion.answered"),
    },
    {
      name: "in_progress (zh-CN)",
      status: "in_progress",
      isRunning: true,
      lang: "zh-CN" as const,
      expected: "正在回答问题",
    },
    {
      name: "completed (zh-CN)",
      status: "completed",
      isRunning: false,
      lang: "zh-CN" as const,
      expected: "已回答问题",
    },
  ])("$name phase renders the expected label", ({ status, isRunning, lang, expected }) => {
    const html = renderResolve(
      { input: { question_id: "dwfq-run1-1", answer: "跳过它。" }, status },
      { isRunning },
      lang,
    );
    expect(html).toContain(expected);
  });

  it("localizes phase copy in en-US as well", () => {
    const html = renderResolve(
      { input: { question_id: "dwfq-run1-1", answer: "Skip it." }, output: "Answer delivered." },
      {},
      "en-US",
    );
    expect(html).toContain("Answered question");
    expect(html).not.toContain("正在回答问题");
  });
});

describe("ResolveWorkflowQuestionToolCallBlock body branches", () => {
  it("qid mono row + full answer + success confirmation all present", () => {
    const html = renderResolve({
      input: { question_id: "dwfq-run1-1", answer: "跳过那道门，用旁路。" },
      output: "Answer delivered for question dwfq-run1-1. The run keeps going.",
    });
    expect(html).toContain("dwfq-run1-1");
    // qid is an identifier key → mono.
    expect(html).toMatch(/font-mono[^>]*>dwfq-run1-1/u);
    expect(html).toContain("跳过那道门，用旁路。");
    expect(html).toContain("The run keeps going.");
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.resolveQuestion.questionId"));
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.resolveQuestion.answer"));
    expect(html).toContain(expectedCopy("chat.toolCall.workflow.resolveQuestion.outcome"));
  });

  it("a structured refusal uses failure styling (status failed)", () => {
    const refusal = "workflow_question_already_resolved: this question was already answered.";
    const html = renderResolve(
      { input: { question_id: "dwfq-run1-1", answer: "跳过它。" }, status: "failed" },
      { errorText: refusal },
    );
    expect(html).toContain(expectedCopy("chat.toolCall.status.failed"));
    expect(html).toContain(refusal);
    expect(html).toContain("border-destructive");
  });

  it("success confirmation carries no failure styling", () => {
    const html = renderResolve({
      input: { question_id: "dwfq-run1-1", answer: "跳过它。" },
      output: "Answer delivered for question dwfq-run1-1.",
    });
    expect(html).not.toContain(expectedCopy("chat.toolCall.status.failed"));
    expect(html).not.toContain("border-destructive");
  });
});

describe("escalation question tool card snapshot field notice", () => {
  it("the escalate card still carries the snapshot field notice", () => {
    const html = renderEscalate(
      {
        input: { question: "门坏了吗？" },
        snapshotRefs: [{ field: "input", previewBytes: 100, fullBytes: 5_000 }],
      },
      { onLoadFullToolCallFields: () => {} },
    );
    expect(html).toContain(expectedCopy("chat.toolCall.snapshot.loadFull"));
  });
});
