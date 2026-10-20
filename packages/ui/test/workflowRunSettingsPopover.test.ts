// @vitest-environment jsdom

// The "Configure" popover (docs/dynamic-workflow/presentation.md "The settings popover"), the Configure button on the
// run card ("The run card"), and the settings row in the transcript ("The settings turn"): pinned on the real DOM are
// fields, consequence sentences, the payload Apply sends, the rejected line, plus the card button's placement and
// gating. Pure rules are exhaustively covered in workflowRunSettings.test.ts.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, createRef, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER } from "@zcode/shared/test-ids";
import type { CommandAck, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));

/** Model catalog: one provider, two models, one of which has thinking levels. */
const VIEW = {
  revision: 1,
  providers: [
    {
      providerId: "zhipu",
      providerName: "Zhipu",
      config: { api: { type: "openai-chat-completions" } },
      models: [
        {
          modelId: "glm-5.3",
          config: { optionSpecs: { reasoningLevel: { values: [], map: "{}" } } },
        },
        {
          modelId: "glm-5.3-flash",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } } },
        },
      ],
    },
  ],
};
const modelRead = vi.hoisted(() => ({
  state: { status: "ready", view: null as unknown } as { status: string; view?: unknown },
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({ state: modelRead.state, reload: vi.fn() }),
}));

// eslint-disable-next-line import/first -- the component under test must be imported after the mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import {
  WorkflowRunSettingsPopover,
  type WorkflowRunSettingsHost,
} from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
// eslint-disable-next-line import/first
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
// eslint-disable-next-line import/first
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
// eslint-disable-next-line import/first
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { expectedCopy } from "./helpers/uiCopy.js";

beforeAll(() => {
  // Radix Popper measures with ResizeObserver; jsdom does not provide it.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  modelRead.state = { status: "ready", view: VIEW };
});

afterEach(() => {
  cleanup();
});

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "run-a",
    toolCallId: "tool-a",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    concurrencyCeiling: 13,
    ...overrides,
  };
}

function hostWith(apply: (change: unknown) => Promise<CommandAck>): WorkflowRunSettingsHost {
  return {
    workspacePath: "/w",
    sessionModel: { providerId: "zhipu", modelId: "glm-5.3" },
    apply: apply as WorkflowRunSettingsHost["apply"],
  };
}

function renderPopover(
  run: WorkflowRunState,
  options: {
    locale?: "en-US" | "zh-CN";
    apply?: (change: unknown) => Promise<CommandAck>;
    onAccepted?: (accepted: unknown) => void;
    onOpenChange?: (open: boolean) => void;
  } = {},
) {
  const anchor = document.createElement("button");
  document.body.appendChild(anchor);
  const anchorRef = createRef<HTMLElement | null>() as { current: HTMLElement | null };
  anchorRef.current = anchor;
  const apply = options.apply ?? vi.fn(async () => ({ status: "accepted" }) as CommandAck);
  return {
    apply,
    view: render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: options.locale ?? "en-US" },
        createElement(WorkflowRunSettingsPopover, {
          anchorRef,
          host: hostWith(apply),
          onOpenChange: options.onOpenChange ?? vi.fn(),
          open: true,
          run,
          ...(options.onAccepted === undefined ? {} : { onAccepted: options.onAccepted }),
        }),
      ),
    ),
  };
}

