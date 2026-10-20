// submit_result tool card (docs/chat/submit-result-tool-card.md).
//
// The file name is deliberately `.test.ts` and not `.test.tsx`: the root vitest
// config only collects `packages/*/test/**/*.test.ts` (vitest.config.ts:68), so a
// `.test.tsx` file would not be collected at all (the repo already has a few such
// dead files). Like the other renderer tests, this file uses createElement, not JSX.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getZCodeToolFamilyForName, normalizeZCodeToolName } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

// CodeBlock depends on shiki / CodeViewer / Tooltip root providers, which static
// rendering cannot run; following the createWorkflowToolCallBlock.test.ts
// precedent, replace it with an assertable stub that also exposes language, so
// "the JSON branch really is a language=json code block" can be pinned down.
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block", "data-language": language }, code),
}));

// eslint-disable-next-line import/first -- the renderer under test must be imported after the code-block mock.
import { SubmitResultToolCallBlock } from "../src/ToolCallBlocks/renderers/submit-result.js";
// eslint-disable-next-line import/first -- same; routing assertions need the workflow family's other renderer.
import { CreateWorkflowToolCallBlock } from "../src/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- same.
import { resolveToolCallRenderer } from "../src/ToolCallBlocks/resolveRenderer.js";
// eslint-disable-next-line import/first -- same; the whole-chain routing assertion must go through the real entry component.
import { ToolCallBlock } from "@/ToolCallBlocks.js";

interface ToolCallOverrides {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
  status?: string;
  toolName?: string;
  snapshotRefs?: readonly {
    field: string;
    previewBytes: number;
    fullBytes: number;
  }[];
}

interface ContextOverrides {
  isRunning?: boolean;
  errorText?: string;
  forceOpen?: boolean;
  onLoadFullToolCallFields?: (toolId: string) => void;
}

function buildContext(toolCall: ToolCallOverrides, contextOverrides: ContextOverrides = {}) {
  return {
    toolCallNode: {
      toolCall: {
        toolId: "tool-submit-result",
        toolName: toolCall.toolName ?? "submit_result",
        kind: toolCall.toolName ?? "submit_result",
        title: toolCall.toolName ?? "submit_result",
        input: toolCall.input,
        output: toolCall.output,
        status: toolCall.status ?? "completed",
        raw: toolCall.raw ?? {},
        snapshotRefs: toolCall.snapshotRefs,
      },
      childToolCalls: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test context only fills fields the renderer reads.
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same.
    } as any,
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: contextOverrides.isRunning ?? false,
    statusLabel: "Completed",
    errorText: contextOverrides.errorText,
    childToolList: null,
    showIcon: true,
    canToggle: true,
    forceOpen: contextOverrides.forceOpen ?? true,
    onLoadFullToolCallFields: contextOverrides.onLoadFullToolCallFields,
  };
}

function renderBlock(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  locale: "en-US" | "zh-CN" = "en-US",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(SubmitResultToolCallBlock, buildContext(toolCall, contextOverrides)),
    ),
  );
}

const REJECTION_TEXT = [
  "The submitted result does not match the required schema:",
  "verdict: expected one of proved | disproved, got string",
  "steps[0].tactic: expected string, got number",
].join("\n");

describe("submit_result routing", () => {
  it("submit_result is a known tool name and belongs to the workflow family", () => {
    // The wire name is the snake_case `submit_result` — the underscores must be present verbatim.
    expect(normalizeZCodeToolName("submit_result")).toBe("submit_result");
    expect(getZCodeToolFamilyForName("submit_result")).toBe("workflow");
    expect(resolveToolCallIdentity({ toolName: "submit_result" })).toMatchObject({
      toolName: "submit_result",
      family: "workflow",
      isLegacy: false,
    });
  });

  it("dispatches by tool name inside the workflow family without hitting CreateWorkflow", () => {
    expect(resolveToolCallRenderer(buildContext({}) as never)).toBe(SubmitResultToolCallBlock);
    expect(resolveToolCallRenderer(buildContext({ toolName: "CreateWorkflow" }) as never)).toBe(
      CreateWorkflowToolCallBlock,
    );
  });

  it("the whole chain from the ToolCallBlock entry lands on the new card, not the fallback bare JSON dump", () => {
    // The main session and the actor side panel share this chain (the panel mounts a
    // nested read-only SessionPane), so this single case pins both surfaces.
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "submit-e2e",
              toolName: "submit_result",
              kind: "submit_result",
              title: "submit_result",
              input: { result: { verdict: "proved" } },
              output: { status: "accepted" },
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain(expectedCopy("chat.toolCall.submitResult.submitted"));
    // The fallback capitalized label and the whole-object dump must both be gone.
    expect(html).not.toContain("Submit_result");
    expect(html).not.toContain("&quot;toolId&quot;");
  });
});

describe("SubmitResultToolCallBlock phase copy", () => {
  it.each([
    {
      name: "completed",
      status: "completed",
      isRunning: false,
      expected: expectedCopy("chat.toolCall.submitResult.submitted"),
    },
    {
      name: "pending",
      status: "pending",
      isRunning: true,
      expected: expectedCopy("chat.toolCall.submitResult.submitting"),
    },
    {
      name: "in_progress",
      status: "in_progress",
      isRunning: true,
      expected: expectedCopy("chat.toolCall.submitResult.submitting"),
    },
    {
      name: "failed",
      status: "failed",
      isRunning: false,
      expected: expectedCopy("chat.toolCall.submitResult.rejected"),
    },
    {
      name: "stopped",
      status: "stopped",
      isRunning: false,
      expected: expectedCopy("chat.toolCall.submitResult.stopped"),
    },
  ])('$name phase shows "$expected"', ({ status, isRunning, expected }) => {
    const html = renderBlock({ input: { result: { verdict: "proved" } }, status }, { isRunning });

    expect(html).toContain(expected);
  });

  it("zh-CN still renders the localized phase copy", () => {
    const html = renderBlock({ input: { result: { verdict: "proved" } } }, {}, "zh-CN");

    expect(html).toContain("已提交结果");
    expect(html).not.toContain(expectedCopy("chat.toolCall.submitResult.submitted"));
  });
});

