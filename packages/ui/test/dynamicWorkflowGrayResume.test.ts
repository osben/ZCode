// @vitest-environment jsdom
// When the gray release misses, no path may start an engine (docs/dynamic-workflow/launch.md "Gray release" DWG-07).
//
// There is a single supply point: SessionPane puts the Resume callback into the conversation
// context. Both the tool-card footer and the turn-end digest card gate their button on
// "is the callback present", so this file computes the callback through the real gate
// (resolveWorkflowResumeHandler) and then actually renders both surfaces to see whether the
// button exists — instead of restating the rule in each place.
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
// ControlHintTooltip needs the TooltipProvider from the app root; stub it as a pass-through per existing convention.
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- the component under test must be imported after the mocks above.
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- same as above.
import {
  WorkflowRunDigest,
  type WorkflowRunDigestProps,
} from "@/components/workflow-timeline/WorkflowRunDigest.js";

/** The conversation-context callback: computed by the real gate; `undefined` means "this path is gone". */
function resumeHandlerFor(dynamicWorkflowEnabled: boolean) {
  return resolveWorkflowResumeHandler({
    readOnly: false,
    dynamicWorkflowEnabled,
    handler: vi.fn(),
  });
}

const GRAPH = {
  steps: [
    {
      id: "ask#1",
      kind: "ask",
      label: "plan",
      line: 2,
      column: 21,
      lane: "actor#1",
    },
  ],
  lanes: [{ id: "actor#1", name: "planner", line: 1, column: 11 }],
  participants: [
    {
      id: "unphased:actor#1",
      phase: "unphased",
      lane: "actor#1",
      steps: ["ask#1"],
    },
  ],
  handoffs: [],
} as const;

/** Stopped and resumable: the one run state where all three Resume surfaces appear. */
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
      { initialLocale: "en-US" },
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test fills only the fields the renderer reads.
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
        isRunning: false,
        statusLabel: "Stopped",
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
      { initialLocale: "en-US" },
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
  it("gray release hit and writable → the callback is supplied as usual", () => {
    const handler = vi.fn();
    expect(
      resolveWorkflowResumeHandler({
        readOnly: false,
        dynamicWorkflowEnabled: true,
        handler,
      }),
    ).toBe(handler);
    // A missing readOnly (undefined) counts as writable.
    expect(
      resolveWorkflowResumeHandler({
        readOnly: undefined,
        dynamicWorkflowEnabled: true,
        handler,
      }),
    ).toBe(handler);
  });

  it("gray release miss → not supplied; read-only sessions still not supplied; neither when both hold", () => {
    const handler = vi.fn();
    expect(
      resolveWorkflowResumeHandler({
        readOnly: false,
        dynamicWorkflowEnabled: false,
        handler,
      }),
    ).toBeUndefined();
    expect(
      resolveWorkflowResumeHandler({
        readOnly: true,
        dynamicWorkflowEnabled: true,
        handler,
      }),
    ).toBeUndefined();
    expect(
      resolveWorkflowResumeHandler({
        readOnly: true,
        dynamicWorkflowEnabled: false,
        handler,
      }),
    ).toBeUndefined();
  });
});

describe("tool-card footer and digest card Resume after the gray release is off", () => {
  it("tool-card footer: gray off → no Resume; gray on → present", () => {
    expect(renderCard(resumeHandlerFor(false))).not.toContain("workflow-card-resume");
    expect(renderCard(resumeHandlerFor(true))).toContain("workflow-card-resume");
  });

  it("turn-end digest card: gray off → no Resume; gray on → present", () => {
    expect(
      renderDigest(resumeHandlerFor(false)).queryByTestId("workflow-digest-resume"),
    ).toBeNull();
    cleanup();
    expect(
      renderDigest(resumeHandlerFor(true)).queryByTestId("workflow-digest-resume"),
    ).not.toBeNull();
  });

  it("turning gray off only removes Resume: the card and digest still render", () => {
    // "Existing runs still render" — the kind word and status remain, just not clickable.
    expect(renderCard(resumeHandlerFor(false))).toContain("workflow-card-kind");
    expect(
      renderDigest(resumeHandlerFor(false)).queryByTestId("workflow-card-kind"),
    ).not.toBeNull();
  });
});
