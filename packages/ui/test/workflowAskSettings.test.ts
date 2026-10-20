// @vitest-environment jsdom

// The two adjustable run settings in the confirmation window (docs/dynamic-workflow/launch.md
// "Adjusting the settings in the window"; look and keyboard in docs/dynamic-workflow/presentation.md
// "The confirmation window"): pure rules enumerated one by one, plus real-DOM pins for the two
// sentences, the changed line, option descriptions, the Allow-response content, the "unavailable"
// gate, and Shift+Tab.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ZCodePermissionRequest } from "@zcode/shared";
import { TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER } from "@zcode/shared/test-ids";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));

/** Model catalog: one provider, two models, one with reasoning levels (same fixture as the "config" popover tests). */
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

// The model menu selection goes through the real component with props captured: tests call its
// onValueChange directly instead of driving the Radix menu.
const capturedSelects = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/ModelConfigSelect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ModelConfigSelect.js")>();
  const react = await import("react");
  return {
    ...actual,
    ModelConfigSelect: (props: Record<string, unknown>) => {
      capturedSelects.push(props);
      return react.createElement(
        actual.ModelConfigSelect as unknown as (p: Record<string, unknown>) => ReactNode,
        props,
      );
    },
  };
});

const sendCommand = vi.hoisted(() => vi.fn());
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ sendCommand }),
}));

// eslint-disable-next-line import/first -- the components under test must be imported after the mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { PermissionDialog } from "@/PermissionDialog.js";
// eslint-disable-next-line import/first
import {
  isWorkflowSettingsCarrier,
  workflowAdjustedOptionDescriptionId,
} from "@/permissionWorkflowSettings.js";
// eslint-disable-next-line import/first
import {
  initialWorkflowAskSettingsDraft,
  workflowAskSettingsChangedLines,
  workflowAskSettingsContent,
} from "@/components/workflow-timeline/workflowAskSettings.js";
// eslint-disable-next-line import/first
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
// eslint-disable-next-line import/first
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";

const SCRIPT = 'const r = await agent("a").ask<string>("do");';
const ALLOW = { optionId: "allowOnce", kind: "allowOnce", name: "Allow" };
const SESSION = {
  optionId: "allowSession",
  kind: "allowAlways",
  name: "Always allow in this session",
};
const DENY = { optionId: "deny", kind: "deny", name: "Deny" };

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  modelRead.state = { status: "ready", view: VIEW };
  capturedSelects.length = 0;
  sendCommand.mockReset();
});

afterEach(() => {
  cleanup();
});

function workflowRequest(
  raw: Record<string, unknown>,
  overrides: Partial<ZCodePermissionRequest> = {},
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-1",
    description: "createWorkflow.runConfirmation",
    kind: "CreateWorkflow",
    title: "CreateWorkflow",
    options: [
      { ...ALLOW, response: { decision: "allow" } },
      { ...SESSION, response: { decision: "allow" } },
      { ...DENY, response: { decision: "deny" } },
    ],
    raw: { name: "Research", script: SCRIPT, ...raw },
    ...overrides,
  };
}

const ADJUSTABLE = { adjustable_settings: { subagent_model: true, concurrency_ceiling: 13 } };

function renderDialog(
  request: ZCodePermissionRequest,
  options: { locale?: "en-US" | "zh-CN"; responding?: boolean } = {},
) {
  const onRespond = vi.fn();
  const element = (next: ZCodePermissionRequest) =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: options.locale ?? "en-US" },
      createElement(PermissionDialog, {
        request: next,
        onRespond,
        workspacePath: "/w",
        workflowSessionModel: { providerId: "zhipu", modelId: "glm-5.3" },
        ...(options.responding === undefined ? {} : { responding: options.responding }),
      }),
    );
  const view = render(element(request));
  return { onRespond, rerender: (next: ZCodePermissionRequest) => view.rerender(element(next)) };
}

function modelLine(): HTMLElement {
  return screen.getByTestId("workflow-permission-settings-model");
}
function boundLine(): HTMLElement {
  return screen.getByTestId("workflow-permission-settings-bound");
}
function boundValue(): HTMLInputElement {
  return screen.getByTestId<HTMLInputElement>("workflow-permission-settings-bound-value");
}
function option(name: string): HTMLElement {
  return screen.getByRole("option", { name });
}
function pickModel(value: string) {
  const onValueChange = capturedSelects.at(-1)?.onValueChange as (value: string) => void;
  act(() => onValueChange(value));
}

