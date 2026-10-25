// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import {
  formatWorkflowArgValue,
  readWorkflowName,
  readWorkflowSaved,
  readWorkflowScript,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  ListSavedWorkflowsToolCallBlock,
  readListSavedWorkflowsResult,
} from "@/ToolCallBlocks/renderers/list-saved-workflows.js";
import { SaveWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/save-workflow.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const SCRIPT = 'const r = await agent("a").ask<string>("check");';
const SAVED_PATH = "/workspace/.zcode/workflows/release-check.dwf.ts";
const WORKFLOW_DESCRIPTION = "Pre-release check: lint, tests, changelog";
const WORKFLOW_WHEN_TO_USE = "When the user asks for a release";

const LIST_RESULT = {
  workflows: [
    {
      name: "release-check",
      description: WORKFLOW_DESCRIPTION,
      whenToUse: WORKFLOW_WHEN_TO_USE,
      args: { target: { type: "string", required: true }, skipTests: { type: "boolean" } },
      scope: "project",
      path: SAVED_PATH,
    },
    {
      name: "translate-docs",
      description: "Batch-translate documentation directories",
      scope: "project",
      path: "/workspace/.zcode/workflows/translate-docs.dwf.ts",
    },
  ],
  invalid: [{ path: "/workspace/.zcode/workflows/broken.dwf.ts", reason: "yaml_invalid" }],
};

function buildContext(
  toolCall: Record<string, unknown>,
  overrides: Partial<ToolCallBlockRenderContext> = {},
): ToolCallBlockRenderContext {
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
    // The card body is collapsed by default; tests force it open to assert content.
    forceOpen: true,
    canToggle: false,
    ...overrides,
  } as ToolCallBlockRenderContext;
}

function renderCard(
  component: (context: ToolCallBlockRenderContext) => unknown,
  context: ToolCallBlockRenderContext,
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(component as never, context),
    ),
  );
}

function buildSaveToolCall(input: Record<string, unknown> = {}) {
  return {
    toolId: "tool-save-1",
    toolName: "SaveWorkflow",
    kind: "SaveWorkflow",
    title: "SaveWorkflow",
    status: "completed",
    input: {
      name: "release-check",
      description: WORKFLOW_DESCRIPTION,
      whenToUse: WORKFLOW_WHEN_TO_USE,
      script: SCRIPT,
      path: SAVED_PATH,
      overwrite: false,
      scope: "project",
      ...input,
    },
  };
}

function buildListToolCall(output: unknown = LIST_RESULT) {
  return {
    toolId: "tool-list-1",
    toolName: "ListSavedWorkflows",
    kind: "ListSavedWorkflows",
    title: "ListSavedWorkflows",
    status: "completed",
    input: {},
    output,
  };
}

afterEach(cleanup);

