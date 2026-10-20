// @vitest-environment jsdom
// Workflow detail page (docs/dynamic-workflow/launch.md "The detail page", "Metadata editing", "Run history").
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_DETAIL_DESCRIPTION,
  TID_WORKFLOW_DETAIL_MENU,
  TID_WORKFLOW_DETAIL_PROJECT,
  TID_WORKFLOW_DETAIL_SCRIPT,
  TID_WORKFLOW_DETAIL_WHEN_TO_USE,
  TID_WORKFLOW_ACTION_MOVE,
  TID_WORKFLOW_META_DISCARD,
  TID_WORKFLOW_META_SAVE,
  TID_WORKFLOW_ARTIFACT_CHIP,
  TID_WORKFLOW_RUN_ROW,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsGetResult,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const toastMock = vi.fn();
vi.mock("@/components/ui/toast.js", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) =>
    createElement("pre", { "data-script": "true", "data-language": language }, code),
}));
vi.mock("@/settings/SettingsHeaderBreadcrumb.js", () => ({
  SettingsBreadcrumbReporter: ({ items }: { items: readonly { label: string }[] }) =>
    createElement(
      "nav",
      { "data-testid": "breadcrumb" },
      items.map((item, index) => createElement("span", { key: index }, item.label)),
    ),
}));

const { SavedWorkflowDetailView } =
  await import("@/settings/saved-workflows/SavedWorkflowDetailView.js");

const SCRIPT = 'export default async ({ agent }) => {\n  await agent("Check the release");\n};\n';
const ENTRY: ZCodeSavedWorkflowEntry = {
  name: "release-check",
  description: "Pre-release check",
  whenToUse: "Before a release",
  scope: "project",
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
  args: { branch: { type: "string", required: true } },
};
const detailResult: { current: ZCodeWorkflowsGetResult } = {
  current: {
    ok: true,
    name: "release-check",
    path: ENTRY.path,
    scope: "project",
    meta: {
      description: "Pre-release check",
      whenToUse: "Before a release",
      args: { branch: { type: "string", required: true } },
    },
    script: SCRIPT,
  },
};
const agentService = {
  getSavedWorkflow: vi.fn(async () => detailResult.current),
  updateSavedWorkflowMeta: vi.fn(async () => ({
    ok: true as const,
    path: ENTRY.path,
  })),
};

const NOW = 1_700_000_000_000;
const RUNS: ZCodeSavedWorkflowRun[] = [
  {
    runId: "r-open",
    name: "release-check",
    status: "completed",
    createdAt: NOW - 90_000,
    updatedAt: NOW - 60_000,
    spentTokens: 4200,
    parentSessionId: "s1",
    toolCallId: "t1",
    args: { branch: "main" },
  },
  {
    runId: "r-orphan",
    name: "release-check",
    status: "failed",
    createdAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
    spentTokens: 10,
  },
];

function mount(overrides: Partial<Parameters<typeof SavedWorkflowDetailView>[0]> = {}) {
  const props = {
    target: { workspacePath: "/repo" },
    agentService: agentService as unknown as Parameters<
      typeof SavedWorkflowDetailView
    >[0]["agentService"],
    name: "release-check",
    projectLabel: "Beta",
    entry: ENTRY,
    runs: RUNS,
    now: NOW,
    busy: false,
    canOpenRun: true,
    onBack: vi.fn(),
    onRun: vi.fn(),
    onRevise: vi.fn(),
    onCopyPath: vi.fn(),
    onDelete: vi.fn(),
    onOpenRun: vi.fn(),
    onMetaSaved: vi.fn(),
    launchDialog: null,
    ...overrides,
  };
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SavedWorkflowDetailView, props),
    ),
  );
  return props;
}