describe("pure rules: starting point, response content, changed lines", () => {
  it("the starting point reads the input: absent model means the session model, absent ceiling the default concurrency, unknown default means empty", () => {
    expect(initialWorkflowAskSettingsDraft({}, 13)).toEqual({
      model: { kind: "session" },
      bound: 13,
    });
    expect(
      initialWorkflowAskSettingsDraft(
        { subagent_model: "zhipu/glm-5.3-flash$high", max_concurrency: 4 },
        13,
      ),
    ).toEqual({
      model: { kind: "model", providerId: "zhipu", modelId: "glm-5.3-flash", level: "high" },
      bound: 4,
    });
    expect(initialWorkflowAskSettingsDraft({}, undefined)).toEqual({
      model: { kind: "session" },
      bound: null,
    });
  });

  it("sends only changed fields; ceiling back to default sends null, back to the session model sends null, and a level-only change still counts as a model change", () => {
    const initial = initialWorkflowAskSettingsDraft(
      { subagent_model: "zhipu/glm-5.3-flash$low", max_concurrency: 4 },
      13,
    );
    expect(workflowAskSettingsContent(initial, initial, 13)).toBeUndefined();
    expect(workflowAskSettingsContent(initial, { ...initial, bound: 13 }, 13)).toEqual({
      max_concurrency: null,
    });
    // The default is the starting point, not a cap: numbers above it go out as-is.
    expect(workflowAskSettingsContent(initial, { ...initial, bound: 40 }, 13)).toEqual({
      max_concurrency: 40,
    });
    expect(
      workflowAskSettingsContent(initial, { ...initial, model: { kind: "session" } }, 13),
    ).toEqual({
      subagent_model: null,
    });
    const levelOnly = {
      ...initial,
      model: {
        kind: "model" as const,
        providerId: "zhipu",
        modelId: "glm-5.3-flash",
        level: "high",
      },
    };
    expect(workflowAskSettingsContent(initial, levelOnly, 13)).toEqual({
      subagent_model: "zhipu/glm-5.3-flash$high",
    });
    expect(workflowAskSettingsChangedLines(initial, levelOnly, 13)).toEqual({
      model: true,
      bound: false,
    });
  });

  it("only the two allow options carry settings; when settings changed, only they swap descriptions", () => {
    expect(isWorkflowSettingsCarrier({ ...ALLOW, response: { decision: "allow" } })).toBe(true);
    expect(isWorkflowSettingsCarrier({ ...SESSION, response: { decision: "allow" } })).toBe(true);
    expect(isWorkflowSettingsCarrier({ ...DENY, response: { decision: "deny" } })).toBe(false);
    expect(workflowAdjustedOptionDescriptionId("chat.permission.allowOnce.description")).toBe(
      "chat.permission.workflow.allowOnce.adjusted",
    );
    expect(
      workflowAdjustedOptionDescriptionId("chat.permission.workflow.allowForSession.description"),
    ).toBe("chat.permission.workflow.allowForSession.adjusted");
    expect(workflowAdjustedOptionDescriptionId("chat.permission.denyOnce.description")).toBe(
      "chat.permission.denyOnce.description",
    );
  });
});

