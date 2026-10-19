// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));

// ControlHintTooltip depends on a TooltipProvider at the app root; per existing convention the test replaces it with a passthrough stub.
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- The component under test must be imported after the mocks.
import { PermissionDialog } from "@/PermissionDialog.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const SCRIPT = 'const x = 1;\nconst r = await agent("a").ask<string>("do");';
// The CLI-side ask reason is protocol diagnostics text; the confirmation window must not display it.
const CLI_REASON = "createWorkflow.runConfirmation: user must confirm running the analyzed script";

const CAUSALITY_GRAPH = {
  steps: [
    {
      id: "ask#1",
      kind: "ask" as const,
      label: "a",
      line: 2,
      column: 21,
      lane: "actor#1",
    },
  ],
  lanes: [{ id: "actor#1", name: "a", line: 2, column: 11 }],
  // Participant layer: cards of unmarked scripts go to `unphased` (the UI synthesizes an implicit module).
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
  sink: ["ask#1"],
};

const SESSION_OPTION = {
  optionId: "allowSession",
  kind: "allowAlways",
  name: "Always allow in this session",
  response: { decision: "allow" as const, reason: "Approved for this session" },
};

function buildWorkflowRequest(
  overrides: Partial<ZCodePermissionRequest> = {},
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-workflow",
    description: CLI_REASON,
    kind: "CreateWorkflow",
    title: "CreateWorkflow",
    options: [
      {
        optionId: "allowOnce",
        kind: "allowOnce",
        name: "Allow",
        response: { decision: "allow" },
      },
      // Round 7: session-scope no-confirm. The v4 projection maps the kind to allowAlways; the GUI localizes by name.
      SESSION_OPTION,
      {
        optionId: "deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny" },
      },
    ],
    display: {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: CAUSALITY_GRAPH,
    },
    raw: { name: "Research pipeline", script: SCRIPT },
    ...overrides,
  };
}

