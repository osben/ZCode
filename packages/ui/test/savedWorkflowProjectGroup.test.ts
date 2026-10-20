// @vitest-environment jsdom
// Single-project workflow group (docs/dynamic-workflow/launch.md "Groups", "Directory watching", "Delete", "Run launching").
// Migrated from the v1 single-project section cases; cards and the detail page have their own cases, so this file
// stubs them and watches only the group's state flow and the **ITS project** target (invariant 8).
// useWorkspaceServices returns different agents per workspacePath, pinning that the group uses ITS project
// rather than the active workspace.
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_LIST,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_PROJECT_GROUP,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsListResult,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resetSavedWorkflowStoreForTests } from "@/store/savedWorkflowStore.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const confirmMock = vi.fn(async () => true);
const toastMock = vi.fn();
let changeListener: (() => void) | null = null;
const watcherDispose = vi.fn();
const fileWatcherService = {
  watch: vi.fn(async () => ({ id: "watch-1" })),
  onDynamicChange: vi.fn(() => (listener: () => void) => {
    changeListener = listener;
    return { dispose: watcherDispose };
  }),
  unwatch: vi.fn(async () => {}),
};

function makeAgent() {
  const listResult: { current: ZCodeWorkflowsListResult } = {
    current: { workflows: [], invalid: [], dir: "/beta/.zcode/workflows" },
  };
  const runsResult: { current: ZCodeSavedWorkflowRun[] } = { current: [] };
  const agent = {
    listResult,
    runsResult,
    listSavedWorkflows: vi.fn(async () => listResult.current),
    listSavedWorkflowRuns: vi.fn(async () => ({ runs: runsResult.current })),
    deleteSavedWorkflow: vi.fn(async () => ({
      ok: true as const,
      path: "/beta/.zcode/workflows/x.dwf.ts",
    })),
    getSavedWorkflow: vi.fn(),
    updateSavedWorkflowMeta: vi.fn(),
  };
  return agent;
}
const agentBeta = makeAgent();
const agentRepo = makeAgent();
const agentByPath: Record<string, ReturnType<typeof makeAgent>> = {
  "/beta": agentBeta,
  "/repo": agentRepo,
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: (workspacePath: string) => ({
    services: {
      zcodeAgentService: agentByPath[workspacePath] ?? agentRepo,
      fileWatcherService,
    },
    remoteSessionId: null,
    isRemoteTarget: false,
    connectionKind: "local-ready" as const,
    rpcReady: true,
  }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => confirmMock,
}));
vi.mock("@/components/ui/toast.js", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));
// The direct launcher is stubbed: the group only opens a dialog by type or fires directly; the launch
// createSession→startSavedWorkflow orchestration and navigation are covered by useSavedWorkflowLauncher
// unit tests — here we only assert the group calls it with the right target + request.
const launchMock = vi.fn(async () => ({
  ok: true as const,
  sessionId: "s-1",
  runId: "r-1",
  toolCallId: "launch-1",
}));
const clearErrorMock = vi.fn();
vi.mock("@/settings/saved-workflows/useSavedWorkflowLauncher.js", () => ({
  useSavedWorkflowLauncher: () => ({
    launch: launchMock,
    pending: false,
    error: null,
    clearError: clearErrorMock,
  }),
}));
// The "Promote to global" orchestration is stubbed: createSession(firstInput) and navigation are covered
// by useSavedWorkflowPromote unit tests — here we only assert the group calls it with the project target +
// name / path / locale, and toasts on failure.
const promoteMock = vi.fn(async () => ({
  ok: true as const,
  sessionId: "s-p",
}));
vi.mock("@/settings/saved-workflows/useSavedWorkflowPromote.js", () => ({
  useSavedWorkflowPromote: () => ({ promote: promoteMock, pending: false }),
}));
vi.mock("@/settings/saved-workflows/SavedWorkflowCard.js", () => ({
  SavedWorkflowCard: ({
    entry,
    lastRun,
    onOpen,
    onRun,
    onRevise,
    onMove,
    onDelete,
  }: {
    entry: ZCodeSavedWorkflowEntry;
    lastRun: ZCodeSavedWorkflowRun | undefined;
    onOpen: (entry: ZCodeSavedWorkflowEntry) => void;
    onRun: (entry: ZCodeSavedWorkflowEntry) => void;
    onRevise: (entry: ZCodeSavedWorkflowEntry) => void;
    onMove?: (entry: ZCodeSavedWorkflowEntry) => void;
    onDelete: (entry: ZCodeSavedWorkflowEntry) => void;
  }) =>
    createElement(
      "div",
      {
        "data-testid": testId(TID_WORKFLOW_CARD, entry.name),
        "data-last-run": lastRun?.runId ?? "",
      },
      entry.name,
      createElement("button", { type: "button", onClick: () => onOpen(entry) }, "open"),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => onRevise(entry),
          "data-testid": `revise-${entry.name}`,
        },
        "revise",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": testId(TID_WORKFLOW_CARD_RUN, entry.name),
          onClick: () => onRun(entry),
        },
        "run",
      ),
      onMove
        ? createElement(
            "button",
            {
              type: "button",
              "data-testid": testId(TID_WORKFLOW_ACTION_MOVE, entry.name),
              onClick: () => onMove(entry),
            },
            "move",
          )
        : null,
      createElement(
        "button",
        {
          type: "button",
          "data-testid": testId(TID_WORKFLOW_ACTION_DELETE, entry.name),
          onClick: () => onDelete(entry),
        },
        "delete",
      ),
    ),
}));
vi.mock("@/settings/saved-workflows/SavedWorkflowDetailView.js", () => ({
  SavedWorkflowDetailView: ({
    name,
    projectLabel,
    onBack,
  }: {
    name: string;
    projectLabel: string;
    onBack: () => void;
  }) =>
    createElement(
      "div",
      {
        "data-testid": TID_WORKFLOW_DETAIL,
        "data-name": name,
        "data-project": projectLabel,
      },
      createElement("button", { type: "button", onClick: onBack }, "back"),
    ),
}));