describe("the two sentences in the confirmation window", () => {
  it("calls that never set anything still say what will happen: model on top (session-model badge), ceiling below (= default), no was-line", () => {
    renderDialog(workflowRequest(ADJUSTABLE));
    const block = screen.getByTestId("workflow-permission-settings");
    expect(block.textContent?.indexOf("Subagents run on")).toBeLessThan(
      block.textContent?.indexOf("At most") ?? -1,
    );
    expect(modelLine().textContent).toContain("glm-5.3");
    expect(modelLine().textContent).toContain("session model");
    expect(boundValue().value).toBe("13");
    expect(boundLine().textContent).toContain("subagents at once");
    expect(boundLine().textContent).toContain("= default");
    // The default is not a ceiling: you can still increase while sitting on it.
    expect(
      screen.getByTestId<HTMLButtonElement>("workflow-permission-settings-bound-increase").disabled,
    ).toBe(false);
    expect(screen.queryByTestId("workflow-permission-settings-model-was")).toBeNull();
    expect(screen.queryByTestId("workflow-permission-settings-bound-was")).toBeNull();
    // The old plain-text row no longer appears.
    expect(screen.queryByTestId("workflow-permission-max-concurrency")).toBeNull();
    expect(option("Allow").textContent).toContain("Allow only this time");
  });

  it("changing the ceiling: the line goes bold with “· was 13 ↺”, the first two options swap descriptions, Allow carries content; ↺ back removes it", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    expect(boundValue().value).toBe("11");
    expect(boundLine().getAttribute("data-changed")).toBe("true");
    expect(boundValue().className).toContain("font-medium");
    expect(boundLine().textContent).toContain("default 13");
    expect(screen.getByTestId("workflow-permission-settings-bound-was").textContent).toBe(
      "· was 13",
    );
    expect(option("Allow").textContent).toContain("Run once with the adjusted settings");
    expect(option("Always allow in this session").textContent).toContain(
      "later runs are not asked and carry their own",
    );

    fireEvent.click(option("Allow"));
    expect(onRespond).toHaveBeenLastCalledWith(
      "perm-1",
      expect.objectContaining({ optionId: "allowOnce" }),
      undefined,
      { max_concurrency: 11 },
    );

    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-reset"));
    expect(boundValue().value).toBe("13");
    expect(screen.queryByTestId("workflow-permission-settings-bound-was")).toBeNull();
    expect(option("Allow").textContent).toContain("Allow only this time");
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall).toEqual([
      "perm-1",
      expect.objectContaining({ optionId: "allowOnce" }),
      undefined,
    ]);
  });

  it("switching the model: content is the canonical string, the was-line names the starting point (session model); session no-confirm carries this run's settings too", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    pickModel(encodeCustomModelValue("zhipu", "glm-5.3-flash"));
    expect(modelLine().getAttribute("data-changed")).toBe("true");
    expect(screen.getByTestId("workflow-permission-settings-model-was").textContent).toBe(
      "· was Zhipu/glm-5.3 · session model",
    );

    fireEvent.click(option("Always allow in this session"));
    fireEvent.click(option("Always allow in this session"));
    const content = onRespond.mock.lastCall?.[3] as { subagent_model?: string };
    expect(onRespond.mock.lastCall?.[1]).toMatchObject({ optionId: "allowSession" });
    expect(content.subagent_model?.startsWith("zhipu/glm-5.3-flash")).toBe(true);
    expect(Object.keys(content)).toEqual(["subagent_model"]);
  });

  it("a model with reasoning levels shows a level chip next to the model chip; a model without levels has none", () => {
    renderDialog(workflowRequest(ADJUSTABLE));
    // The starting point is the session model glm-5.3 (no levels in the fixture).
    expect(screen.queryByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeNull();
    pickModel(encodeCustomModelValue("zhipu", "glm-5.3-flash"));
    expect(screen.getByTestId(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER)).toBeTruthy();
  });

  it("denial carries no settings: clicking Deny after changes is still a plain reject", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Deny"));
    fireEvent.click(option("Deny"));
    expect(onRespond.mock.lastCall).toEqual([
      "perm-1",
      expect.objectContaining({ optionId: "deny" }),
      undefined,
    ]);
  });

  it("input model no longer in the catalog: “unavailable” badge, Allow and Confirm wait for another pick, Deny as usual", async () => {
    const { onRespond } = renderDialog(
      workflowRequest({ ...ADJUSTABLE, subagent_model: "gone/model-x" }),
    );
    expect(screen.getByTestId("workflow-permission-settings-model-unavailable").textContent).toBe(
      "unavailable",
    );
    await waitFor(() => expect(option("Allow").getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(option("Allow"));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Confirm" }).disabled).toBe(true);

    pickModel(encodeCustomModelValue("zhipu", "glm-5.3"));
    await waitFor(() => expect(option("Allow").getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ subagent_model: "zhipu/glm-5.3" });
  });

  it("agent has no model catalog: the model line is one sentence and the ceiling stays adjustable", () => {
    const { onRespond } = renderDialog(
      workflowRequest({ adjustable_settings: { subagent_model: false, concurrency_ceiling: 8 } }),
    );
    expect(modelLine().textContent).toBe(
      "Subagents stay on the session model· this agent has no model catalog",
    );
    expect(screen.queryByTestId("workflow-permission-settings-model-trigger")).toBeNull();
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ max_concurrency: 7 });
  });

  it("model not selectable but the input carries one (inherited): say it as-is, not “stays on the session model”", () => {
    renderDialog(
      workflowRequest({
        adjustable_settings: { subagent_model: false, concurrency_ceiling: 8 },
        subagent_model: "zhipu/glm-5.3-flash",
      }),
    );
    // The fixture provider is not a builtin family: the name is "provider name/model id", the same joining rule as the menu.
    expect(modelLine().textContent).toBe("Subagents run on Zhipu/glm-5.3-flash");
  });

  it("ceiling unknown and the call set none: the stepper stays empty with a “no limit of its own” tail; typing a number makes it an adjustment", () => {
    const { onRespond } = renderDialog(
      workflowRequest({ adjustable_settings: { subagent_model: true } }),
    );
    expect(boundValue().value).toBe("");
    expect(screen.getByTestId("workflow-permission-settings-bound-tail").textContent).toBe(
      "· no limit of its own",
    );
    fireEvent.change(boundValue(), { target: { value: "5" } });
    expect(screen.queryByTestId("workflow-permission-settings-bound-tail")).toBeNull();
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ max_concurrency: 5 });
  });

  it("response in flight: controls and options disable together", () => {
    renderDialog(workflowRequest(ADJUSTABLE), { responding: true });
    expect(boundValue().disabled).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("workflow-permission-settings-bound-decrease").disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("workflow-permission-settings-model-trigger").disabled,
    ).toBe(true);
  });

  it.each([["zh-CN"]] as const)("zh-CN: the two sentences and the was-line", (locale) => {
    renderDialog(workflowRequest(ADJUSTABLE), { locale });
    expect(modelLine().textContent).toContain("子代理运行在");
    expect(boundLine().textContent).toContain("最多");
    expect(boundLine().textContent).toContain("个子代理同时运行");
    expect(boundLine().textContent).toContain("= 默认");
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    expect(boundLine().textContent).toContain("默认 13");
    expect(screen.getByTestId("workflow-permission-settings-bound-was").textContent).toBe(
      "· 原为 13",
    );
    expect(
      screen.getByTestId("workflow-permission-settings-bound-reset").getAttribute("title"),
    ).toBe("恢复原值");
    expect(option("允许").textContent).toContain("按调整后的设置运行一次");
  });

  it("request swap: settings return to the new input's starting point; the previous window's changes do not carry over", () => {
    const { onRespond, rerender } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    rerender(workflowRequest(ADJUSTABLE, { requestId: "perm-2" }));
    expect(boundValue().value).toBe("13");
    expect(option("Allow").textContent).toContain("Allow only this time");
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall).toEqual([
      "perm-2",
      expect.objectContaining({ optionId: "allowOnce" }),
      undefined,
    ]);
  });
});