describe("WorkflowRunSettingsPopover fields", () => {
  it("starts from the run's own settings: model name, default-concurrency hint; with nothing changed there is no consequence sentence and Apply is disabled", () => {
    renderPopover(
      runState({
        subagentModel: "zhipu/glm-5.3",
        concurrency: { cap: 13, ceiling: 13, limit: 4 },
      }),
    );
    expect(
      screen.getByText(expectedCopy("chat.toolCall.workflow.run.settings.title")),
    ).toBeTruthy();
    expect(screen.getByTestId("workflow-run-settings-model-trigger").textContent).toContain(
      "glm-5.3",
    );
    expect(screen.getByTestId<HTMLInputElement>("workflow-run-settings-bound-value").value).toBe(
      "4",
    );
    expect(screen.getByTestId("workflow-run-settings-bound").textContent).toContain(
      expectedCopy("chat.toolCall.workflow.run.settings.limit.default", { n: 13 }),
    );
    // The consequence line keeps its height but stays empty: the footer must not jump on the first change.
    expect(screen.getByTestId("workflow-run-settings-consequence").textContent).toBe("");
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      true,
    );
    // glm-5.3 has no thinking levels: no thinking-level control is drawn.
    expect(screen.queryByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeNull();
  });

  it('the consequence sentence follows the change: a running run that only changes concurrency says "applies in place"; reverting to the original value empties it again', () => {
    renderPopover(
      runState({
        subagentModel: "zhipu/glm-5.3",
        concurrency: { cap: 13, ceiling: 13, limit: 4 },
      }),
    );
    const consequence = () => screen.getByTestId("workflow-run-settings-consequence").textContent;
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    expect(consequence()).toBe(
      expectedCopy("chat.toolCall.workflow.run.settings.consequence.concurrencyLive"),
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    expect(consequence()).toBe("");
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      true,
    );
  });

  it.each([
    {
      lang: "zh-CN",
      title: "配置工作流",
      badge: "会话模型",
      defaultHint: "= 默认",
      consequence: "将以新设置另起一次运行接着跑，已完成的步骤会保留。",
    },
  ])(
    'running on the session model with the limit at the default ($lang): session-model badge on the trigger, "= default" hint, the plus button still works',
    ({ lang, title, badge, defaultHint, consequence }) => {
      renderPopover(runState({ status: "stopped", stopReason: "user", resumable: true }), {
        locale: lang,
      });
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.getByTestId("workflow-run-settings-model-badge").textContent).toBe(badge);
      expect(screen.getByTestId("workflow-run-settings-bound").textContent).toContain(defaultHint);
      // The default is a starting point, not a ceiling: you can still go up from the default.
      expect(
        screen.getByTestId<HTMLButtonElement>("workflow-run-settings-bound-increase").disabled,
      ).toBe(false);
      expect(screen.getByTestId("workflow-run-settings-consequence").textContent).toBe("");
      // The consequence sentence appears only after a change: for a stopped run, any change resumes as a fresh run.
      fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
      expect(screen.getByTestId("workflow-run-settings-consequence").textContent).toBe(consequence);
    },
  );

  it("a model with thinking levels: the thinking-level control appears next to the trigger", () => {
    renderPopover(runState({ subagentModel: "zhipu/glm-5.3-flash$low" }));
    expect(screen.getByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeTruthy();
  });

  it('the run\'s model is no longer in the catalog: "unavailable" badge, and Apply stays disabled after other changes (the agent would only answer model_unavailable)', () => {
    renderPopover(runState({ subagentModel: "gone/model-x" }));
    expect(screen.getByTestId("workflow-run-settings-model-badge").textContent).toBe(
      expectedCopy("chat.toolCall.workflow.run.settings.model.unavailable"),
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      true,
    );
  });

  it("the agent has no model catalog: the model cell becomes one sentence and the limit stays adjustable", () => {
    modelRead.state = { status: "ready", view: { revision: 1, providers: [] } };
    renderPopover(runState());
    expect(screen.getByTestId("workflow-run-settings-model").textContent).toContain(
      expectedCopy("chat.toolCall.workflow.run.settings.model.noCatalog"),
    );
    expect(screen.getByTestId("workflow-run-settings-bound-decrease")).toBeTruthy();
  });

  it("unknown default (old CLI): no default hint and the number is directly typable", () => {
    renderPopover(runState({ concurrencyCeiling: undefined, concurrency: undefined }));
    const input = screen.getByTestId<HTMLInputElement>("workflow-run-settings-bound-value");
    expect(input.value).toBe("");
    expect(screen.getByTestId("workflow-run-settings-bound").textContent).not.toContain("default");
    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("5");
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      false,
    );
  });
});

