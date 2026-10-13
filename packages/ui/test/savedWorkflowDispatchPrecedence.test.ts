// @vitest-environment jsdom
//
// A tripwire for dispatch precedence (team-lead ruling (b)).
//
// This file stubs `resolveToolCallIdentity` so that "SaveWorkflow / ListSavedWorkflows belong to
// the workflow family" — i.e. the world **after someone registers these two names in
// packages/shared's tool-identity.ts**. What is asserted is a property, not a snapshot:
// **the decision by tool name must win over the decision by family.**
//
// Why this is a tripwire and not an ordinary case: the workflow family's fallback branch points
// at CreateWorkflow in two places — the `identity.toolName === "submit_result"` ternary in
// `resolveRenderer.ts`, and `blockKind === "workflow"` in `PermissionDialog.tsx`. Once the names
// are registered without extending the family dispatch at the same time, SaveWorkflow renders
// **silently** as "Create Workflow": the save confirmation dialog grows a causality graph and
// Refine options (entirely the wrong language for a disk write), and the chat area draws a save
// as a run.
//
// If you are the person adding these two names to tool-identity.ts: this file should still be
// all green. If it turns red, the family dispatch has swallowed the dedicated surfaces — see the
// two by-name comments in resolveRenderer.ts and resolvePermissionBlockKind.

import { cleanup, render, screen } from "@testing-library/react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// Only the family decision is changed; the rest of the behavior keeps the real implementation.
vi.mock("@/lib/toolIdentity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/toolIdentity.js")>();
  return {
    ...actual,
    resolveToolCallIdentity: (toolCall: { toolName?: string | null; kind?: string | null }) => {
      const name = toolCall.toolName ?? toolCall.kind ?? "";
      if (name === "SaveWorkflow" || name === "ListSavedWorkflows") {
        // The hypothetical registration result: both names land in the workflow family.
        return { toolName: name, family: "workflow", source: "toolName", isLegacy: false };
      }
      return actual.resolveToolCallIdentity(toolCall);
    },
  };
});

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));

vi.mock("@/components/workflow-graph/workflow-causality-graph.js", () => ({
  WorkflowCausalityGraph: () => createElement("div", { "data-testid": "workflow-causality-graph" }),
}));

vi.mock("@/components/workflow-graph/workflow-graph-preview-dialog.js", () => ({
  WorkflowGraphPreviewDialog: () => null,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

/* eslint-disable import/first -- The modules under test must be imported after the mocks. */
import { PermissionDialog } from "@/PermissionDialog.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import { ListSavedWorkflowsToolCallBlock } from "@/ToolCallBlocks/renderers/list-saved-workflows.js";
import { SaveWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/save-workflow.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
/* eslint-enable import/first */

const SCRIPT = 'const r = await agent("a").ask<string>("检查");';

function buildContext(toolCall: Record<string, unknown>): ToolCallBlockRenderContext {
  return {
    toolCallNode: { toolCall, childToolCalls: [] },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    forceOpen: true,
    canToggle: false,
  } as ToolCallBlockRenderContext;
}

afterEach(cleanup);

describe("saved-workflow dispatch precedence over tool family", () => {
  it("confirms the premise: identity now reports the workflow family", () => {
    // Premise assertion — if the stub stops working, the cases below become falsely green; pin the hypothetical world down here first.
    expect(resolveToolCallIdentity({ toolName: "SaveWorkflow" }).family).toBe("workflow");
    expect(resolveToolCallIdentity({ toolName: "ListSavedWorkflows" }).family).toBe("workflow");
  });

  it("keeps SaveWorkflow on its own card, not the CreateWorkflow card", () => {
    const renderer = resolveToolCallRenderer(
      buildContext({
        toolId: "tool-save-1",
        toolName: "SaveWorkflow",
        kind: "SaveWorkflow",
        status: "completed",
        input: { name: "release-check", script: SCRIPT, overwrite: false },
      }),
    );

    expect(renderer).toBe(SaveWorkflowToolCallBlock);
    expect(renderer).not.toBe(CreateWorkflowToolCallBlock);
  });

  it("keeps ListSavedWorkflows on its own card, not the CreateWorkflow card", () => {
    const renderer = resolveToolCallRenderer(
      buildContext({
        toolId: "tool-list-1",
        toolName: "ListSavedWorkflows",
        kind: "ListSavedWorkflows",
        status: "completed",
        input: {},
        output: { workflows: [], invalid: [] },
      }),
    );

    expect(renderer).toBe(ListSavedWorkflowsToolCallBlock);
    expect(renderer).not.toBe(CreateWorkflowToolCallBlock);
  });

  it("still routes CreateWorkflow itself to the CreateWorkflow card", () => {
    const renderer = resolveToolCallRenderer(
      buildContext({
        toolId: "tool-create-1",
        toolName: "CreateWorkflow",
        kind: "CreateWorkflow",
        status: "completed",
        input: { script: SCRIPT },
      }),
    );

    expect(renderer).toBe(CreateWorkflowToolCallBlock);
  });

  it("keeps the SaveWorkflow gate on the save block, not the run-confirmation block", () => {
    const request = {
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "perm-save",
      description: "saveWorkflow.confirmation",
      kind: "SaveWorkflow",
      title: "SaveWorkflow",
      options: [
        {
          optionId: "allowOnce",
          kind: "allowOnce",
          name: "Allow",
          response: { decision: "allow" },
        },
        { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
      ],
      raw: {
        name: "release-check",
        description: "发布前检查",
        script: SCRIPT,
        path: "/workspace/.zcode/workflows/release-check.dwf.ts",
        overwrite: false,
        scope: "project",
      },
    } as ZCodePermissionRequest;

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PermissionDialog, {
          request,
          onRespond: () => {},
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(document.querySelector('[data-save-workflow-permission-block="true"]')).toBeTruthy();
    // The run-confirmation dialog's language must never appear on a disk write: no graph, and no "Run this workflow?".
    expect(document.querySelector('[data-workflow-permission-block="true"]')).toBeNull();
    expect(screen.queryByTestId("workflow-causality-graph")).toBeNull();
    expect(document.body.textContent).not.toContain("Run this workflow?");
    expect(screen.getByText("Save this workflow to the project?")).toBeTruthy();
  });
});