// The script names models for some subagents (docs/dynamic-workflow/launch.md "The window"): the
// window does not list them one by one — that is the author's model choice — it only rewords the
// model sentence to "by default"; responses never carry fields changing them.
describe("script names models", () => {
  const BINDINGS = {
    model_bindings: { "GLM-5.3-Flash": "zhipu/glm-5.3-flash$low", judge: "zhipu/glm-5.3" },
  };

  it("no per-name listing; the model sentence says “by default”; only one model menu", () => {
    renderDialog(workflowRequest({ ...ADJUSTABLE, ...BINDINGS }));
    const text = screen.getByTestId("workflow-permission-settings").textContent ?? "";
    expect(modelLine().textContent).toContain("By default, subagents run on");
    expect(text).not.toContain("judge");
    expect(text).not.toContain("glm-5.3-flash");
    expect(screen.getAllByTestId("workflow-permission-settings-model-trigger")).toHaveLength(1);
  });

  it("after changes Allow carries only the two fields, never model_bindings", () => {
    const { onRespond } = renderDialog(workflowRequest({ ...ADJUSTABLE, ...BINDINGS }));
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Allow"));
    expect(onRespond.mock.lastCall?.[3]).toEqual({ max_concurrency: 12 });
  });

  it("a script that names no models still says “Subagents run on”", () => {
    renderDialog(workflowRequest({ ...ADJUSTABLE, model_bindings: {} }));
    expect(modelLine().textContent).toContain("Subagents run on");
    expect(modelLine().textContent).not.toContain("By default");
  });

  it("model not selectable: “by default, subagents stay on the session model”", () => {
    renderDialog(
      workflowRequest({
        adjustable_settings: { subagent_model: false, concurrency_ceiling: 8 },
        ...BINDINGS,
      }),
    );
    expect(modelLine().textContent).toBe(
      "By default, subagents stay on the session model· this agent has no model catalog",
    );
  });

  it.each([["zh-CN"]] as const)("zh-CN: “by default, subagents run on”", (locale) => {
    renderDialog(workflowRequest({ ...ADJUSTABLE, ...BINDINGS }), { locale });
    expect(modelLine().textContent).toContain("子代理默认运行在");
  });

  it("legacy agent (plain text): also lists no names; the model sentence says “by default”", () => {
    renderDialog(
      workflowRequest({ max_concurrency: 2, subagent_model: "zhipu/glm-5.3", ...BINDINGS }),
    );
    expect(screen.getByTestId("workflow-permission-subagent-model").textContent).toBe(
      "By default, subagents run on glm-5.3",
    );
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText).not.toContain("judge");
  });
});

