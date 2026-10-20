// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// Same stub set as workflowPermissionBlock.test.ts: CodeBlock becomes an assertable <pre>. The timeline is
// pure DOM and needs no stub.
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- the component under test must be imported after the mocks.
import { PermissionDialog } from "@/PermissionDialog.js";

const SCRIPT =
  'const x = 1;\nconst r = await agent("a").ask<string>("Check " + String(args.target));';
const SAVED_PATH = "/workspace/.zcode/workflows/release-check.dwf.ts";
// The CLI-side ask reason is protocol diagnostics copy; neither confirmation dialog may show it.
const SAVE_CLI_REASON = "saveWorkflow.confirmation: user must confirm writing the workflow file";

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
  participants: [
    {
      id: "unphased:actor#1",
      phase: "unphased",
      lane: "actor#1",
      steps: ["ask#1"],
    },
  ],
  handoffs: [],
  sink: ["ask#1"],
};

const STANDARD_OPTIONS = [
  {
    optionId: "allowOnce",
    kind: "allowOnce",
    name: "Allow",
    response: { decision: "allow" },
  },
  {
    optionId: "deny",
    kind: "deny",
    name: "Deny",
    response: { decision: "deny" },
  },
];

function buildRunRequest(overrides: Partial<ZCodePermissionRequest> = {}): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-run",
    description: "createWorkflow.runConfirmation: user must confirm running the analyzed script",
    kind: "CreateWorkflow",
    title: "CreateWorkflow",
    options: STANDARD_OPTIONS,
    display: {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: CAUSALITY_GRAPH,
    },
    raw: { name: "Release check", script: SCRIPT },
    ...overrides,
  } as ZCodePermissionRequest;
}

/** Launched from a saved source: the normalized input carries `saved` besides `script`; the display shape is byte-identical. */
function buildSavedRunRequest(saved: Record<string, unknown> = {}): ZCodePermissionRequest {
  return buildRunRequest({
    raw: {
      name: "Release check",
      script: SCRIPT,
      saved: {
        name: "release-check",
        path: SAVED_PATH,
        scope: "project",
        args: { target: "packages/ui", skipTests: false },
        ...saved,
      },
    },
  });
}

function buildSaveRequest(overrides: Record<string, unknown> = {}): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-save",
    description: SAVE_CLI_REASON,
    kind: "SaveWorkflow",
    title: "SaveWorkflow",
    options: STANDARD_OPTIONS,
    // spec: this gate has no display payload; the input is the whole content.
    raw: {
      name: "release-check",
      description: "Run a pre-release check on this repository",
      whenToUse: "When the user asks for a release",
      args: {
        target: {
          type: "string",
          required: true,
          description: "Package name or path to check",
        },
        skipTests: { type: "boolean", default: false },
      },
      script: SCRIPT,
      path: SAVED_PATH,
      overwrite: false,
      scope: "project",
      ...overrides,
    },
  } as ZCodePermissionRequest;
}