describe("WorkflowRunSettingsPopover Apply", () => {
  it("sends only the changed field; closes on acceptance and hands over the new run's two keys", async () => {
    const onAccepted = vi.fn();
    const onOpenChange = vi.fn();
    const { apply } = renderPopover(
      runState({ subagentModel: "zhipu/glm-5.3", concurrency: { cap: 13, ceiling: 13, limit: 4 } }),
      {
        apply: vi.fn(
          async () =>
            ({
              status: "accepted",
              commandId: "c",
              revisionAtDecision: 0,
              result: {
                type: "amendWorkflowRunSettings",
                runId: "run-b",
                toolCallId: "settings-1",
                supersededRunId: "run-a",
              },
            }) as CommandAck,
        ),
        onAccepted,
        onOpenChange,
      },
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    expect(apply).toHaveBeenCalledWith({ maxConcurrency: 3 });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onAccepted).toHaveBeenCalledWith({ runId: "run-b", toolCallId: "settings-1" });
  });

  it("raising above the default sends that number, not null (the default is a starting point, not a ceiling)", async () => {
    const { apply } = renderPopover(runState(), {
      apply: vi.fn(
        async () =>
          ({
            status: "accepted",
            commandId: "c",
            revisionAtDecision: 0,
            result: { type: "amendWorkflowRunSettings", runId: "run-a", toolCallId: "settings-2" },
          }) as CommandAck,
      ),
    });
    expect(screen.getByTestId<HTMLInputElement>("workflow-run-settings-bound-value").value).toBe(
      "13",
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    expect(screen.getByTestId("workflow-run-settings-bound").textContent).toContain(
      expectedCopy("chat.toolCall.workflow.run.settings.limit.default", { n: 13 }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    });
    expect(apply).toHaveBeenCalledWith({ maxConcurrency: 15 });
  });

  it("on rejection: the popover stays open with a reason line + monospace diagnostics block, Apply becomes clickable again; changing one more field collapses the line", async () => {
    const onOpenChange = vi.fn();
    renderPopover(runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }), {
      apply: vi.fn(
        async () =>
          ({
            status: "rejected",
            commandId: "c",
            revisionAtDecision: 0,
            reasonCode: "fault.command.workflowRunSettingsRejected.compile_failed",
            message: "L3:C1 Property 'ask' does not exist",
          }) as CommandAck,
      ),
      onOpenChange,
    });
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    });
    const rejection = await screen.findByTestId("workflow-run-settings-rejection");
    expect(rejection.textContent).toContain("no longer compiles");
    expect(rejection.querySelector("pre")?.textContent).toBe("L3:C1 Property 'ask' does not exist");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLButtonElement>("workflow-run-settings-apply").disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
    expect(screen.queryByTestId("workflow-run-settings-rejection")).toBeNull();
  });

  it.each([{ lang: "zh-CN", rejectionCopy: "当前 agent 不支持从这里调整工作流设置。" }])(
    "the $lang rejection wording: capability missing",
    async ({ lang, rejectionCopy }) => {
      renderPopover(runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }), {
        locale: lang,
        apply: vi.fn(
          async () =>
            ({
              status: "rejected",
              commandId: "c",
              revisionAtDecision: 0,
              reasonCode: "fault.command.capabilityUnsupported",
            }) as CommandAck,
        ),
      });
      fireEvent.click(screen.getByTestId("workflow-run-settings-bound-increase"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
      });
      expect((await screen.findByTestId("workflow-run-settings-rejection")).textContent).toBe(
        rejectionCopy,
      );
    },
  );
});

function summaryOf(run: WorkflowRunState): WorkflowRunCardSummary {
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    nodesSettled: 0,
    nodesTotal: 0,
    run,
    ...(run.resumable === true ? { resumable: true as const } : {}),
  };
}