describe("keyboard", () => {
  it("Shift+Tab on the first option leaves the list and lands on the settings block's last control; on the other options it still cycles the list", async () => {
    renderDialog(workflowRequest(ADJUSTABLE));
    const allow = option("Allow");
    allow.focus();
    fireEvent.keyDown(allow, { key: "Tab", shiftKey: true });
    // The default is not a ceiling: the increase button stays pressable on it, so the last focusable control is the increase button.
    expect(document.activeElement).toBe(
      screen.getByTestId("workflow-permission-settings-bound-increase"),
    );

    const session = option("Always allow in this session");
    session.focus();
    fireEvent.keyDown(session, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(option("Allow")));
  });

  it("keys typed in the number box stay there: the options' digit shortcuts do not fire", () => {
    const { onRespond } = renderDialog(workflowRequest(ADJUSTABLE));
    fireEvent.keyDown(boundValue(), { key: "1" });
    fireEvent.keyDown(boundValue(), { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe("legacy agent (input without adjustable_settings)", () => {
  it("draws only the fields the call set, plain text, model above and ceiling below; no controls", () => {
    renderDialog(workflowRequest({ max_concurrency: 2, subagent_model: "zhipu/glm-5.3-flash" }));
    expect(screen.queryByTestId("workflow-permission-settings")).toBeNull();
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Subagents run on glm-5.3-flash")).toBeLessThan(
      blockText.indexOf("At most 2 subagents at once"),
    );
  });
});

describe("V4 host", () => {
  it("puts the changed settings into resolveInteraction.answer.content", async () => {
    sendCommand.mockResolvedValue({ status: "accepted", commandId: "c", revisionAtDecision: 0 });
    const snapshot = {
      sessionId: "sess-1",
      config: { provider: "zhipu", model: "glm-5.3" },
      pendingInteractions: [
        {
          interactionId: "ask-1",
          kind: "permission",
          anchorRowId: 3,
          createdAt: 1,
          payload: {
            kind: "permission",
            toolName: "CreateWorkflow",
            toolCallId: "tool-1",
            summary: "createWorkflow.runConfirmation",
            options: [
              { optionId: "allowOnce", kind: "allowOnce", label: "Allow" },
              { optionId: "deny", kind: "deny", label: "Deny" },
            ],
            detail: { name: "Research", script: SCRIPT, ...ADJUSTABLE },
          },
        },
      ],
    } as unknown as ConversationSnapshot;
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/w",
          snapshot,
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("workflow-permission-settings-bound-decrease"));
    fireEvent.click(option("Allow"));
    await waitFor(() => expect(sendCommand).toHaveBeenCalled());
    const envelope = sendCommand.mock.calls
      .map(([sent]) => sent as { type: string; payload: { answer?: unknown } })
      .find((sent) => sent.type === "resolveInteraction");
    expect(envelope?.payload.answer).toEqual({
      optionId: "allowOnce",
      content: { max_concurrency: 12 },
    });
  });
});