function renderDialog(
  request: ZCodePermissionRequest = buildWorkflowRequest(),
  locale: "en-US" | "zh-CN" = "en-US",
  onRespond: (requestId: string, option: unknown, feedback?: string) => void = () => {},
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(PermissionDialog, {
        request,
        onRespond,
        workspacePath: "/workspace",
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("WorkflowPermissionBlock", () => {
  it("renders the timeline as the primary body and keeps the script folded", () => {
    renderDialog();

    // Timeline (docs/dynamic-workflow/presentation.md "The confirmation window"): an unmarked script is one
    // implicit station "Workflow", and the pills carry the lane's original author names. No zoom entry, no popup.
    const timeline = screen.getByTestId("workflow-timeline");
    expect(timeline.textContent).toContain("Workflow");
    expect(screen.getByTestId("workflow-agent-pill").textContent).toContain("a");
    expect(screen.queryByLabelText("Expand graph")).toBeNull();
    expect(screen.getByText("Research pipeline")).toBeTruthy();
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
    // Right of the header: static status + count details.
    expect(screen.getByTestId("workflow-card-detail").textContent).toBe("1 phase");

    // The script is the audit detail layer: collapsed by default; Radix Collapsible keeps its content out of the DOM when closed.
    expect(screen.queryByTestId("code-block")).toBeNull();
    expect(document.body.textContent).not.toContain('await agent("a")');
    expect(screen.getByText("Show full script")).toBeTruthy();
  });

  it("renders the localized question in both locales", () => {
    renderDialog(buildWorkflowRequest(), "zh-CN");
    expect(screen.getByText(zhCN["chat.permission.workflow.title"])).toBeTruthy();
    expect(screen.getByText(zhCN["chat.permission.workflow.showScript"])).toBeTruthy();
    cleanup();

    renderDialog(buildWorkflowRequest(), "en-US");
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
  });

  it("asks the question above the workflow name", () => {
    renderDialog();

    // Deliberate order: the dialog's generic title "permission required" read together with the question forms the full ask; the name line is the title of the graph below it.
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Run this workflow?")).toBeGreaterThanOrEqual(0);
    expect(blockText.indexOf("Run this workflow?")).toBeLessThan(
      blockText.indexOf("Research pipeline"),
    );
  });

  it("shows the full script after the fold is toggled open", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Show full script"));

    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Hide full script")).toBeTruthy();
  });

  // Long scripts no longer stretch the dialog: the script region is height-capped and scrollable.
  it("bounds the script region with a max height and makes it scrollable", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Show full script"));

    const scroller = screen.getByTestId("workflow-script-scroll");
    expect(scroller.className).toMatch(/max-h-/u);
    expect(scroller.className).toMatch(/overflow-auto/u);
  });

  it("opens the script by default when there is no graph to show", () => {
    renderDialog(
      buildWorkflowRequest({
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
      }),
    );

    expect(screen.queryByTestId("workflow-timeline")).toBeNull();
    // A zero-step script has no graph to show; the code is the only content.
    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Hide full script")).toBeTruthy();
  });

  it("treats a participant-less graph as no graph", () => {
    renderDialog(
      buildWorkflowRequest({
        display: {
          kind: "create_workflow",
          ok: true,
          errorCount: 0,
          diagnostics: [],
          causalityGraph: { steps: [], lanes: [], participants: [], handoffs: [] },
        },
      }),
    );

    expect(screen.queryByTestId("workflow-timeline")).toBeNull();
    expect(screen.getByTestId("code-block")).toBeTruthy();
  });

  it("degrades to an open script when the ask carries no preview at all", () => {
    // Failure path: prepareApproval throws → a plain ask without a preview. The gate still stands; there is
    // just no graph, and the script becomes the only auditable content.
    renderDialog(buildWorkflowRequest({ display: undefined }));

    expect(screen.queryByTestId("workflow-timeline")).toBeNull();
    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
  });

  it("renders header and question without crashing when the input has no script", () => {
    renderDialog(buildWorkflowRequest({ display: undefined, raw: { name: "Broken input" } }));

    expect(screen.getByText("Run this workflow?")).toBeTruthy();
    expect(screen.getByText("Broken input")).toBeTruthy();
    expect(screen.queryByTestId("code-block")).toBeNull();
    expect(screen.queryByText("Show full script")).toBeNull();
  });

  // ── The amendment confirmation window (docs/dynamic-workflow/launch.md "The `AmendWorkflow` tool";
  // presentation.md "The confirmation window") ── appears only for runs of another session: the question
  // changes wording and a lineage line is added. Facts are rendered from the **tool input** (`run_id` and the
  // CLI-backfilled `predecessor`); display is not changed by a single byte — the graph is still create_workflow.

  function buildAmendRequest(raw: Record<string, unknown>): ZCodePermissionRequest {
    return buildWorkflowRequest({
      kind: "AmendWorkflow",
      title: "AmendWorkflow",
      description: "amendWorkflow.runConfirmation: user must confirm running the revised script",
      raw,
    });
  }

  it("asks 'Amend this workflow?' with the lineage line for an AmendWorkflow ask", () => {
    renderDialog(
      buildAmendRequest({
        name: "Research pipeline",
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
      }),
    );

    expect(screen.getByTestId("workflow-card-kind").textContent).toBe("Amend this workflow?");
    expect(document.body.textContent).not.toContain("Run this workflow?");
    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage).toBeTruthy();
    expect(lineage?.textContent).toContain("Amends run");
    expect(lineage?.textContent).toContain("dwfrun-prev");
    // The predecessor is settled: no "will be stopped" sentence.
    expect(lineage?.getAttribute("data-workflow-amends-live")).toBeNull();
    expect(lineage?.textContent).not.toContain("still running");
    // The graph is still the body and the script still the collapsed audit layer: lineage is just one extra line.
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.queryByTestId("code-block")).toBeNull();
  });

  it.each(["running", "pending"] as const)(
    "says the predecessor will be stopped when it is still in flight (%s)",
    (status) => {
      renderDialog(
        buildAmendRequest({
          script: SCRIPT,
          run_id: "dwfrun-live",
          predecessor: { status, owned_by_this_session: false },
        }),
      );

      const lineage = document.querySelector('[data-workflow-amends="true"]');
      expect(lineage?.getAttribute("data-workflow-amends-live")).toBe("true");
      expect(lineage?.textContent).toContain("still running, will be stopped");
    },
  );

  it("localizes the amend title and lineage", () => {
    renderDialog(
      buildAmendRequest({
        name: "Research pipeline",
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "running", owned_by_this_session: false },
      }),
      "zh-CN",
    );

    expect(screen.getByTestId("workflow-card-kind").textContent).toBe(
      zhCN["chat.permission.workflow.amend.title"],
    );
    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.textContent).toContain("调整 run");
    expect(lineage?.textContent).toContain("dwfrun-prev");
    expect(lineage?.textContent).toContain(zhCN["chat.permission.workflow.amends.running"]);
  });

  // An amend omitting script (docs/dynamic-workflow/launch.md "Keeping the predecessor's script"): the CLI has
  // backfilled the predecessor's script into the input and stamped `predecessor.script_inherited`. The window
  // draws the graph as usual and the script stays expandable — what is being reviewed is exactly what will run
  // — and the lineage line adds "script unchanged" so the user knows only the settings changed this time.
  it("says 'script unchanged' on the lineage line when the amend keeps the predecessor's script", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        max_concurrency: 2,
        predecessor: { status: "running", owned_by_this_session: false, script_inherited: true },
      }),
    );

    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.getAttribute("data-workflow-amends-script-inherited")).toBe("true");
    expect(lineage?.textContent).toContain("dwfrun-prev");
    expect(lineage?.textContent).toContain("script unchanged");
    expect(lineage?.textContent).toContain("still running, will be stopped");
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.getByText("Show full script")).toBeTruthy();
    expect(screen.getByTestId("workflow-permission-max-concurrency").textContent).toBe(
      "At most 2 subagents at once",
    );
  });

  it("says nothing about the script when the amend passes one", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
      }),
    );

    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.getAttribute("data-workflow-amends-script-inherited")).toBeNull();
    expect(lineage?.textContent).not.toContain("script unchanged");
  });

  it("localizes 'script unchanged'", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false, script_inherited: true },
      }),
      "zh-CN",
    );

    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.textContent).toContain("脚本不变");
  });

  it("omits the lineage line entirely for a CreateWorkflow ask", () => {
    // CreateWorkflow has no predecessor (and no more resume_from): no empty line, no placeholder wording, the question stays as-is.
    renderDialog();

    expect(screen.getByTestId("workflow-card-kind").textContent).toBe("Run this workflow?");
    expect(document.querySelector('[data-workflow-amends="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Amends run");
  });

  it("ignores a blank run_id instead of rendering an empty lineage", () => {
    renderDialog(buildAmendRequest({ script: SCRIPT, run_id: "  " }));

    expect(document.querySelector('[data-workflow-amends="true"]')).toBeNull();
  });

  // ── Concurrency cap (docs/dynamic-workflow/concurrency.md "Two bounds on a run") ──
  // The model only writes `max_concurrency` when the user asks for it, so the row's presence is itself a
  // user-raised condition.
  // Same discipline as lineage: facts are read from the **tool input**; display is not changed by a single byte.

  function queryMaxConcurrency(): HTMLElement | null {
    return screen.queryByTestId("workflow-permission-max-concurrency");
  }

  it("says how many subagents may run at once when the input carries max_concurrency", () => {
    renderDialog(
      buildWorkflowRequest({
        raw: { name: "Research pipeline", script: SCRIPT, max_concurrency: 3 },
      }),
    );

    expect(queryMaxConcurrency()?.textContent).toBe("At most 3 subagents at once");
  });

  it("shows the same row for an AmendWorkflow ask, right after the lineage row", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
        max_concurrency: 2,
      }),
    );

    expect(queryMaxConcurrency()?.textContent).toBe("At most 2 subagents at once");
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Amends run")).toBeLessThan(blockText.indexOf("At most 2"));
  });

  it("localizes the row", () => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT, max_concurrency: 4 } }), "zh-CN");

    expect(queryMaxConcurrency()?.textContent).toBe("最多 4 个子代理同时运行");
  });

  it.each([
    ["omitted", {}],
    // The amend's `null` = remove the cap: no cap to speak of, handled the same as absence.
    ["null (the amend 'remove the limit' value)", { max_concurrency: null }],
    ["not a positive integer", { max_concurrency: 0 }],
    ["not an integer", { max_concurrency: 2.5 }],
  ])("renders no row when max_concurrency is %s", (_case, extra) => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT, ...extra } }));

    expect(queryMaxConcurrency()).toBeNull();
    expect(document.body.textContent).not.toContain("subagents at once");
  });

  // ── Subagent model (docs/dynamic-workflow/presentation.md) ──
  // The model only writes `subagent_model` when the user explicitly asks, so the row's presence is itself a
  // user-raised condition.
  // The value reaching the window has already been parsed by the CLI's resolveInput into the canonical string
  // `providerId/modelId[$level]` — but the canonical string is for machine backfill: the screen speaks model
  // names and level words, and the canonical string lives only in this row's tooltip.

  // The team-plan provider id is a string of hex: exactly what this change must keep off the screen.
  const TEAM_PLAN_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  function querySubagentModel(): HTMLElement | null {
    return screen.queryByTestId("workflow-permission-subagent-model");
  }

  it("says which model the subagents run on, by name and not by canonical string", () => {
    renderDialog(
      buildWorkflowRequest({
        raw: {
          name: "Research pipeline",
          script: SCRIPT,
          subagent_model: "zhipu/glm-5.3-flash",
        },
      }),
    );

    expect(querySubagentModel()?.textContent).toBe("Subagents run on glm-5.3-flash");
  });

  it("never shows the provider id, even when it is a team-plan UUID", () => {
    renderDialog(
      buildWorkflowRequest({ raw: { script: SCRIPT, subagent_model: TEAM_PLAN_MODEL } }),
    );

    const row = querySubagentModel();
    expect(row?.textContent).toContain("GLM-5.3-Flash");
    expect(row?.textContent).not.toContain("4fc7f541");
    // The canonical string is not lost; it is in the tooltip — backfill and debugging can still read it.
    expect(row?.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
  });

  it("keeps the reasoning level, as a word: the level is part of the choice being approved", () => {
    renderDialog(
      buildWorkflowRequest({ raw: { script: SCRIPT, subagent_model: "anthropic/opus-5$high" } }),
    );

    expect(querySubagentModel()?.textContent).toBe("Subagents run on opus-5 · thinking High");
  });

  // The same order as the two adjustable sentences (docs/dynamic-workflow/presentation.md "The confirmation window"): model on top, cap below.
  it("sits directly above the concurrency row, and shows on an AmendWorkflow ask too", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
        max_concurrency: 2,
        subagent_model: "zhipu/glm-5.3-flash",
      }),
    );

    expect(querySubagentModel()?.textContent).toBe("Subagents run on glm-5.3-flash");
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Subagents run on")).toBeLessThan(blockText.indexOf("At most 2"));
  });

  it("localizes the subagent-model row, leaving the model name untranslated", () => {
    renderDialog(
      buildWorkflowRequest({ raw: { script: SCRIPT, subagent_model: "anthropic/opus-5$high" } }),
      "zh-CN",
    );

    expect(querySubagentModel()?.textContent).toBe("子代理运行在 opus-5 · 思考 高");
  });

  it.each([
    ["omitted", {}],
    // The amend's `null` = back to the session model: no second model to speak of, handled the same as absence.
    ["null (the amend 'back to the session model' value)", { subagent_model: null }],
    ["blank", { subagent_model: "   " }],
    ["not a string", { subagent_model: { providerId: "zhipu", modelId: "glm-5.3-flash" } }],
  ])("renders no row when subagent_model is %s", (_case, extra) => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT, ...extra } }));

    expect(querySubagentModel()).toBeNull();
    expect(document.body.textContent).not.toContain("Subagents run on");
  });

  it("never paints the waiting ask with the success color, and says nothing about compiling", () => {
    renderDialog();

    // DESIGN.md reserves green for the awaiting-confirmation state. The header once had an empty "compiled"
    // ring light; removed as of 2026-09-09 — reaching the confirmation window already proves the script passed
    // validation, so the word carries no information for the user.
    expect(document.body.innerHTML).not.toContain("text-success");
    expect(screen.queryByTestId("workflow-card-static-status")).toBeNull();
    expect(document.body.textContent).not.toContain("compiled");
  });
});