function renderDialog(
  request: ZCodePermissionRequest,
  locale: "en-US" | "zh-CN" = "en-US",
  onRespond: (requestId: string, option: unknown) => void = () => {},
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

afterEach(cleanup);

// ── Saved-source badge on the run confirmation dialog ──

describe("WorkflowPermissionBlock saved source badge", () => {
  it("renders provenance and arguments from raw.saved", () => {
    renderDialog(buildSavedRunRequest());

    const badge = document.querySelector('[data-workflow-saved-source="true"]');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain("Saved workflow · project");
    expect(document.querySelector('[data-workflow-saved-name="true"]')?.textContent).toBe(
      "release-check",
    );
    expect(document.querySelector('[data-workflow-saved-path="true"]')?.textContent).toBe(
      SAVED_PATH,
    );

    // Args read one by one; booleans go through JSON, strings verbatim (quotes would only add noise for CJK args).
    const args = document.querySelector('[data-workflow-saved-args="true"]');
    expect(args?.textContent).toContain("target");
    expect(args?.textContent).toContain("packages/ui");
    expect(args?.textContent).toContain("skipTests");
    expect(args?.textContent).toContain("false");
  });

  it("is absent for an inline run", () => {
    renderDialog(buildRunRequest());

    expect(document.querySelector('[data-workflow-saved-source="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Saved workflow");
  });

  it("does not displace the graph, and sits above it", () => {
    renderDialog(buildSavedRunRequest());

    // The timeline stays the decision body: the badge takes one line, the timeline renders as usual, the script stays collapsed by default.
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.queryByTestId("code-block")).toBeNull();

    const block = document.querySelector('[data-workflow-permission-block="true"]');
    const badge = document.querySelector('[data-workflow-saved-source="true"]');
    const graph = screen.getByTestId("workflow-timeline");
    expect(block?.contains(badge ?? null)).toBe(true);
    // compareDocumentPosition: FOLLOWING(4) means the graph comes after the badge.
    expect((badge?.compareDocumentPosition(graph) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("still renders without an args table when the argument bag is empty", () => {
    renderDialog(buildSavedRunRequest({ args: {} }));

    expect(document.querySelector('[data-workflow-saved-source="true"]')).toBeTruthy();
    expect(document.querySelector('[data-workflow-saved-args="true"]')).toBeNull();
  });

  it("drops the badge when the saved payload has no name to stand on", () => {
    renderDialog(buildSavedRunRequest({ name: "   " }));

    expect(document.querySelector('[data-workflow-saved-source="true"]')).toBeNull();
    // A missing badge does not affect the decision body of this run.
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
  });

  it("renders the saved source badge in zh-CN", () => {
    renderDialog(buildSavedRunRequest(), "zh-CN");
    expect(document.querySelector('[data-workflow-saved-source="true"]')?.textContent).toContain(
      `${zhCN["chat.permission.workflow.saved.badge"]} · project`,
    );
  });
});

// ── Save confirmation dialog ──

describe("SaveWorkflowPermissionBlock", () => {
  it("renders the save gate instead of the fallback JSON dump", () => {
    renderDialog(buildSaveRequest());

    expect(document.querySelector('[data-save-workflow-permission-block="true"]')).toBeTruthy();
    // The generic fallback would dump the whole toolCall JSON; the rich confirmation block must block it.
    expect(document.body.textContent).not.toContain('"script"');
    expect(document.body.textContent).not.toContain("toolName");
    // The run-confirmation graph and Refine do not belong to a disk write.
    expect(document.querySelector('[data-workflow-permission-block="true"]')).toBeNull();
    expect(screen.queryByTestId("workflow-causality-graph")).toBeNull();
  });

  it("suppresses the diagnostic CLI reason", () => {
    renderDialog(buildSaveRequest());

    expect(document.body.textContent).not.toContain(SAVE_CLI_REASON);
    expect(document.body.textContent).not.toContain("saveWorkflow.confirmation");
  });

  it("shows name, path, description and whenToUse", () => {
    renderDialog(buildSaveRequest());

    expect(screen.getByText("Save this workflow to the project?")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(screen.getByText(SAVED_PATH)).toBeTruthy();
    expect(screen.getByText("Run a pre-release check on this repository")).toBeTruthy();
    expect(screen.getByText("When the user asks for a release")).toBeTruthy();
  });

  it("renders the args declaration table with type, required and default", () => {
    renderDialog(buildSaveRequest());

    const table = document.querySelector('[data-workflow-save-args="true"]');
    expect(table).toBeTruthy();

    const target = document.querySelector('[data-workflow-save-arg="target"]');
    expect(target?.textContent).toContain("target");
    expect(target?.textContent).toContain("string");
    expect(target?.textContent).toContain("Required");
    expect(table?.textContent).toContain("Package name or path to check");

    const skipTests = document.querySelector('[data-workflow-save-arg="skipTests"]');
    expect(skipTests?.textContent).toContain("boolean");
    expect(skipTests?.textContent).toContain("Optional");
    // `default: false` must stay distinguishable from "no default".
    expect(skipTests?.textContent).toContain("false");
  });

  it("keeps the script collapsed by default and opens it on demand", () => {
    renderDialog(buildSaveRequest());

    expect(screen.queryByTestId("code-block")).toBeNull();
    expect(document.body.textContent).not.toContain('await agent("a")');

    fireEvent.click(screen.getByText("Show full script"));

    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Hide full script")).toBeTruthy();
  });

  it("states overwrite as a different sentence, with an emphasised badge and hint", () => {
    renderDialog(buildSaveRequest({ overwrite: true }));

    expect(screen.getByText("Overwrite the existing saved workflow?")).toBeTruthy();
    expect(screen.queryByText("Save this workflow to the project?")).toBeNull();
    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')?.textContent).toBe(
      "overwrite",
    );
    expect(document.querySelector('[data-workflow-overwrite-hint="true"]')).toBeTruthy();
  });

  it("says nothing about overwriting on a fresh save", () => {
    renderDialog(buildSaveRequest());

    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')).toBeNull();
    expect(document.querySelector('[data-workflow-overwrite-hint="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Overwrite");
  });

  it("renders standard allow/deny only, with no refine machinery", () => {
    const onRespond = vi.fn();
    renderDialog(buildSaveRequest(), "en-US", onRespond);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(document.querySelector('[data-permission-feedback-option="workflowRefine"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Refine");

    // Existing semantics: the first click on an unselected option only selects it; the second click responds.
    const deny = screen.getByRole("option", { name: "Deny" });
    fireEvent.click(deny);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(deny);
    // The third argument is the denial feedback text; with no input here the response explicitly carries undefined.
    expect(onRespond).toHaveBeenCalledWith(
      "perm-save",
      expect.objectContaining({ optionId: "deny" }),
      undefined,
    );
  });

  it("survives a payload that carries only a name", () => {
    renderDialog({
      ...buildSaveRequest(),
      raw: { name: "release-check" },
    } as ZCodePermissionRequest);

    expect(screen.getByText("Save this workflow to the project?")).toBeTruthy();
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(document.querySelector('[data-workflow-save-args="true"]')).toBeNull();
    expect(screen.queryByText("Show full script")).toBeNull();
  });

  it("renders the overwrite gate in zh-CN", () => {
    renderDialog(buildSaveRequest({ overwrite: true }), "zh-CN");
    expect(screen.getByText(zhCN["chat.permission.workflow.save.overwriteTitle"])).toBeTruthy();
    expect(document.querySelector('[data-workflow-overwrite-badge="true"]')?.textContent).toBe(
      zhCN["chat.toolCall.workflow.save.overwrite"],
    );
    expect(screen.getByText(zhCN["chat.permission.workflow.save.path"])).toBeTruthy();
    expect(screen.getByText(zhCN["chat.permission.workflow.showScript"])).toBeTruthy();
  });

  it("never paints the save gate with destructive colour", () => {
    // Overwriting replaces rather than deletes: destructive would overstate it. warning is the semantic colour of this action.
    renderDialog(buildSaveRequest({ overwrite: true }));

    expect(document.body.innerHTML).not.toContain("text-destructive");
    expect(document.body.innerHTML).toContain("text-warning");
  });
});

// ── Save confirmation dialog: content ownership, disclosure and keyboard focus ──
// jsdom checks DOM ownership and interaction; no viewport height or sticky-header measurement here.

const LONG_DESCRIPTION = Array.from({ length: 40 }, (_, i) => `Description line ${i + 1}`).join(
  "\n",
);

function manyArgs(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `arg${String(i + 1).padStart(2, "0")}`,
      { type: "string", description: `Argument ${i + 1}` },
    ]),
  );
}

function scrollArea(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-permission-dialog-scroll="true"]');
}

function argRows(): NodeListOf<Element> {
  return document.querySelectorAll("[data-workflow-save-arg]");
}

/**
 * jsdom's scrollHeight / clientHeight are always 0. Disclosure toggles appear only when text is actually
 * clipped, so fake a geometry: visible height 80 everywhere; when `clipped`, line-clamped content is 200 tall.
 */
function fakeClampedTextGeometry(clipped: boolean) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return clipped && this.className.includes("line-clamp-4") ? 200 : 80;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
}

describe("SaveWorkflowPermissionBlock scrolling and disclosure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps inline run confirmation outside the save-only bounded layout", () => {
    // Run confirmation and the generic permission dialog are out of scope for this change; they stay as is.
    renderDialog(buildRunRequest());
    expect(document.querySelector('[data-permission-dialog-bounded="true"]')).toBeNull();
    expect(scrollArea()).toBeNull();
  });

  it("keeps approval controls outside disclosed save content", () => {
    renderDialog(
      buildSaveRequest({
        overwrite: true,
        description: LONG_DESCRIPTION,
        args: manyArgs(40),
      }),
    );
    fireEvent.click(screen.getByText("Show full script"));

    const area = scrollArea();
    // The question, name and overwrite hint live in the scroll area (at its top), not pinned in another layer.
    expect(area?.contains(screen.getByText("Overwrite the existing saved workflow?"))).toBe(true);
    expect(area?.contains(screen.getByText("release-check"))).toBe(true);
    expect(area?.contains(document.querySelector('[data-workflow-overwrite-hint="true"]'))).toBe(
      true,
    );
    // Options and confirm sit outside the scroll area, pinned below.
    expect(area?.contains(screen.getByRole("listbox"))).toBe(false);
    expect(area?.contains(screen.getByRole("button", { name: "Confirm" }))).toBe(false);

    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
  });

  it("shows the first 8 arguments and discloses the rest in place", () => {
    renderDialog(buildSaveRequest({ args: manyArgs(40) }));

    expect(argRows()).toHaveLength(8);
    expect(document.querySelector('[data-workflow-save-arg="arg08"]')).toBeTruthy();
    expect(document.querySelector('[data-workflow-save-arg="arg09"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all 40 arguments" }));
    expect(argRows()).toHaveLength(40);
    expect(scrollArea()?.contains(document.querySelector('[data-workflow-save-arg="arg40"]'))).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show fewer arguments" }));
    expect(argRows()).toHaveLength(8);
  });

  it("offers no argument toggle when everything already fits in the preview", () => {
    renderDialog(buildSaveRequest({ args: manyArgs(8) }));

    expect(argRows()).toHaveLength(8);
    expect(document.querySelector('[data-workflow-save-args-toggle="true"]')).toBeNull();
  });

  describe("description and whenToUse", () => {
    beforeEach(() => {
      fakeClampedTextGeometry(true);
    });

    it("clamps each to 4 lines and toggles it in place", () => {
      renderDialog(buildSaveRequest({ description: LONG_DESCRIPTION }));

      const description = screen.getByText(
        (_, el) => el?.textContent === LONG_DESCRIPTION && el.tagName === "SPAN",
      );
      expect(description.className).toContain("line-clamp-4");

      const toggles = screen.getAllByRole("button", { name: "Show more" });
      // One each for description and whenToUse (both clipped under the faked geometry).
      expect(toggles).toHaveLength(2);
      fireEvent.click(toggles[0]!);
      expect(description.className).not.toContain("line-clamp-4");
      expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(description.className).toContain("line-clamp-4");
    });

    it("resets every disclosure when the next request arrives", () => {
      const view = renderDialog(buildSaveRequest({ args: manyArgs(40) }));
      fireEvent.click(screen.getAllByRole("button", { name: "Show more" })[0]!);
      fireEvent.click(screen.getByRole("button", { name: "Show all 40 arguments" }));
      fireEvent.click(screen.getByText("Show full script"));
      expect(argRows()).toHaveLength(40);

      view.rerender(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(PermissionDialog, {
            request: {
              ...buildSaveRequest({ args: manyArgs(40) }),
              requestId: "perm-save-2",
            },
            onRespond: () => {},
            workspacePath: "/workspace",
          }),
        ),
      );

      expect(argRows()).toHaveLength(8);
      expect(screen.queryByTestId("code-block")).toBeNull();
      expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
    });
  });

  it("offers no text toggle when nothing is cut", () => {
    fakeClampedTextGeometry(false);
    renderDialog(buildSaveRequest());

    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("renders the toggles in both locales", () => {
    fakeClampedTextGeometry(true);
    renderDialog(buildSaveRequest({ args: manyArgs(40) }), "zh-CN");

    expect(
      screen.getAllByRole("button", {
        name: zhCN["chat.permission.workflow.save.showMore"],
      }),
    ).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: zhCN["chat.permission.workflow.save.args.showAll"].replace("{count}", "40"),
      }),
    );
    expect(
      screen.getByRole("button", {
        name: zhCN["chat.permission.workflow.save.args.showFewer"],
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", {
        name: zhCN["chat.permission.workflow.save.showMore"],
      })[0]!,
    );
    expect(
      screen.getByRole("button", {
        name: zhCN["chat.permission.workflow.save.showLess"],
      }),
    ).toBeTruthy();
  });

  // The option list's Tab cycle once trapped focus between options and feedback, keeping keyboard users from
  // the disclosure buttons above; collapsed description, args and script could only be opened with the mouse.
  it("lets Shift+Tab on the first option climb back to the last control in the scroll area", () => {
    renderDialog(buildSaveRequest({ args: manyArgs(40) }));
    const allow = screen.getByRole("option", { name: "Allow" });
    allow.focus();
    fireEvent.keyDown(allow, { key: "Tab", shiftKey: true });

    // The last control in the scroll area is the script toggle: focus lands inside, the option selection is untouched.
    const area = scrollArea();
    expect(area?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain("Show full script");
    expect(allow.getAttribute("aria-selected")).toBe("true");
    // The args disclosure button sits on the same reverse path (inside the area, focusable).
    expect(area?.contains(screen.getByRole("button", { name: "Show all 40 arguments" }))).toBe(
      true,
    );
  });

  it("keeps the option cycle for every other Tab press", async () => {
    renderDialog(buildSaveRequest());
    const allow = screen.getByRole("option", { name: "Allow" });
    const deny = screen.getByRole("option", { name: "Deny" });
    allow.focus();
    fireEvent.keyDown(allow, { key: "Tab" });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    // Shift+Tab off the first item still moves between options without leaving the list.
    fireEvent.keyDown(deny, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(allow));
  });
});