const { SavedWorkflowProjectGroup } =
  await import("@/settings/saved-workflows/SavedWorkflowProjectGroup.js");

function entry(
  name: string,
  overrides: Partial<ZCodeSavedWorkflowEntry> = {},
): ZCodeSavedWorkflowEntry {
  return {
    name,
    description: `${name} description`,
    scope: "project",
    path: `/beta/.zcode/workflows/${name}.dwf.ts`,
    ...overrides,
  };
}

const BETA: AutomationWorkspaceOption = {
  workspacePath: "/beta",
  label: "Beta",
};

function mount(props: Partial<Parameters<typeof SavedWorkflowProjectGroup>[0]> = {}) {
  const onNavigateToLaunchedRun = vi.fn();
  const onCreateViaChat = vi.fn();
  const onOpenWorkflowRun = vi.fn();
  const onStateChange = vi.fn();
  const onOpenDetail = vi.fn();
  const onBack = vi.fn();
  const result = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SavedWorkflowProjectGroup, {
        project: BETA,
        isCurrent: false,
        refreshSeq: 0,
        mode: { kind: "list" },
        onStateChange,
        onOpenDetail,
        onBack,
        onNavigateToLaunchedRun,
        onCreateViaChat,
        onOpenWorkflowRun,
        ...props,
      }),
    ),
  );
  return {
    ...result,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onOpenWorkflowRun,
    onStateChange,
    onOpenDetail,
    onBack,
  };
}