describe("SubmitResultToolCallBlock body smart routing", () => {
  it("an object result goes through a JSON code block with indented JSON", () => {
    const html = renderBlock({
      input: { result: { verdict: "proved", steps: [{ tactic: "simp" }] } },
      output: { status: "accepted" },
    });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain('data-language="json"');
    expect(html).toContain("&quot;verdict&quot;: &quot;proved&quot;");
  });

  it("an array result also takes the JSON branch", () => {
    const html = renderBlock({ input: { result: ["alpha", "beta"] } });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain("&quot;alpha&quot;");
  });

  it("a plain string result shows prose and stays out of the code block", () => {
    const prose =
      "Root cause is in the scheduler may-set expansion: the lane copy has no actor routing.";
    const html = renderBlock({ input: { result: prose } });

    expect(html).toContain(prose);
    expect(html).not.toContain('data-testid="code-block"');
  });

  it("a JSON string result is unwrapped into an object and takes the code-block branch", () => {
    // Field fact from the engine: real models often serialize result as a JSON string.
    const html = renderBlock({
      input: { result: '{"verdict":"disproved","steps":[]}' },
    });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain("&quot;verdict&quot;: &quot;disproved&quot;");
  });

  it("a string that looks like JSON but cannot be parsed stays prose and does not crash the card", () => {
    const broken = '{"verdict":"proved"';
    const html = renderBlock({ input: { result: broken } });

    expect(html).not.toContain('data-testid="code-block"');
    expect(html).toContain("{&quot;verdict&quot;:&quot;proved&quot;");
  });

  it("numeric / boolean results also have a home (any non-string takes the JSON branch)", () => {
    expect(renderBlock({ input: { result: 42 } })).toContain('data-testid="code-block"');
    expect(renderBlock({ input: { result: false } })).toContain('data-testid="code-block"');
  });

  it("a JSON string input still exposes result", () => {
    const html = renderBlock({
      input: JSON.stringify({ result: { verdict: "proved" } }),
    });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain("&quot;verdict&quot;");
  });

  it("the collapsed header gives a one-line result summary", () => {
    const html = renderBlock(
      { input: { result: { verdict: "proved", steps: [{ tactic: "simp" }] } } },
      { forceOpen: false },
    );

    // The summary is the single-line compact form; when collapsed the body is not
    // rendered, so the indented JSON must not appear.
    expect(html).toContain("{&quot;verdict&quot;:&quot;proved&quot;");
    expect(html).not.toContain("&quot;verdict&quot;: &quot;proved&quot;");
    expect(html).not.toContain('data-testid="code-block"');
  });
});

describe("SubmitResultToolCallBlock streaming gate", () => {
  it("the first frame without a result key offers no expand entry and renders no empty panel", () => {
    const html = renderBlock(
      { input: {}, status: "pending", raw: { kind: "tool_input_start" } },
      { isRunning: true, forceOpen: true },
    );

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
    expect(html).toContain(expectedCopy("chat.toolCall.submitResult.submitting"));
  });

  it("a completely absent input likewise offers no expand entry", () => {
    const html = renderBlock({ status: "pending" }, { isRunning: true });

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
  });
});

describe("SubmitResultToolCallBlock rejection state", () => {
  it("the rejection state is a flat row: no expand entry, no body, no per-field violation recap", () => {
    const html = renderBlock(
      {
        input: { result: { verdict: "yes" } },
        status: "failed",
        output: REJECTION_TEXT,
      },
      { errorText: REJECTION_TEXT },
    );

    expect(html).toContain(expectedCopy("chat.toolCall.submitResult.rejected"));
    // The collapsed header's one-line result summary stays — the flat row is itself a summary row.
    expect(html).toContain("{&quot;verdict&quot;:&quot;yes&quot;}");
    // Not expandable: no toggle button, no expanded result code block.
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
    // The per-field violation panel is removed entirely: neither the violation text
    // nor its subtitle may appear in the card (they live in the failure tooltip).
    expect(html).not.toContain("expected one of proved | disproved, got string");
    expect(html).not.toContain("Fields that do not meet requirements");
  });

  it("the rejection state stays a flat row even without any error text", () => {
    const html = renderBlock({
      input: { result: { verdict: "yes" } },
      status: "failed",
    });

    expect(html).toContain(expectedCopy("chat.toolCall.submitResult.rejected"));
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
  });
});

describe("SubmitResultToolCallBlock snapshot field notice", () => {
  it("keeps the snapshot field notice attached after the card", () => {
    const html = renderBlock(
      {
        input: { result: { verdict: "proved" } },
        snapshotRefs: [{ field: "input", previewBytes: 100, fullBytes: 5_000 }],
      },
      { onLoadFullToolCallFields: () => {} },
    );

    expect(html).toContain(expectedCopy("chat.toolCall.snapshot.loadFull"));
  });
});
