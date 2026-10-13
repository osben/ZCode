// @vitest-environment jsdom
// When the gray release does not match, no path to start the engine remains (docs/dynamic-workflow/launch.md "Gray
// release", DWG-07).
//
// There is a single supply point: SessionPane puts the Resume callback into the session context. The tool card footer
// and the end-of-turn digest card both gate their buttons on "is the callback present", so here the callback is
// computed through the real gate (resolveWorkflowResumeHandler) and both surfaces are actually rendered to see whether
// the button is there — instead of restating the rule in each place.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlockHeader: () => null,
  CodeBlock: ({ code }: { code: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));
// ControlHintTooltip depends on the app root's TooltipProvider; following existing convention, the test replaces it
// with a pass-through stub.
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- The component under test must be imported after the mocks above.
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- Same as above.
import {
  WorkflowRunDigest,
  type WorkflowRunDigestProps,
} from "@/components/workflow-timeline/WorkflowRunDigest.js";

const sessionPaneSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/v4/SessionPane.tsx"),
  "utf8",
).replaceAll("\r\n", "\n");

/** The callback in the session context: computed through the real gate; `undefined` means "this path is gone". */
function resumeHandlerFor(dynamicWorkflowEnabled: boolean) {
  return resolveWorkflowResumeHandler({
    readOnly: false,
    dynamicWorkflowEnabled,
    handler: vi.fn(),
  });
}

const GRAPH = {
  steps: [{ id: "ask#1", kind: "ask", label: "plan", line: 2, column: 21, lane: "actor#1" }],
  lanes: [{ id: "actor#1", name: "planner", line: 1, column: 11 }],
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
} as const;

/** Stopped and resumable: the kind of run where all three Resume affordances appear. */
function stoppedResumableRun(): WorkflowRunState {
  return {
    runId: "dwfrun-42",
    toolCallId: "tool-create-workflow",
    status: "stopped",
    stopReason: "interrupted",
    usage: { spentTokens: 1_234, nodesUsed: 1 },
    actors: [],
    nodes: [],
    lastEventSequence: 7,
  } as unknown as WorkflowRunState;
}

function resumableSummary(): WorkflowRunCardSummary {
  const run = stoppedResumableRun();
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    status: run.status,
    nodesSettled: 0,
    nodesTotal: 1,
    resumable: true,
    run,
  } as WorkflowRunCardSummary;
}

function renderCard(
  onResumeWorkflowRun: ((request: { workflowName?: string }) => void) | undefined,
) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(CreateWorkflowToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-create-workflow",
            kind: "CreateWorkflow",
            title: "CreateWorkflow",
            output: "",
            status: "completed",
          },
          childToolCalls: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The test context only fills the fields the renderer reads.
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Same as above.
        } as any,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: "已停止",
        childToolList: null,
        forceOpen: true,
        canToggle: true,
        showIcon: true,
        onResumeWorkflowRun,
        workflowRun: resumableSummary(),
      }),
    ),
  );
}

function renderDigest(onResume: (() => void) | undefined) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkflowRunDigest, {
        graph: GRAPH as unknown as WorkflowRunDigestProps["graph"],
        name: "implement-verify",
        runId: "dwfrun-42",
        testIdKey: "t",
        summary: resumableSummary(),
        ...(onResume === undefined ? {} : { onResume }),
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("resolveWorkflowResumeHandler", () => {
  it("灰度命中且可写 → 回调照常供给", () => {
    const handler = vi.fn();
    expect(
      resolveWorkflowResumeHandler({ readOnly: false, dynamicWorkflowEnabled: true, handler }),
    ).toBe(handler);
    // An absent readOnly (undefined) is equivalent to writable.
    expect(
      resolveWorkflowResumeHandler({ readOnly: undefined, dynamicWorkflowEnabled: true, handler }),
    ).toBe(handler);
  });

  it("灰度未命中 → 不供给；只读会话照旧不供给；两者都成立时也不供给", () => {
    const handler = vi.fn();
    expect(
      resolveWorkflowResumeHandler({ readOnly: false, dynamicWorkflowEnabled: false, handler }),
    ).toBeUndefined();
    expect(
      resolveWorkflowResumeHandler({ readOnly: true, dynamicWorkflowEnabled: true, handler }),
    ).toBeUndefined();
    expect(
      resolveWorkflowResumeHandler({ readOnly: true, dynamicWorkflowEnabled: false, handler }),
    ).toBeUndefined();
  });
});

describe("灰度关掉后工具卡页脚与摘要卡的 Resume", () => {
  it("工具卡页脚：灰度关 → 没有 Resume；灰度开 → 有", () => {
    expect(renderCard(resumeHandlerFor(false))).not.toContain("workflow-card-resume");
    expect(renderCard(resumeHandlerFor(true))).toContain("workflow-card-resume");
  });

  it("轮尾摘要卡：灰度关 → 没有 Resume；灰度开 → 有", () => {
    expect(
      renderDigest(resumeHandlerFor(false)).queryByTestId("workflow-digest-resume"),
    ).toBeNull();
    cleanup();
    expect(
      renderDigest(resumeHandlerFor(true)).queryByTestId("workflow-digest-resume"),
    ).not.toBeNull();
  });

  it("灰度关只收走 Resume：卡与摘要本身照常渲染", () => {
    // "Existing runs still render" — the kind word, the status, and so on are all still there, just untouched.
    expect(renderCard(resumeHandlerFor(false))).toContain("workflow-card-kind");
    expect(
      renderDigest(resumeHandlerFor(false)).queryByTestId("workflow-card-kind"),
    ).not.toBeNull();
  });
});

describe("SessionPane 供给点接线", () => {
  it("Resume 回调只经 resolveWorkflowResumeHandler 进上下文，灰度从 hook 读", () => {
    expect(sessionPaneSource).toContain("useDynamicWorkflowAvailability");
    expect(sessionPaneSource).toMatch(
      /onResumeWorkflowRun: resolveWorkflowResumeHandler\(\{\s*readOnly,\s*dynamicWorkflowEnabled,\s*handler: handleResumeWorkflowRun,\s*\}\)/,
    );
    // The old bare ternary must no longer exist, otherwise the gray release gets bypassed.
    expect(sessionPaneSource).not.toContain(
      "onResumeWorkflowRun: readOnly ? undefined : handleResumeWorkflowRun",
    );
  });
});