beforeAll(() => {
  // Radix Tabs / Select need ResizeObserver under jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("SavedWorkflowDetailView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detailResult.current = {
      ok: true,
      name: "release-check",
      path: ENTRY.path,
      scope: "project",
      meta: {
        description: "Pre-release check",
        whenToUse: "Before a release",
        args: { branch: { type: "string", required: true } },
      },
      script: SCRIPT,
    };
  });
  afterEach(() => {
    cleanup();
  });

  it("loads the detail: metadata backfilled, args table has rows, script read-only; no save/discard before edits", async () => {
    mount();
    expect(screen.getByTestId(TID_WORKFLOW_DETAIL)).toBeTruthy();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    expect(description.value).toBe("Pre-release check");
    expect((screen.getByTestId(TID_WORKFLOW_DETAIL_WHEN_TO_USE) as HTMLTextAreaElement).value).toBe(
      "Before a release",
    );
    expect(
      (screen.getByLabelText(expectedCopy("workflows.hub.detail.args.name")) as HTMLInputElement)
        .value,
    ).toBe("branch");
    const script = screen.getByTestId(TID_WORKFLOW_DETAIL_SCRIPT);
    expect(script.querySelector("[data-script]")?.textContent).toBe(SCRIPT);
    expect(script.querySelector("[data-script]")?.getAttribute("data-language")).toBe("typescript");
    expect(script.textContent).toContain("release-check.dwf.ts");
    expect(screen.queryByTestId(TID_WORKFLOW_META_SAVE)).toBeNull();
    expect(screen.queryByTestId(TID_WORKFLOW_META_DISCARD)).toBeNull();
    expect(agentService.getSavedWorkflow).toHaveBeenCalledWith({
      workspacePath: "/repo",
      name: "release-check",
    });
  });

  it("editing the description reveals save/discard; discard returns to the baseline", async () => {
    mount();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "New description" } });
    expect(screen.getByTestId(TID_WORKFLOW_META_SAVE)).toBeTruthy();
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_META_DISCARD));
    expect((screen.getByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION) as HTMLTextAreaElement).value).toBe(
      "Pre-release check",
    );
    expect(screen.queryByTestId(TID_WORKFLOW_META_SAVE)).toBeNull();
    expect(agentService.updateSavedWorkflowMeta).not.toHaveBeenCalled();
  });

  it("save sends only meta (description / whenToUse / args), refetches and notifies the list on success", async () => {
    const props = mount();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "  New description  " } });
    fireEvent.change(screen.getByTestId(TID_WORKFLOW_DETAIL_WHEN_TO_USE), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_META_SAVE));
    await waitFor(() =>
      expect(agentService.updateSavedWorkflowMeta).toHaveBeenCalledWith({
        workspacePath: "/repo",
        name: "release-check",
        meta: {
          description: "New description",
          args: { branch: { type: "string", required: true } },
        },
      }),
    );
    await waitFor(() => expect(props.onMetaSaved).toHaveBeenCalledTimes(1));
    expect(agentService.getSavedWorkflow).toHaveBeenCalledTimes(2);
    expect(toastMock).toHaveBeenCalledWith(expectedCopy("workflows.hub.detail.meta.saved"));
  });

  it("rejects the save with a hint when the description is blank", async () => {
    mount();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_META_SAVE));
    expect(
      screen.getByText(expectedCopy("workflows.hub.detail.meta.descriptionRequired")),
    ).toBeTruthy();
    expect(agentService.updateSavedWorkflowMeta).not.toHaveBeenCalled();
  });

  it("run history: one row per run; only rows with ownership fields offer open-run", async () => {
    const props = mount();
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    // Radix Tabs triggers activate on mousedown, not click.
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });
    const openable = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    const orphan = screen.getByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-orphan"));
    expect(openable.textContent).toContain("branch=main");
    expect(openable.textContent).toContain("4.2k tokens");
    const openButton = Array.from(openable.querySelectorAll("button")).find(
      (button) => button.textContent === expectedCopy("workflows.hub.history.open"),
    );
    expect(openButton).toBeTruthy();
    expect(orphan.textContent).not.toContain(expectedCopy("workflows.hub.history.open"));
    fireEvent.click(openButton!);
    expect(props.onOpenRun).toHaveBeenCalledWith(RUNS[0]);
  });

  it("no open-run button when canOpenRun is false", async () => {
    mount({ canOpenRun: false });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    // Radix Tabs triggers activate on mousedown, not click.
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });
    await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    expect(screen.queryByText(expectedCopy("workflows.hub.history.open"))).toBeNull();
  });

  it("breadcrumb has only the workflow name; project ownership is the small tag by the title", async () => {
    mount({ projectLabel: "Alpha" });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    const crumbs = Array.from(screen.getByTestId("breadcrumb").querySelectorAll("span")).map(
      (s) => s.textContent,
    );
    // A project is just a group in the list, not a page: putting it in the breadcrumb would be a dead hierarchy level.
    expect(crumbs).toEqual(["release-check"]);
    const projectTag = screen.getByTestId(TID_WORKFLOW_DETAIL_PROJECT);
    expect(projectTag.textContent).toBe("Alpha");
    // The tag is plain text, not a button or link.
    expect(projectTag.closest("button, a")).toBeNull();
  });

  it("project ownership still shows by the title when the file cannot be read", async () => {
    detailResult.current = { ok: false, reason: "not_found" };
    mount({ entry: undefined, projectLabel: "Alpha" });
    await screen.findByText(expectedCopy("workflows.hub.detail.notFound"));
    expect(screen.getByTestId(TID_WORKFLOW_DETAIL_PROJECT).textContent).toBe("Alpha");
  });

  it("shows a notice instead of a form when the file no longer exists", async () => {
    detailResult.current = { ok: false, reason: "not_found" };
    mount({ entry: undefined });
    expect(await screen.findByText(expectedCopy("workflows.hub.detail.notFound"))).toBeTruthy();
    expect(screen.queryByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION)).toBeNull();
  });

  it("resolveRunProject renders a project column per row and gates open-run on the row canOpen", async () => {
    const resolveRunProject = vi.fn((run: ZCodeSavedWorkflowRun) =>
      run.runId === "r-open"
        ? { label: "Alpha", title: "/repo/alpha", canOpen: true }
        : { label: "Beta", title: "/repo/beta", canOpen: false },
    );
    const props = mount({ resolveRunProject });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });
    const openable = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    const project = openable.querySelector('[data-workflow-run-project="true"]');
    expect(project?.textContent).toBe("Alpha");
    expect(project?.getAttribute("title")).toBe("/repo/alpha");
    // r-open: global canOpenRun + ids + row canOpen all hold → open-run available.
    const openButton = Array.from(openable.querySelectorAll("button")).find(
      (button) => button.textContent === expectedCopy("workflows.hub.history.open"),
    );
    expect(openButton).toBeTruthy();
    fireEvent.click(openButton!);
    expect(props.onOpenRun).toHaveBeenCalledWith(RUNS[0]);
  });

  it("resolveRunProject hides open-run when the row canOpen=false (even with ownership fields)", async () => {
    mount({ resolveRunProject: () => ({ label: "Alpha", canOpen: false }) });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });
    const openable = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    expect(openable.textContent).not.toContain(expectedCopy("workflows.hub.history.open"));
  });

  it("no project column when resolveRunProject is not passed", async () => {
    mount();
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });
    await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    expect(document.querySelector('[data-workflow-run-project="true"]')).toBeNull();
  });

  // ── Artifacts (docs/dynamic-workflow/authoring.md "How the user sees them") ──
  // ⚠ Terminology: "artifacts" here are outputs the script delivers via `artifact.*`, not the script's top-level return value.
  const ARTIFACT_RUNS: ZCodeSavedWorkflowRun[] = [
    {
      runId: "r-latest",
      name: "release-check",
      status: "completed",
      createdAt: NOW - 90_000,
      updatedAt: NOW - 60_000,
      spentTokens: 10,
      parentSessionId: "s1",
      toolCallId: "t1",
      artifacts: [
        { id: "book", kind: "file", title: "Audit report", version: 2 },
        { id: "perf", kind: "chart", title: "Per-round duration", version: 1 },
      ],
    },
    {
      // Legacy row: no parentSessionId (chip not clickable) and no artifacts key (old CLI omits it).
      runId: "r-legacy",
      name: "release-check",
      status: "completed",
      createdAt: NOW - 5_000,
      updatedAt: NOW - 1_000,
      spentTokens: 10,
      artifacts: [{ id: "old", kind: "markdown", title: "Legacy summary", version: 1 }],
    },
  ];

  it("run-history rows attach artifact chips after the status; clicking one hands (run, artifact id) to the host", async () => {
    const onOpenArtifact = vi.fn();
    mount({ runs: ARTIFACT_RUNS, onOpenArtifact });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });

    const row = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-latest"));
    const chips = Array.from(row.querySelectorAll(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`));
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[0]!);
    expect(onOpenArtifact).toHaveBeenCalledWith(ARTIFACT_RUNS[0], "book");
  });

  it("legacy rows without parentSessionId have non-clickable chips — the artifact tab must return to the session that started it", async () => {
    const onOpenArtifact = vi.fn();
    mount({ runs: ARTIFACT_RUNS, onOpenArtifact });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });

    const row = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-legacy"));
    const chip = row.querySelector(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`);
    expect(chip?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(chip!);
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("chips remain when the host injects no open capability, just all disabled", async () => {
    mount({ runs: ARTIFACT_RUNS });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText(`${expectedCopy("workflows.hub.detail.tab.history")} 2`), {
      button: 0,
    });

    const row = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-latest"));
    const chips = Array.from(row.querySelectorAll(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`));
    expect(chips).toHaveLength(2);
    expect(chips.every((chip) => chip.hasAttribute("disabled"))).toBe(true);
  });

  it("the detail header's latest-artifacts strip takes the most recent completed run", async () => {
    const onOpenArtifact = vi.fn();
    mount({
      runs: [
        // The most recent run failed and delivered nothing: it must not displace existing deliveries.
        {
          runId: "r-failed",
          name: "release-check",
          status: "failed",
          createdAt: NOW - 2_000,
          updatedAt: NOW - 1_000,
          spentTokens: 0,
          parentSessionId: "s2",
        },
        ...ARTIFACT_RUNS,
      ],
      onOpenArtifact,
    });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);

    const strip = screen.getByTestId("workflow-detail-artifacts");
    expect(strip.textContent).toContain(expectedCopy("workflows.hub.artifacts.latest"));
    expect(strip.textContent).toContain("Audit report");
    fireEvent.click(strip.querySelectorAll(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`)[1]!);
    expect(onOpenArtifact).toHaveBeenCalledWith(ARTIFACT_RUNS[0], "perf");
  });

  it("the latest-artifacts strip is entirely absent when there are no artifacts", async () => {
    mount({ onOpenArtifact: vi.fn() });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    expect(screen.queryByTestId("workflow-detail-artifacts")).toBeNull();
  });

  it('with onMove the detail menu shows the scope action: project-scope "Promote to global"', async () => {
    const onMove = vi.fn();
    mount({ onMove });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.pointerDown(screen.getByTestId(TID_WORKFLOW_DETAIL_MENU), {
      button: 0,
      ctrlKey: false,
    });
    const moveItem = screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check"));
    expect(moveItem.textContent).toBe(expectedCopy("workflows.hub.card.promoteToGlobal"));
    fireEvent.click(moveItem);
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('global-scope detail menu move action is "Move to project…"', async () => {
    mount({ entry: { ...ENTRY, scope: "global" }, onMove: vi.fn() });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.pointerDown(screen.getByTestId(TID_WORKFLOW_DETAIL_MENU), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check")).textContent).toBe(
      expectedCopy("workflows.hub.card.moveToProject"),
    );
  });

  it("no move action in the detail menu without onMove", async () => {
    mount();
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.pointerDown(screen.getByTestId(TID_WORKFLOW_DETAIL_MENU), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.queryByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check"))).toBeNull();
  });
});