describe("Configure on the run card", () => {
  function renderCard(run: WorkflowRunState, withHost: boolean) {
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunDigest, {
          graph: undefined,
          name: "implement-verify",
          runId: run.runId,
          summary: summaryOf(run),
          testIdKey: "t",
          onCancel: vi.fn(),
          onResume: vi.fn(),
          onOpenRun: vi.fn(),
          ...(withHost ? { settingsHost: hostWith(vi.fn()) } : {}),
        }),
      ),
    );
  }

  it("sits before Stop; clicking it opens the popover and aria-expanded flips", () => {
    const view = renderCard(runState(), true);
    const configure = view.getByTestId("workflow-digest-configure");
    const cancel = view.getByTestId("workflow-digest-cancel");
    expect(
      configure.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(configure.getAttribute("aria-label")).toBe(
      expectedCopy("chat.toolCall.workflow.run.settings.title"),
    );
    fireEvent.click(configure);
    expect(configure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("workflow-run-settings-popover")).toBeTruthy();
  });

  it("clicking blank space inside the popover keeps it open", () => {
    const view = renderCard(runState(), true);
    fireEvent.click(view.getByTestId("workflow-digest-configure"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-consequence"));
    expect(screen.getByTestId("workflow-run-settings-popover")).toBeTruthy();
  });

  it("no host (read-only, gray release off, run not configurable) means no button", () => {
    const view = renderCard(runState(), false);
    expect(view.queryByTestId("workflow-digest-configure")).toBeNull();
  });

  function renderDigests(
    run: WorkflowRunState,
    settings?: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const onAmendWorkflowRunSettings = vi.fn(async () => ({ status: "accepted" }) as CommandAck);
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationWorkflowDigests, {
          turnKey: "t",
          digests: [
            {
              key: "k",
              toolCallId: run.toolCallId ?? "tool-a",
              runId: run.runId,
              name: "implement-verify",
              graph: undefined,
              summary: summaryOf(run),
              ...(settings === undefined ? {} : { settings }),
              ...extra,
            } as never,
          ],
          context: {
            sessionId: "parent-a",
            workspacePath: "/w",
            onAmendWorkflowRunSettings,
          } as unknown as ConversationRowRenderContext,
        }),
      ),
    );
    return { view, onAmendWorkflowRunSettings };
  }

  it.each([
    ["running", runState(), true],
    ["errored", runState({ status: "errored" }), true],
    ["completed", runState({ status: "completed" }), false],
    [
      "superseded",
      runState({ status: "stopped", stopReason: "superseded", supersededBy: "run-b" }),
      false,
    ],
  ] as const)("the wiring layer gates by run status: %s", (_case, run, shown) => {
    const { view } = renderDigests(run);
    expect(view.queryByTestId("workflow-digest-configure") !== null).toBe(shown);
  });

  it("Apply goes through the host's onAmendWorkflowRunSettings with this card's runId", async () => {
    const { view, onAmendWorkflowRunSettings } = renderDigests(
      runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }),
    );
    fireEvent.click(view.getByTestId("workflow-digest-configure"));
    fireEvent.click(screen.getByTestId("workflow-run-settings-bound-decrease"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("workflow-run-settings-apply"));
    });
    expect(onAmendWorkflowRunSettings).toHaveBeenCalledWith("run-a", { maxConcurrency: 3 });
  });

  it('settings turn: a "Settings changed · …" row above the card, absent on plain cards', () => {
    const { view } = renderDigests(runState({ runId: "run-b", toolCallId: "settings-1" }), {
      amend: {
        predecessorRunId: "run-a",
        subagentModel: { to: "zhipu/glm-5.3-flash" },
        maxConcurrency: { from: 13, to: 4 },
        ceiling: 13,
      },
    });
    const row = view.getByTestId("workflow-settings-change-row");
    expect(row.textContent).toContain(expectedCopy("chat.toolCall.workflow.settingsChange.kind"));
    expect(row.textContent).toContain(
      expectedCopy("chat.toolCall.workflow.settingsChange.model", { model: "glm-5.3-flash" }),
    );
    expect(row.textContent).toContain(
      expectedCopy("chat.toolCall.workflow.settingsChange.limit", { n: 4 }),
    );
    cleanup();
    const plain = renderDigests(runState());
    expect(plain.view.queryByTestId("workflow-settings-change-row")).toBeNull();
  });

  // An in-place settings turn (docs/dynamic-workflow/presentation.md "The settings turn"): the row is everything;
  // the card of the run it names lives in the turn where it started — drawing another one here would read as a second run.
  it("an in-place settings turn: only the row, no card", () => {
    const { view } = renderDigests(
      runState({ concurrency: { cap: 13, ceiling: 13, limit: 4 } }),
      { amend: { maxConcurrency: { from: 13, to: 4 }, ceiling: 13 } },
      { rowOnly: true },
    );
    const row = view.getByTestId("workflow-settings-change-row");
    expect(row.textContent).toContain(expectedCopy("chat.toolCall.workflow.settingsChange.kind"));
    expect(row.textContent).toContain(
      expectedCopy("chat.toolCall.workflow.settingsChange.limit", { n: 4 }),
    );
    // Card body, Configure button, Stop button: none of them present.
    expect(view.queryByTestId("workflow-digest-configure")).toBeNull();
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.container.querySelector('[data-testid^="workflow-run-digest-"]')).toBeNull();
  });
});