// ── spec test map "normalization (b)" ──
// Normalized input must hit the existing reader rules verbatim. This is the render-side half of
// the safety property "the legacy desktop renderer works by construction" (the CLI-side half is
// pinned in bootstrap session-mapper tests): the saved-run confirmation window shows the full
// script even on legacy clients without a source badge precisely because these two readers
// find their values.
describe("normalized saved-run input feeds the existing reader helpers", () => {
  const NORMALIZED_SAVED_RAW = {
    name: "Release check",
    script: SCRIPT,
    saved: {
      name: "release-check",
      path: SAVED_PATH,
      scope: "project",
      args: { target: "packages/ui" },
    },
  };

  it("readWorkflowScript returns the resolved script body", () => {
    expect(readWorkflowScript(NORMALIZED_SAVED_RAW)).toBe(SCRIPT);
  });

  it("readWorkflowName returns the display label", () => {
    expect(readWorkflowName(NORMALIZED_SAVED_RAW)).toBe("Release check");
  });

  it("readWorkflowSaved reads provenance and the validated argument bag", () => {
    const saved = readWorkflowSaved(NORMALIZED_SAVED_RAW);
    expect(saved).toEqual({
      name: "release-check",
      path: SAVED_PATH,
      scope: "project",
      args: { target: "packages/ui" },
    });
  });

  it("treats an inline run as having no saved source", () => {
    expect(readWorkflowSaved({ name: "Inline", script: SCRIPT })).toBeUndefined();
    // Invariant 7: args is always defined — saved present without concrete args is an empty
    // object, not undefined.
    expect(readWorkflowSaved({ script: SCRIPT, saved: { name: "x" } })?.args).toEqual({});
  });

  it("formats argument values by declared type", () => {
    // Strings verbatim (quotes would only add noise); everything else goes through JSON.
    expect(formatWorkflowArgValue("packages/ui")).toBe("packages/ui");
    expect(formatWorkflowArgValue(false)).toBe("false");
    expect(formatWorkflowArgValue(3)).toBe("3");
    expect(formatWorkflowArgValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("resolveToolCallRenderer saved-workflow dispatch", () => {
  it("routes both tools by name even though shared does not know them", () => {
    // Precondition: neither name is in shared's known tool table, so identity would fall back to
    // unknown. Dispatch must hit by name, otherwise the whole toolCall JSON gets dumped into the
    // chat area.
    expect(resolveToolCallRenderer(buildContext(buildSaveToolCall()))).toBe(
      SaveWorkflowToolCallBlock,
    );
    expect(resolveToolCallRenderer(buildContext(buildListToolCall()))).toBe(
      ListSavedWorkflowsToolCallBlock,
    );
  });

  it("matches the snake_case wire spelling too", () => {
    const snakeCase = { ...buildSaveToolCall(), toolName: "save_workflow", kind: "save_workflow" };
    expect(resolveToolCallRenderer(buildContext(snakeCase))).toBe(SaveWorkflowToolCallBlock);
  });
});

describe("SaveWorkflowToolCallBlock", () => {
  // 2026-08-29 addition (spec: docs/dynamic-workflow/launch.md "`SaveWorkflow`"):
  // the collapsed row converges to "name + overwrite badge"; description/path/whenToUse appear
  // only in the expanded card body.
  it("collapsed row shows only the name; details live in the expanded body", () => {
    renderCard(
      SaveWorkflowToolCallBlock,
      buildContext(buildSaveToolCall(), { forceOpen: false, canToggle: true }),
    );

    expect(screen.getByText("Saved workflow")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    // The collapsed row must not show description or path — they are details, not status.
    expect(screen.queryByText(WORKFLOW_DESCRIPTION)).toBeNull();
    expect(screen.queryByText(SAVED_PATH)).toBeNull();
    cleanup();

    renderCard(SaveWorkflowToolCallBlock, buildContext(buildSaveToolCall()));
    expect(screen.getByText(WORKFLOW_DESCRIPTION)).toBeTruthy();
    expect(screen.getByText(SAVED_PATH)).toBeTruthy();
    expect(screen.getByText(WORKFLOW_WHEN_TO_USE)).toBeTruthy();
    // The script belongs to the confirmation window; the card does not repeat it.
    expect(document.body.textContent).not.toContain('await agent("a")');
  });

  it("flags an overwrite and stays silent on a fresh save", () => {
    renderCard(SaveWorkflowToolCallBlock, buildContext(buildSaveToolCall({ overwrite: true })));
    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')?.textContent).toBe(
      "overwrite",
    );
    cleanup();

    renderCard(SaveWorkflowToolCallBlock, buildContext(buildSaveToolCall()));
    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')).toBeNull();
  });

  it("uses the running phrase while the save is in flight", () => {
    renderCard(SaveWorkflowToolCallBlock, buildContext(buildSaveToolCall(), { isRunning: true }));
    expect(screen.getByText("Saving workflow")).toBeTruthy();
  });

  it("renders the overwrite card in zh-CN", () => {
    renderCard(
      SaveWorkflowToolCallBlock,
      buildContext(buildSaveToolCall({ overwrite: true })),
      "zh-CN",
    );
    expect(screen.getByText(zhCN["chat.toolCall.workflow.save.saved"])).toBeTruthy();
    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')?.textContent).toBe(
      zhCN["chat.toolCall.workflow.save.overwrite"],
    );
  });

  // ── docs/dynamic-workflow/launch.md "`SaveWorkflow`" ──
  it("shows a scope row above the path (project vs global) and stays silent on unknown scope", () => {
    renderCard(SaveWorkflowToolCallBlock, buildContext(buildSaveToolCall()));
    expect(screen.getByText("Scope")).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    // Project-scoped collapsed rows get no global badge.
    expect(document.querySelector('[data-workflow-scope-badge="global"]')).toBeNull();
    cleanup();

    renderCard(SaveWorkflowToolCallBlock, buildContext(buildSaveToolCall({ scope: "global" })));
    expect(screen.getByText("Global · visible from every project")).toBeTruthy();
    // Global collapsed rows get a "Global" badge (in the same row as the overwrite badge).
    expect(document.querySelector('[data-workflow-scope-badge="global"]')?.textContent).toBe(
      "Global",
    );
    cleanup();

    // scope absent (legacy agent) → no scope row rendered.
    const { scope: _dropped, ...withoutScope } = buildSaveToolCall().input as Record<
      string,
      unknown
    >;
    renderCard(
      SaveWorkflowToolCallBlock,
      buildContext({ ...buildSaveToolCall(), input: withoutScope }),
    );
    expect(screen.queryByText("Scope")).toBeNull();
    expect(document.querySelector('[data-workflow-scope-badge="global"]')).toBeNull();
  });

  it("explains shadowing in either direction", () => {
    renderCard(
      SaveWorkflowToolCallBlock,
      buildContext(buildSaveToolCall({ scope: "global", shadowing: "hides_global" })),
    );
    expect(
      screen.getByText("A global workflow with this name will be hidden by this one"),
    ).toBeTruthy();
    cleanup();

    renderCard(
      SaveWorkflowToolCallBlock,
      buildContext(buildSaveToolCall({ scope: "project", shadowing: "hidden_by_project" })),
    );
    expect(
      screen.getByText(
        "This project already has a workflow with this name, which will hide this one here",
      ),
    ).toBeTruthy();
  });

  it("renders the scope row in zh-CN too", () => {
    renderCard(
      SaveWorkflowToolCallBlock,
      buildContext(buildSaveToolCall({ scope: "global" })),
      "zh-CN",
    );
    expect(screen.getByText(zhCN["chat.toolCall.workflow.save.scope.label"])).toBeTruthy();
    expect(screen.getByText(zhCN["chat.toolCall.workflow.save.scope.global"])).toBeTruthy();
    expect(document.querySelector('[data-workflow-scope-badge="global"]')?.textContent).toBe(
      zhCN["chat.toolCall.workflow.scope.global"],
    );
  });
});

describe("CreateWorkflowToolCallBlock saved source line", () => {
  function buildCreateToolCall(input: Record<string, unknown>) {
    return {
      toolId: "tool-create-1",
      toolName: "CreateWorkflow",
      kind: "CreateWorkflow",
      title: "CreateWorkflow",
      status: "completed",
      input,
    };
  }

  it("names the saved source above the script", () => {
    renderCard(
      CreateWorkflowToolCallBlock,
      buildContext(
        buildCreateToolCall({
          name: "Release check",
          script: SCRIPT,
          saved: {
            name: "release-check",
            path: SAVED_PATH,
            scope: "project",
            args: { target: "packages/ui" },
          },
        }),
      ),
    );

    const line = document.querySelector('[data-workflow-card-saved-source="true"]');
    expect(line).toBeTruthy();
    expect(line?.textContent).toContain("Saved workflow · project");
    expect(line?.textContent).toContain("release-check");
  });

  it("is absent for an inline run", () => {
    renderCard(
      CreateWorkflowToolCallBlock,
      buildContext(buildCreateToolCall({ name: "Inline", script: SCRIPT })),
    );

    expect(document.querySelector('[data-workflow-card-saved-source="true"]')).toBeNull();
  });

  it("renders the source line in zh-CN too", () => {
    renderCard(
      CreateWorkflowToolCallBlock,
      buildContext(
        buildCreateToolCall({
          name: "Release check",
          script: SCRIPT,
          saved: { name: "release-check", path: SAVED_PATH, scope: "project", args: {} },
        }),
      ),
      "zh-CN",
    );

    expect(
      document.querySelector('[data-workflow-card-saved-source="true"]')?.textContent,
    ).toContain(
      `${zhCN["chat.permission.workflow.saved.badge"]} · ${zhCN["chat.permission.workflow.saved.scope.project"]}`,
    );
  });
});

describe("ListSavedWorkflowsToolCallBlock", () => {
  it("reads the result from an object or a JSON string", () => {
    expect(readListSavedWorkflowsResult(buildListToolCall())?.workflows).toHaveLength(2);
    expect(
      readListSavedWorkflowsResult(buildListToolCall(JSON.stringify(LIST_RESULT)))?.workflows,
    ).toHaveLength(2);
    // Unreadable means null — an empty list and a parse failure must be distinguishable.
    expect(readListSavedWorkflowsResult(buildListToolCall("not json"))).toBeNull();
  });

  it("prefers the saved_workflow_list display over the model-facing text projection", () => {
    // Root-cause regression pin: on the v4 wire the output is formatModelContent's XML-style
    // projection (a JSON probe would never hit); when the display channel is present it must
    // take priority over every text probe.
    const toolCall = {
      ...buildListToolCall(
        '<saved_workflows count="1"><workflow name="release-check"/></saved_workflows>',
      ),
      raw: {
        display: {
          kind: "saved_workflow_list",
          workflows: [
            {
              name: "release-check",
              description: WORKFLOW_DESCRIPTION,
              scope: "project",
              path: SAVED_PATH,
              argNames: ["target", "skipTests"],
            },
          ],
          invalid: [{ path: "/workspace/.zcode/workflows/broken.dwf.ts", reason: "yaml_invalid" }],
        },
      },
    };
    const result = readListSavedWorkflowsResult(toolCall);
    expect(result?.workflows).toHaveLength(1);
    expect(result?.workflows[0]?.argNames).toEqual(["target", "skipTests"]);
    expect(result?.invalid).toHaveLength(1);

    renderCard(ListSavedWorkflowsToolCallBlock, buildContext(toolCall));
    expect(screen.getByText("1 workflow")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.queryByText(/saved_workflows count/)).toBeNull();
  });

  it("lists names, descriptions and argument names instead of a JSON dump", () => {
    renderCard(ListSavedWorkflowsToolCallBlock, buildContext(buildListToolCall()));

    expect(screen.getByText("2 workflows")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(screen.getByText("translate-docs")).toBeTruthy();
    expect(screen.getByText(WORKFLOW_DESCRIPTION)).toBeTruthy();
    expect(screen.getByText("target")).toBeTruthy();
    expect(screen.getByText("skipTests")).toBeTruthy();

    // The generic fallback would print the whole toolCall; the dedicated card must not show
    // these structural keys.
    expect(document.body.textContent).not.toContain('"toolId"');
    expect(document.body.textContent).not.toContain('"workflows"');
  });

  it("makes broken files visible without failing the whole listing", () => {
    renderCard(ListSavedWorkflowsToolCallBlock, buildContext(buildListToolCall()));

    expect(screen.getByText("1 file could not be read")).toBeTruthy();
    expect(screen.getByText("/workspace/.zcode/workflows/broken.dwf.ts")).toBeTruthy();
    // A broken file must not crowd out the good ones.
    expect(screen.getByText("release-check")).toBeTruthy();
  });

  it("says the project has none rather than showing an empty body", () => {
    renderCard(ListSavedWorkflowsToolCallBlock, buildContext(buildListToolCall({ workflows: [] })));

    expect(screen.getAllByText("No saved workflows in this project").length).toBeGreaterThan(0);
  });

  it("uses the singular count for one workflow", () => {
    renderCard(
      ListSavedWorkflowsToolCallBlock,
      buildContext(buildListToolCall({ workflows: [LIST_RESULT.workflows[0]] })),
    );

    expect(screen.getByText("1 workflow")).toBeTruthy();
  });

  it("falls back to the generic card when the result is unreadable", () => {
    renderCard(ListSavedWorkflowsToolCallBlock, buildContext(buildListToolCall("not json")));

    expect(document.querySelector('[data-saved-workflow-list="true"]')).toBeNull();
    // The downgrade path just needs to exist — the point is not drawing a fake empty list.
    expect(document.body.textContent).not.toContain("No saved workflows in this project");
  });

  it("renders the listing in zh-CN", () => {
    renderCard(ListSavedWorkflowsToolCallBlock, buildContext(buildListToolCall()), "zh-CN");
    expect(screen.getByText(zhCN["chat.toolCall.workflow.list.listed"])).toBeTruthy();
    expect(
      screen.getByText(zhCN["chat.toolCall.workflow.list.count"].replaceAll("{count}", "2")),
    ).toBeTruthy();
    expect(
      screen.getByText(zhCN["chat.toolCall.workflow.list.invalidOne"].replaceAll("{count}", "1")),
    ).toBeTruthy();
  });

  it("tags global-scoped entries next to the name", () => {
    const withGlobal = {
      workflows: [
        LIST_RESULT.workflows[0],
        {
          name: "deep-research",
          description: "Deep research",
          scope: "global",
          path: "/home/.zcode/workflows/deep-research.dwf.ts",
        },
      ],
      invalid: [],
    };
    renderCard(
      ListSavedWorkflowsToolCallBlock,
      buildContext(buildListToolCall(withGlobal)),
      "en-US",
    );
    const tag = document.querySelector('[data-workflow-scope-tag="global"]');
    expect(tag?.textContent).toBe("Global");
    // Project entries do not get this tag (their scope text stays project).
    expect(document.querySelectorAll('[data-workflow-scope-tag="global"]').length).toBe(1);
  });
});