describe("PermissionDialog workflow dispatch", () => {
  it("renders the workflow block instead of the fallback JSON dump", () => {
    renderDialog();

    expect(document.querySelector('[data-workflow-permission-block="true"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('"script"');
    expect(document.body.textContent).not.toContain("toolName");
  });

  it("suppresses the diagnostic CLI reason", () => {
    renderDialog();

    expect(document.body.textContent).not.toContain(CLI_REASON);
    expect(document.body.textContent).not.toContain("createWorkflow.runConfirmation");
  });

  it("renders Run / Always allow in this session / Deny, in that order", () => {
    renderDialog();

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.getAttribute("data-permission-option-kind"))).toEqual([
      "allowOnce",
      "allowAlways",
      "rejectOnce",
    ]);
    expect(document.body.textContent).toContain("Allow");
    expect(document.body.textContent).toContain("Deny");
  });

  // Session-scope no-confirm (docs/dynamic-workflow/launch.md "Always allow in this session"): the name hits localization, and the description does not reuse the project-level copy.
  it.each([
    ["en-US", "Always allow in this session", "Do not ask again for workflows in this session"],
    ["zh-CN", "本会话内始终允许", "本会话内运行工作流不再询问"],
  ] as const)("localizes the session option in %s", (locale, label, description) => {
    renderDialog(buildWorkflowRequest(), locale);

    const option = document.querySelector('[data-permission-option-kind="allowAlways"]')!;
    expect(option.textContent).toContain(label);
    expect(option.textContent).toContain(description);
    expect(option.textContent).not.toContain("same permission request");
    expect(option.textContent).not.toContain("相同权限请求");
  });

  it("clicking the session option responds with optionId allowSession and no feedback", () => {
    const onRespond = vi.fn();
    renderDialog(buildWorkflowRequest(), "en-US", onRespond);

    const session = document.querySelector('[data-permission-option-kind="allowAlways"]')!;
    // An unselected option's first click only selects; the second click responds (existing semantics).
    fireEvent.click(session);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(session);

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith(
      "perm-workflow",
      expect.objectContaining({ optionId: "allowSession" }),
      undefined,
    );
  });

  it("the session option is not rendered when the CLI does not offer it (no-always-allow tools)", () => {
    const base = buildWorkflowRequest();
    renderDialog({
      ...base,
      options: base.options.filter((option) => option.optionId !== "allowSession"),
    });

    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(document.querySelectorAll('[data-permission-option-kind="allowAlways"]')).toHaveLength(
      0,
    );
  });

  it("still renders the graph when the ask carries no workflow name", () => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT } }));

    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    // When the name is missing, fall back to the same fallback name as the chat area.
    expect(screen.getByText("Workflow script")).toBeTruthy();
  });
});

