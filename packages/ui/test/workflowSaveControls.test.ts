// @vitest-environment jsdom

// Real DOM of the completion card "Save / Run again" (docs/dynamic-workflow/transcript-and-notifications.md,
// "Saving the run, and running it again"): the popover's two paths and three fields, overwrite and refusal,
// the old-agent fallback, Cmd+Enter; header-slot gating, whether the chip is a button or text, and whether
// "Run again" launches directly or opens the args dialog. Pure rules live in workflowRunSave.test.ts.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, createRef, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
  type ZCodeSavedWorkflowEntry,
  type ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { expectedCopy } from "./helpers/uiCopy.js";

vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: toastSpy }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      tabs: [
        {
          id: "t1",
          kind: "workspace",
          workspacePath: "/repo",
          label: "repo",
        },
      ],
    }),
}));
const controller = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/project-workflow/useWorkflowRunSave.js", () => ({
  useWorkflowRunSave: () => controller.current,
}));

// eslint-disable-next-line import/first -- the component under test must be imported after the mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import {
  WorkflowSavePopover,
  type WorkflowSavePopoverHost,
} from "@/components/workflow-timeline/WorkflowSavePopover.js";
// eslint-disable-next-line import/first
import {
  useWorkflowRunSaveSlots,
  type WorkflowRunSaveSlotsHost,
} from "@/project-workflow/WorkflowRunSaveControls.js";
// eslint-disable-next-line import/first
import { WorkflowCompletionCard } from "@/components/workflow-timeline/WorkflowCompletionCard.js";
// eslint-disable-next-line import/first
import { SavedWorkflowHubProvider } from "@/v4/savedWorkflowHubContext.js";
// eslint-disable-next-line import/first
import { WorkflowRunSaveSlotsBoundary } from "@/project-workflow/WorkflowRunSaveControls.js";
// eslint-disable-next-line import/first
import { ServiceProvider } from "@/hooks/useServices.js";
// eslint-disable-next-line import/first
import { WorkflowRunStatusHeader } from "@/app-shell/WorkflowRunSidePaneSections.js";

beforeAll(() => {
  // Radix Popper measures with ResizeObserver; jsdom lacks it.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
});

const ENTRY: ZCodeSavedWorkflowEntry = {
  name: "pr-review",
  description: "分层评审",
  scope: "project",
  path: "/repo/.zcode/workflows/pr-review.dwf.ts",
};

function withIntl(node: ReactNode, locale: "en-US" | "zh-CN" = "en-US") {
  return createElement(ZCodeIntlProvider, { initialLocale: locale }, node);
}

// ── popover ──

function popoverHost(overrides: Partial<WorkflowSavePopoverHost> = {}): WorkflowSavePopoverHost {
  return {
    runName: "pr-review",
    directSaveUnsupported: false,
    scopeLocked: false,
    saving: false,
    save: vi.fn(
      async (): Promise<ZCodeWorkflowsSaveResult> => ({
        ok: true,
        name: "pr-review",
        scope: "project",
        path: "/p",
        overwritten: false,
      }),
    ),
    checkNameTaken: vi.fn(async () => false),
    sendLead: vi.fn(async () => undefined),
    onSaved: vi.fn(),
    ...overrides,
  };
}

function renderPopover(host: WorkflowSavePopoverHost, locale: "en-US" | "zh-CN" = "en-US") {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const anchorRef = createRef<HTMLElement | null>() as { current: HTMLElement | null };
  anchorRef.current = anchor;
  const onOpenChange = vi.fn();
  render(
    withIntl(
      createElement(WorkflowSavePopover, { anchorRef, host, onOpenChange, open: true }),
      locale,
    ),
  );
  return { onOpenChange };
}