describe("SavedWorkflowProjectGroup", () => {
  beforeEach(() => {
    resetSavedWorkflowStoreForTests();
    agentBeta.listResult.current = {
      workflows: [],
      invalid: [],
      dir: "/beta/.zcode/workflows",
    };
    agentBeta.runsResult.current = [];
    agentRepo.listResult.current = {
      workflows: [],
      invalid: [],
      dir: "/repo/.zcode/workflows",
    };
    agentRepo.runsResult.current = [];
    changeListener = null;
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => {
    cleanup();
  });

  it("fetches with the ITS project agent, renders cards with last-run grouping; no-args Run fires directly with the project target", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("release-check"), entry("nightly")],
      invalid: [],
    };
    agentBeta.runsResult.current = [
      {
        runId: "r-old",
        name: "release-check",
        status: "failed",
        createdAt: 1,
        updatedAt: 2,
        spentTokens: 0,
      },
      {
        runId: "r-new",
        name: "release-check",
        status: "completed",
        createdAt: 3,
        updatedAt: 9,
        spentTokens: 0,
      },
    ];
    mount();
    await screen.findByTestId(testId(TID_WORKFLOWS_LIST, "/beta"));
    // Uses the /beta agent, not /repo
    expect(agentBeta.listSavedWorkflows).toHaveBeenCalledWith({
      workspacePath: "/beta",
    });
    expect(agentRepo.listSavedWorkflows).not.toHaveBeenCalled();
    expect(agentBeta.listSavedWorkflowRuns).toHaveBeenCalledWith({
      workspacePath: "/beta",
      limit: 50,
    });
    expect(
      screen.getByTestId(testId(TID_WORKFLOW_CARD, "release-check")).getAttribute("data-last-run"),
    ).toBe("r-new");
    expect(
      screen.getByTestId(testId(TID_WORKFLOW_CARD, "nightly")).getAttribute("data-last-run"),
    ).toBe("");

    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_CARD_RUN, "nightly")));
    await waitFor(() => expect(launchMock).toHaveBeenCalledTimes(1));
    // No-args project scope: no dialog, fires directly; carries the project target + project scope + empty args.
    expect(launchMock.mock.calls[0]?.[0]).toEqual({ workspacePath: "/beta" });
    expect(launchMock.mock.calls[0]?.[1]).toEqual({
      name: "nightly",
      scope: "project",
      args: {},
    });
  });

  it("reports load state to the page: loaded with workflows → { loaded:true, empty:false }", async () => {
    agentBeta.listResult.current = { workflows: [entry("a")], invalid: [] };
    const { onStateChange } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "a"));
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith("/beta", {
        loaded: true,
        empty: false,
        count: 1,
      }),
    );
  });

  it("empty group: renders null once loaded with no workflows and no invalid files, but still reports { loaded:true, empty:true }", async () => {
    const { onStateChange, container } = mount();
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith("/beta", {
        loaded: true,
        empty: true,
        count: 0,
      }),
    );
    expect(
      container.querySelector(`[data-testid="${testId(TID_WORKFLOW_PROJECT_GROUP, "/beta")}"]`),
    ).toBeNull();
  });

  it("the invalid-files strip lists path and reason and the group still appears", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("ok")],
      invalid: [{ path: "/beta/.zcode/workflows/bad.dwf.ts", reason: "invalid_yaml" }],
    };
    const { container } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "ok"));
    const strip = container.querySelector('[data-workflows-invalid="true"]');
    expect(strip?.textContent).toContain(expectedCopy("workflows.hub.invalid.one", { count: 1 }));
    expect(strip?.textContent).toContain("/beta/.zcode/workflows/bad.dwf.ts");
  });

  it("a refreshSeq change bypasses the cache and refetches; directory changes refresh after debounce; unmount tears the watcher down", async () => {
    agentBeta.listResult.current = { workflows: [entry("a")], invalid: [] };
    const { rerender } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "a"));
    expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(1);

    rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SavedWorkflowProjectGroup, {
          project: BETA,
          isCurrent: false,
          refreshSeq: 1,
          mode: { kind: "list" },
          onStateChange: vi.fn(),
          onOpenDetail: vi.fn(),
          onBack: vi.fn(),
          onNavigateToLaunchedRun: vi.fn(),
          onCreateViaChat: vi.fn(),
          onOpenWorkflowRun: vi.fn(),
        }),
      ),
    );
    await waitFor(() => expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(2));

    expect(fileWatcherService.watch).toHaveBeenCalledWith({
      path: "/beta/.zcode/workflows",
    });
    await waitFor(() => expect(changeListener).not.toBeNull());
    changeListener?.();
    await waitFor(() => expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(3), {
      timeout: 2000,
    });
    cleanup();
    expect(watcherDispose).toHaveBeenCalled();
    expect(fileWatcherService.unwatch).toHaveBeenCalledWith({ id: "watch-1" });
  });

  it("delete: after confirmation calls delete with the project target and refreshes; cancel does nothing", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_DELETE, "x")));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(agentBeta.deleteSavedWorkflow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_DELETE, "x")));
    await waitFor(() =>
      expect(agentBeta.deleteSavedWorkflow).toHaveBeenCalledWith({
        workspacePath: "/beta",
        name: "x",
      }),
    );
    expect(agentRepo.deleteSavedWorkflow).not.toHaveBeenCalled();
    await waitFor(() => expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(2));
    expect(toastMock).toHaveBeenCalledWith(expectedCopy("workflows.hub.deleted", { name: "x" }));
  });

  it("revise: prefills the draft with the project target", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onCreateViaChat } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId("revise-x"));
    expect(onCreateViaChat).toHaveBeenCalledTimes(1);
    expect(onCreateViaChat.mock.calls[0]?.[0]).toContain('Please revise the saved workflow "x"');
    expect(onCreateViaChat.mock.calls[0]?.[1]).toEqual({
      workspacePath: "/beta",
    });
  });

  it("the group-header create-via-chat entry has the workspaceKey test id and the project target", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onCreateViaChat } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, "/beta")));
    expect(onCreateViaChat.mock.calls[0]?.[1]).toEqual({
      workspacePath: "/beta",
    });
    expect(onCreateViaChat.mock.calls[0]?.[0]).toContain("Help me design a workflow");
  });

  // "Promote to global" (docs/dynamic-workflow/launch.md "Promote to global"): does not move files; opens
  // a new session in this project and sends the summarization prompt.
  it("promote to global: calls promote with the project target and name / path / locale; no move call, no toast", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("x")],
      invalid: [],
      dir: "/beta/.zcode/workflows",
    };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "x")));
    await waitFor(() => expect(promoteMock).toHaveBeenCalledTimes(1));
    expect(promoteMock.mock.calls[0]?.[0]).toEqual({ workspacePath: "/beta" });
    expect(promoteMock.mock.calls[0]?.[1]).toEqual({
      name: "x",
      path: "/beta/.zcode/workflows/x.dwf.ts",
      locale: "en-US",
    });
    expect(toastMock).not.toHaveBeenCalled();
    // The list is not refetched: the source file is untouched; the global copy appears via the global group's directory watcher once the model saves it.
    expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(1);
  });

  it("promote to global: createSession rejected → toast promote failure (with the server reason)", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("x")],
      invalid: [],
      dir: "/beta/.zcode/workflows",
    };
    promoteMock.mockResolvedValueOnce({
      ok: false,
      code: "fault.command.workspaceReadOnly",
      message: "workspace is read-only",
    } as never);
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "x")));
    await waitFor(() => expect(promoteMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expectedCopy("workflows.hub.promote.failed", {
          reason: "workspace is read-only",
        }),
      ),
    );
  });

  it("remote projects do not offer promote-to-global (invariant 4: remote home never enters the hub)", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("x")],
      invalid: [],
      dir: "/beta/.zcode/workflows",
    };
    mount({ project: { ...BETA, remoteSessionId: "remote-1" } });
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    expect(screen.queryByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "x"))).toBeNull();
  });

  it("clicking a card into detail is the page's decision: onOpenDetail carries the workflow name", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onOpenDetail } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByText("open"));
    expect(onOpenDetail).toHaveBeenCalledWith("x");
  });

  it("detail mode renders SavedWorkflowDetailView and passes the project label to the detail page", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onBack } = mount({ mode: { kind: "detail", name: "x" } });
    const detail = await screen.findByTestId(TID_WORKFLOW_DETAIL);
    expect(detail.getAttribute("data-name")).toBe("x");
    expect(detail.getAttribute("data-project")).toBe("Beta");
    fireEvent.click(screen.getByText("back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