// ── The Refine option (docs/dynamic-workflow/launch.md "Refine") ──
// The v4 projection adds a third option workflowRefine to CreateWorkflow; the GUI does not draw it as a
// button but reuses the numbered inline feedback input row shared by other confirmation windows, and the
// submission hands the freeText together with that option to the response.

const REFINE_OPTION = {
  optionId: "workflowRefine",
  kind: "custom",
  name: "Refine",
  response: { decision: "deny" as const, reason: "Denied" },
};

function buildRefineRequest(): ZCodePermissionRequest {
  const base = buildWorkflowRequest();
  return { ...base, options: [...base.options, REFINE_OPTION] };
}

function queryRefineInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(
    '[data-permission-feedback-option="workflowRefine"]',
  );
}

describe("PermissionDialog workflow refine", () => {
  it("Refine 渲染为紧随 Run/Deny 的编号反馈行，而不是第三个选项按钮", () => {
    renderDialog(buildRefineRequest(), "en-US");

    // Only the three option buttons Run / Session / Deny; Refine takes no listbox slot.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.queryByRole("option", { name: "Refine" })).toBeNull();

    const input = queryRefineInput();
    expect(input).toBeTruthy();
    expect(input!.closest('[role="listbox"]')).toBeNull();
    // Same structure as the generic feedback row: number + textarea, with the number right after the three buttons (continuing as 4 from round 7).
    expect(input!.previousElementSibling?.textContent).toBe("4.");
    expect(input!.placeholder).toBe("Describe how the workflow should change…");
    expect(input!.getAttribute("aria-label")).toBe("Refine");
    // The generic "deny with feedback" row no longer appears separately: Refine is this window's feedback row.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it.each(["Enter", "confirm"])(
    "通过 %s 提交把 trim 后的 freeText 连同 Refine 选项交给 onRespond；空白禁发",
    (method) => {
      const onRespond = vi.fn();
      renderDialog(buildRefineRequest(), "en-US", onRespond);
      const input = queryRefineInput()!;
      const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;

      act(() => input.focus());
      // Blank: the confirm button is disabled and Enter produces no response either.
      fireEvent.change(input, { target: { value: "   " } });
      expect(confirm.disabled).toBe(true);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onRespond).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: " 只保留三个 finder " } });
      expect(confirm.disabled).toBe(false);
      if (method === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.click(confirm);

      expect(onRespond).toHaveBeenCalledTimes(1);
      expect(onRespond).toHaveBeenCalledWith(
        "perm-workflow",
        expect.objectContaining({ optionId: "workflowRefine" }),
        // Trim before submitting: the CLI broker turns a blank freeText into a plain deny; pure whitespace must not be treated as feedback.
        "只保留三个 finder",
      );
    },
  );

  it("Esc 只让输入行失焦并保留草稿（同通用反馈行，不再收起什么）", () => {
    const onRespond = vi.fn();
    renderDialog(buildRefineRequest(), "en-US", onRespond);
    const input = queryRefineInput()!;

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "先跑 lint 再 fan out" } });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
    expect(queryRefineInput()!.value).toBe("先跑 lint 再 fan out");
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("方向键在 Run / Session / Deny 与 Refine 行之间循环，数字 4 直达 Refine 行", async () => {
    renderDialog(buildRefineRequest(), "en-US");
    const options = screen.getAllByRole("option");
    const input = queryRefineInput()!;
    const row = input.parentElement!;

    await waitFor(() => {
      expect(document.activeElement).toBe(options[0]);
    });
    fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(row.classList.contains("bg-selected")).toBe(true);
    expect(options.every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => {
      expect(document.activeElement).toBe(options[0]);
    });
    expect(row.classList.contains("bg-selected")).toBe(false);

    fireEvent.keyDown(options[0]!, { key: "4" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it("Run / Deny 的即时应答语义不受 Refine 行影响；Deny 不携带 Refine 草稿", () => {
    const onRespond = vi.fn();
    renderDialog(buildRefineRequest(), "en-US", onRespond);

    // The draft belongs to Refine: clicking Deny is a plain rejection; the refinement must not go out as a plain-rejection reason.
    const input = queryRefineInput()!;
    fireEvent.change(input, { target: { value: "把 fan out 改成串行" } });

    const deny = screen.getByRole("option", { name: "Deny" });
    // An unselected option's first click only selects; the second click responds (existing semantics).
    fireEvent.click(deny);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(deny);
    expect(onRespond).toHaveBeenCalledWith(
      "perm-workflow",
      expect.objectContaining({ optionId: "deny" }),
      undefined,
    );
  });

  it("双语渲染 Refine 行文案", () => {
    renderDialog(buildRefineRequest(), "zh-CN");
    expect(queryRefineInput()!.placeholder).toBe(
      zhCN["chat.permission.workflow.refine.placeholder"],
    );
    expect(queryRefineInput()!.getAttribute("aria-label")).toBe(
      zhCN["chat.permission.workflow.refine"],
    );
    cleanup();

    renderDialog(buildRefineRequest(), "en-US");
    expect(queryRefineInput()!.placeholder).toBe("Describe how the workflow should change…");
  });
});