describe("WorkflowSavePopover", () => {
  it.each([
    {
      name: "zh-CN",
      lang: "zh-CN" as const,
      title: "保存工作流",
      lead: "让 ZCode 帮我提炼保存",
      leadHint: "ZCode 会帮你提炼出可复用的工作流，再交你确认。",
      or: "或按原样直接保存",
      submit: "直接保存",
    },
    {
      name: "en-US",
      lang: "en-US" as const,
      title: expectedCopy("chat.toolCall.workflow.saveRun.title"),
      lead: expectedCopy("chat.toolCall.workflow.saveRun.lead"),
      leadHint: expectedCopy("chat.toolCall.workflow.saveRun.lead.hint"),
      or: expectedCopy("chat.toolCall.workflow.saveRun.or"),
      submit: expectedCopy("chat.toolCall.workflow.saveRun.submit"),
    },
  ])(
    "$name: the full-width ZCode lead path first with the three fields below the divider; the name is prefilled from the run name and focused",
    ({ lang, title, lead, leadHint, or, submit }) => {
      cleanup();
      renderPopover(popoverHost(), lang);
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.getByTestId("workflow-save-lead").textContent).toBe(lead);
      expect(screen.getByText(leadHint)).toBeTruthy();
      expect(screen.getByText(or)).toBeTruthy();
      const name = screen.getByTestId<HTMLInputElement>("workflow-save-name");
      expect(name.value).toBe("pr-review");
      expect(document.activeElement).toBe(name);
      expect(screen.getByTestId("workflow-save-consequence").textContent).toContain(
        ".zcode/workflows/pr-review.dwf.ts",
      );
      expect(screen.getByTestId("workflow-save-submit").textContent).toBe(submit);
    },
  );

  it("ZCode lead path hands over the filled fields, then closes", async () => {
    const host = popoverHost();
    const { onOpenChange } = renderPopover(host);
    fireEvent.change(screen.getByTestId("workflow-save-description"), {
      target: { value: "三层评审" },
    });
    fireEvent.click(screen.getByTestId("workflow-save-lead"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(host.sendLead).toHaveBeenCalledWith({
      name: "pr-review",
      scope: "project",
      description: "三层评审",
    });
  });

  it("Cmd+Enter triggers the ZCode lead path from any field", async () => {
    const host = popoverHost();
    renderPopover(host);
    fireEvent.keyDown(screen.getByTestId("workflow-save-name"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(host.sendLead).toHaveBeenCalledTimes(1));
  });

  it("invalid name: the helper turns into an error and direct save is disabled; an empty name disables it too", () => {
    renderPopover(popoverHost({ runName: "PR 分层评审" }));
    const submit = screen.getByTestId<HTMLButtonElement>("workflow-save-submit");
    expect(screen.getByTestId<HTMLInputElement>("workflow-save-name").value).toBe("");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("workflow-save-name"), { target: { value: "a/b" } });
    expect(screen.getByTestId("workflow-save-name-helper").textContent).toBe(
      "Only letters, digits and - _ .",
    );
    expect(submit.disabled).toBe(true);
  });

  it("direct save writes the fields, calls onSaved, and closes", async () => {
    const host = popoverHost();
    const { onOpenChange } = renderPopover(host);
    fireEvent.click(screen.getByTestId("workflow-save-submit"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(host.save).toHaveBeenCalledWith({
      name: "pr-review",
      scope: "project",
      meta: { description: "pr-review" },
    });
    expect(host.onSaved).toHaveBeenCalledWith({ name: "pr-review", scope: "project" });
  });

  it("name already taken: once the probe returns, switch to the overwrite warning and overwrite-and-save label; the next click sends overwrite", async () => {
    const host = popoverHost({ checkNameTaken: vi.fn(async (_n, scope) => scope === "project") });
    renderPopover(host);
    await waitFor(() => expect(screen.getByTestId("workflow-save-overwrite")).toBeTruthy());
    expect(screen.getByTestId("workflow-save-submit").textContent).toBe("Overwrite and save as is");
    fireEvent.click(screen.getByTestId("workflow-save-submit"));
    await waitFor(() =>
      expect(host.save).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true })),
    );
  });

  it("the other scope also holds this name: the consequence sentence adds the shadowing clause (direction follows the target scope, punctuation follows the language)", async () => {
    renderPopover(popoverHost({ checkNameTaken: vi.fn(async (_n, scope) => scope === "global") }));
    await waitFor(() =>
      expect(screen.getByTestId("workflow-save-consequence").textContent).toContain(
        "A global workflow with this name will be hidden by this one.",
      ),
    );
    expect(screen.queryByTestId("workflow-save-overwrite")).toBeNull();
  });

  it("agent refuses (other than target_exists): show its reason and diagnostics, keep the popover open — nothing was written", async () => {
    const host = popoverHost({
      save: vi.fn(
        async (): Promise<ZCodeWorkflowsSaveResult> => ({
          ok: false,
          reason: "compile_failed",
          detail: "L1:C1 bad",
        }),
      ),
    });
    const { onOpenChange } = renderPopover(host);
    fireEvent.click(screen.getByTestId("workflow-save-submit"));
    await waitFor(() => expect(screen.getByTestId("workflow-save-failure")).toBeTruthy());
    expect(screen.getByTestId("workflow-save-failure").textContent).toContain(
      "The script did not pass typecheck; nothing was written.",
    );
    expect(screen.getByTestId("workflow-save-failure").textContent).toContain("L1:C1 bad");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("an older agent without workflows/save keeps only the ZCode path, and the hint says so", () => {
    renderPopover(popoverHost({ directSaveUnsupported: true }));
    expect(screen.getByTestId("workflow-save-lead")).toBeTruthy();
    expect(screen.queryByTestId("workflow-save-name")).toBeNull();
    expect(screen.queryByText("or save it as is")).toBeNull();
    expect(screen.getByText(/This agent cannot save directly\./u)).toBeTruthy();
  });

  it("host without a send path: no ZCode button and no divider, only the fields", () => {
    const host = popoverHost();
    delete host.sendLead;
    renderPopover(host);
    expect(screen.queryByTestId("workflow-save-lead")).toBeNull();
    expect(screen.queryByText("or save it as is")).toBeNull();
    expect(screen.getByTestId("workflow-save-name")).toBeTruthy();
  });
});

// ── header slots ──

interface ControllerOverrides {
  entry?: ZCodeSavedWorkflowEntry;
  runArgs?: Record<string, unknown>;
  launch?: ReturnType<typeof vi.fn>;
}

function setController(overrides: ControllerOverrides = {}) {
  controller.current = {
    saved:
      overrides.entry === undefined
        ? { status: "ready" }
        : { status: "ready", entry: overrides.entry },
    entry: overrides.entry,
    runArgs: overrides.runArgs,
    directSaveUnsupported: false,
    scopeLocked: false,
    saving: false,
    save: vi.fn(),
    checkNameTaken: vi.fn(async () => false),
    launching: false,
    launchError: null,
    clearLaunchError: vi.fn(),
    launch: overrides.launch ?? vi.fn(async () => ({ ok: true })),
  };
}

function CardWithSlots({ host }: { host: WorkflowRunSaveSlotsHost }) {
  const { leading, trailing } = useWorkflowRunSaveSlots(host);
  return createElement(WorkflowCompletionCard, {
    artifacts: [],
    figures: {},
    name: "PR 分层评审",
    testIdKey: "t",
    ...(leading === null ? {} : { headerLeading: leading }),
    ...(trailing === null ? {} : { headerTrailing: trailing }),
  });
}

function renderSlots(
  host: Partial<WorkflowRunSaveSlotsHost> = {},
  options: { hub?: { openWorkflow: ReturnType<typeof vi.fn> } } = {},
) {
  const card = createElement(CardWithSlots, {
    host: {
      workspacePath: "/repo",
      runId: "run-1",
      runName: "PR 分层评审",
      canSave: true,
      sendLead: vi.fn(async () => undefined),
      ...host,
    },
  });
  return render(
    withIntl(
      options.hub === undefined
        ? card
        : createElement(SavedWorkflowHubProvider, {
            openWorkflow: options.hub.openWorkflow,
            navigateToRun: vi.fn(),
            children: card,
          }),
    ),
  );
}

describe("header slots", () => {
  beforeEach(() => setController());

  it("not saved yet: only the save verb, no chip; clicking opens that popover", () => {
    renderSlots();
    expect(screen.queryByTestId("workflow-saved-chip")).toBeNull();
    const save = screen.getByTestId("workflow-save-open");
    expect(save.getAttribute("aria-label")).toBe("Save");
    fireEvent.click(save);
    expect(screen.getByTestId("workflow-save-popover")).toBeTruthy();
  });

  it("saved: the chip precedes the status and the verb becomes run-again; without the hub the chip is plain text", () => {
    setController({ entry: ENTRY });
    renderSlots();
    const chip = screen.getByTestId("workflow-saved-chip");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.textContent).toBe("Saved");
    expect(screen.getByTestId("workflow-save-run-again").getAttribute("aria-label")).toBe(
      "Run again",
    );
    expect(screen.queryByTestId("workflow-save-open")).toBeNull();
  });

  it("with the hub: the chip is a button that opens that workflow", () => {
    setController({ entry: ENTRY });
    const openWorkflow = vi.fn();
    renderSlots({}, { hub: { openWorkflow } });
    const chip = screen.getByTestId("workflow-saved-chip");
    expect(chip.tagName).toBe("BUTTON");
    fireEvent.click(chip);
    expect(openWorkflow).toHaveBeenCalledWith({
      name: "pr-review",
      scope: "project",
      workspacePath: "/repo",
    });
  });

  it("gate closed (read-only / gray release): the fact chip stays, the verb is entirely absent", () => {
    setController({ entry: ENTRY });
    renderSlots({ canSave: false });
    expect(screen.getByTestId("workflow-saved-chip")).toBeTruthy();
    expect(screen.queryByTestId("workflow-save-run-again")).toBeNull();
    expect(screen.queryByTestId("workflow-save-open")).toBeNull();
  });

  it("run again: a project entry without args launches directly without a dialog", async () => {
    const launch = vi.fn(async () => ({ ok: true }));
    setController({ entry: ENTRY, launch });
    renderSlots();
    fireEvent.click(screen.getByTestId("workflow-save-run-again"));
    await waitFor(() => expect(launch).toHaveBeenCalledWith(ENTRY, {}));
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeNull();
  });

  it("run-again direct launch fails: the toast reports the launcher reason (out-of-dialog path)", async () => {
    toastSpy.mockClear();
    const launch = vi.fn(async () => ({
      ok: false,
      error: { reason: "compile_failed", code: "x" },
    }));
    setController({ entry: ENTRY, launch });
    renderSlots();
    fireEvent.click(screen.getByTestId("workflow-save-run-again"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith("The workflow script did not compile");
  });

  it("run again: with args it opens the dialog prefilled with what this run used", async () => {
    const entry: ZCodeSavedWorkflowEntry = {
      ...ENTRY,
      args: { base: { type: "string", default: "main" } },
    };
    const launch = vi.fn(async () => ({ ok: true }));
    setController({ entry, runArgs: { base: "release/3.14" }, launch });
    renderSlots();
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-save-run-again"));
    });
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeTruthy();
    expect(
      screen.getByTestId<HTMLInputElement>(testId(TID_WORKFLOW_LAUNCH_ARG, "base")).value,
    ).toBe("release/3.14");
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("WorkflowRunSaveSlotsBoundary", () => {
  beforeEach(() => setController({ entry: ENTRY }));
  const host: WorkflowRunSaveSlotsHost = { workspacePath: "/repo", runId: "run-1", canSave: true };

  it("no service context (static render, replay, share read-only): no controller mounts and the card stays as it was", () => {
    const seen: unknown[] = [];
    render(
      withIntl(
        createElement(WorkflowRunSaveSlotsBoundary, {
          host,
          children: (slots) => {
            seen.push(slots);
            return null;
          },
        }),
      ),
    );
    expect(seen).toEqual([null]);
  });

  it("with a service context: hand out both slots", () => {
    let seen: unknown = undefined;
    render(
      withIntl(
        createElement(ServiceProvider, {
          services: {} as never,
          children: createElement(WorkflowRunSaveSlotsBoundary, {
            host,
            children: (slots) => {
              seen = slots;
              return null;
            },
          }),
        }),
      ),
    );
    expect(seen).toMatchObject({ leading: expect.anything(), trailing: expect.anything() });
  });
});

describe("run side pane status header", () => {
  function renderHeader(saveSlots: { leading: ReactNode; trailing: ReactNode } | null) {
    return render(
      withIntl(
        createElement(WorkflowRunStatusHeader, {
          cancellable: false,
          onCancel: () => {},
          onResume: () => {},
          resumable: false,
          run: {
            runId: "r",
            status: "completed",
            usage: { spentTokens: 0, nodesUsed: 0 },
            actors: [],
            nodes: [],
            lastEventSequence: 0,
          },
          saveSlots,
          summaryParts: undefined,
          title: "pr-review",
          usage: undefined,
        }),
      ),
    );
  }

  it("the verb precedes Stop and the chip follows the second-row status word", () => {
    renderHeader({
      leading: createElement("span", { "data-testid": "chip" }, "Saved"),
      trailing: createElement("button", { "data-testid": "verb", type: "button" }, "Run again"),
    });
    const verb = screen.getByTestId("verb");
    const stop = screen.getByTestId("workflow-run-cancel");
    expect(verb.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = screen.getByTestId("workflow-run-status-row");
    expect(row.contains(screen.getByTestId("chip"))).toBe(true);
    expect(
      screen
        .getByTestId("workflow-run-status")
        .compareDocumentPosition(screen.getByTestId("chip")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
