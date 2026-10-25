// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ZCodeAutomation, type ModelSelection } from "@zcode/shared";
import {
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
} from "@zcode/shared/test-ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AutomationEditTestLocale = "en-US" | "zh-CN";

// Locale fixtures keep the zh-CN literal out of `locale = ...` setups while the
// default-title test still covers both catalog languages.
const localeFixtures = vi.hoisted(() => ({
  chinese: "zh-CN" as const,
  english: "en-US" as const,
  titlePlaceholder: {
    "zh-CN": "未命名定时任务",
    "en-US": "Untitled Automation",
  } as Record<AutomationEditTestLocale, string>,
}));

const stableHookValues = vi.hoisted(() => ({
  configResult: { configOptions: [] },
  projectOptions: [] as Array<{
    projectId?: string | null;
    hostId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    remoteTarget?: { type: "ssh"; host: string };
    label: string;
    workspacePurpose?: "project" | "conversation";
  }>,
  modelSelectionView: null as typeof modelSelectionView | null,
  modelSelectionTargets: [] as Array<{
    workspacePath: string | null | undefined;
    remoteSessionId?: string | null;
    workspaceIdentity?: string | null;
    remoteTarget?: unknown;
  }>,
  selectRegistrations: 0,
  effectiveSelection: undefined as ModelSelection | null | undefined,
  selectionInputs: [] as Array<{ selection: ModelSelection | null } | undefined>,
  locale: localeFixtures.chinese as AutomationEditTestLocale,
  services: { zcodeAgentService: {} },
}));

vi.mock("@/components/ui/select.js", async () => {
  const { createElement: h, useEffect, createContext, useContext } = await import("react");
  const Selection = createContext<((value: string) => void) | undefined>(undefined);
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Select: ({
      children,
      onValueChange,
      value,
    }: {
      children?: ReactNode;
      onValueChange?: (value: string) => void;
      value?: string;
    }) => {
      useEffect(() => {
        const timer = window.setTimeout(() => {
          // Simulate the Radix Select controlled-value/child-registration race that
          // emits an empty value after form initialization: this is not a user
          // action, and consumers must discard callbacks outside the value domain
          // (regression: merely opening the detail view and going back used to
          // raise the unsaved-changes prompt).
          onValueChange?.("");
          if (
            value &&
            ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"].includes(value)
          ) {
            stableHookValues.selectRegistrations += 1;
            onValueChange?.(value);
          }
        }, 0);
        return () => window.clearTimeout(timer);
      }, []);
      return h(Selection.Provider, { value: onValueChange }, children);
    },
    SelectContent: passthrough,
    SelectItem: ({ children, value }: { children?: ReactNode; value: string }) => {
      const select = useContext(Selection);
      return h("button", { type: "button", onClick: () => select?.(value) }, children);
    },
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

vi.mock("@/settings/SettingsHeaderBreadcrumb.js", async () => {
  const { createElement: h } = await import("react");
  return {
    SettingsBreadcrumbReporter: ({
      items,
      onSectionSelect,
    }: {
      items: Array<{ label: string }>;
      onSectionSelect?: () => void;
    }) =>
      h(
        "button",
        {
          "data-testid": "automation-edit-breadcrumb-section",
          onClick: onSectionSelect,
          type: "button",
        },
        items[0]?.label,
      ),
  };
});

vi.mock("@/components/ui/dialog.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? h("div", null, children) : null,
    DialogClose: passthrough,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/dropdown-menu.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough,
    DropdownMenuSeparator: () => h("hr"),
    DropdownMenuTrigger: passthrough,
  };
});

vi.mock("@/components/ui/popover.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Popover: passthrough,
    PopoverContent: passthrough,
    PopoverTrigger: passthrough,
  };
});

vi.mock("@/components/ui/tooltip.js", async () => {
  const { createElement: h } = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) => h("div", null, children);
  return {
    Tooltip: passthrough,
    TooltipContent: passthrough,
    TooltipProvider: passthrough,
    TooltipTrigger: passthrough,
  };
});

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
// The permission selector reuses the session composer's ConfigSelect: keep the real
// implementation here so the registration-race empty value emitted by the Select mock
// above passes through it, guarding the "out-of-domain callbacks must not mark
// unsaved changes" protection.
vi.mock("@/chat-input-toolbar/RollingToolbarLabel.js", () => ({
  RollingToolbarLabel: ({ label }: { label: string }) => label,
}));
vi.mock("@/ModelConfigSelect.js", async () => {
  const { createElement: h } = await import("react");
  return {
    ModelConfigSelect: ({ triggerLabel }: { triggerLabel?: string }) =>
      h("span", { "data-testid": "automation-model-trigger-label" }, triggerLabel),
  };
});
vi.mock("@/chat-input-toolbar/ThoughtLevelCycleControl.js", () => ({
  ThoughtLevelCycleControl: () => null,
}));

vi.mock("@/hooks/useAutomationProjectOptions.js", () => ({
  useAutomationProjectOptions: () => stableHookValues.projectOptions,
}));
vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => stableHookValues.configResult,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => stableHookValues.services,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => null,
  useWorkspaceServicesResolution: (
    workspacePath: string | null | undefined,
    remoteSessionId?: string | null,
    workspaceIdentity?: string | null,
    remoteTarget?: unknown,
  ) => {
    stableHookValues.modelSelectionTargets.push({
      workspacePath,
      remoteSessionId,
      workspaceIdentity,
      remoteTarget,
    });
    return { connectionKind: "local", services: stableHookValues.services };
  },
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionServiceView: (
    _service: unknown,
    _enabled: boolean,
    _reason: string,
    input?: { selection: ModelSelection | null },
  ) => {
    stableHookValues.selectionInputs.push(input);
    return {
      state: stableHookValues.modelSelectionView
        ? {
            status: "ready" as const,
            view: {
              ...stableHookValues.modelSelectionView,
              ...(input
                ? {
                    effectiveSelection:
                      stableHookValues.effectiveSelection === undefined
                        ? input.selection
                        : stableHookValues.effectiveSelection,
                  }
                : {}),
            },
          }
        : { status: "loading" as const },
      reload: vi.fn(),
    };
  },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        if (id === "automations.edit.titlePlaceholder") {
          return localeFixtures.titlePlaceholder[stableHookValues.locale];
        }
        return id;
      },
    },
  }),
}));

import { AutomationEditView } from "@/settings/AutomationEditView.js";

const modelSelectionView = {
  revision: 1,
  providers: [
    {
      providerId: "provider",
      providerName: "DeepSeek Provider",
      config: {
        api: {
          type: "openai-chat-completions",
          baseUrl: "https://example.test",
        },
      },
      models: [
        {
          modelId: "deepseek-v4-flash",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"], map: "{}" },
              maxOutputTokens: { max: 32_000, map: "{}" },
            },
          },
        },
      ],
    },
  ],
};

const sessionCreatedAutomation: ZCodeAutomation = {
  automationId: "automation-session-created",
  title: "每 10 分钟提醒",
  cronExpr: "*/10 * * * *",
  prompt: "提醒用户休息",
  model: "provider/deepseek-v4-flash",
  modelSelection: {
    providerId: "provider",
    modelId: "deepseek-v4-flash",
    options: { reasoningLevel: "low" },
  },
  mode: "edit",
  thoughtLevel: "low",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  targetTaskId: "session-from-chat",
  locationKind: "local",
  recurring: true,
  scheduleRule: {
    unit: "minute",
    interval: 10,
    hour: 16,
    minute: 49,
    anchorAt: 1_784_887_300_020,
    weekdays: [1],
    monthDays: [1],
    monthlyMode: "date",
  },
  runCount: 0,
  enabled: true,
  lifecycleStatus: "active",
  dispatchStatus: "idle",
  dispatchAttempts: 0,
  createdAt: 1,
  updatedAt: 1,
};

const uiCreatedAutomation: ZCodeAutomation = {
  ...sessionCreatedAutomation,
  automationId: "automation-ui-created",
};
delete uiCreatedAutomation.targetTaskId;

const sessionCreatedUiResetAutomation: ZCodeAutomation = {
  ...sessionCreatedAutomation,
  automationId: "automation-session-created-ui-reset",
  cronExpr: "0 9 * * *",
  scheduleRule: undefined,
  scheduleEditedByUser: true,
};

beforeEach(() => {
  stableHookValues.selectRegistrations = 0;
  stableHookValues.locale = localeFixtures.chinese;
  stableHookValues.projectOptions.length = 0;
  stableHookValues.modelSelectionView = null;
  stableHookValues.modelSelectionTargets.length = 0;
  stableHookValues.effectiveSelection = undefined;
  stableHookValues.selectionInputs.length = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(cleanup);

describe("AutomationEditView session-created dirty state", () => {
  it("the original account selection is display-only; an explicit save adopts the effective selection", async () => {
    stableHookValues.modelSelectionView = modelSelectionView;
    stableHookValues.effectiveSelection = uiCreatedAutomation.modelSelection;
    const original = {
      ...uiCreatedAutomation.modelSelection!,
      providerId: "account:bigmodel-individual-coding-plan",
    };
    const editing = { ...uiCreatedAutomation, modelSelection: original };
    const onSubmit = vi.fn(async () => true);
    render(
      createElement(AutomationEditView, {
        editing,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit,
        onBack: vi.fn(),
      }),
    );
    await waitFor(() =>
      expect(stableHookValues.selectionInputs.at(-1)).toEqual({
        selection: original,
      }),
    );
    expect(screen.getByTestId("automation-model-trigger-label").textContent).toBe(
      "DeepSeek Provider/deepseek-v4-flash",
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editing.modelSelection).toEqual(original);
    fireEvent.click(screen.getByRole("button", { name: "automations.form.save" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            modelSelection: uiCreatedAutomation.modelSelection,
          }),
        }),
      ),
    );
    expect(editing.modelSelection).toEqual(original);
  });

  it("the auto default title for new automations follows locale switches without overwriting user input", () => {
    const props = {
      editing: null,
      defaultWorkspacePath: "/workspace",
      saving: false,
      onSubmit: vi.fn(async () => true),
      onBack: vi.fn(),
    };
    const { rerender } = render(createElement(AutomationEditView, props));
    const titleInput = screen.getByLabelText<HTMLInputElement>("automations.form.title.label");

    expect(titleInput.value).toBe(localeFixtures.titlePlaceholder[localeFixtures.chinese]);

    stableHookValues.locale = localeFixtures.english;
    rerender(createElement(AutomationEditView, props));
    expect(titleInput.value).toBe(localeFixtures.titlePlaceholder[localeFixtures.english]);

    fireEvent.click(screen.getByTestId("automation-edit-breadcrumb-section"));
    expect(props.onBack).toHaveBeenCalledOnce();

    fireEvent.change(titleInput, { target: { value: "Keep my title" } });
    stableHookValues.locale = localeFixtures.chinese;
    rerender(createElement(AutomationEditView, props));
    expect(titleInput.value).toBe("Keep my title");
  });

  it("template values become a plain draft once in the form; locale switches do not overwrite user edits", () => {
    const props = {
      editing: null,
      initialDraft: {
        title: "远程模板标题",
        cronExpr: "0 9 * * 1-5",
        prompt: "远程模板指令",
      },
      defaultWorkspacePath: "/workspace",
      modelProviders: [],
      saving: false,
      onSubmit: vi.fn(async () => true),
      onBack: vi.fn(),
    };
    const { rerender } = render(createElement(AutomationEditView, props));
    const titleInput = screen.getByLabelText<HTMLInputElement>("automations.form.title.label");
    const promptInput = screen.getByLabelText<HTMLTextAreaElement>("automations.form.prompt.label");

    fireEvent.change(titleInput, { target: { value: "My title" } });
    fireEvent.change(promptInput, {
      target: { value: "My edited instruction" },
    });
    stableHookValues.locale = localeFixtures.english;
    rerender(createElement(AutomationEditView, props));

    expect(titleInput.value).toBe("My title");
    expect(promptInput.value).toBe("My edited instruction");
  });

  it("when editing, the model trigger shows providerName/modelName like the session side", () => {
    stableHookValues.modelSelectionView = modelSelectionView;
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    expect(screen.getByTestId("automation-model-trigger-label").textContent).toBe(
      "DeepSeek Provider/deepseek-v4-flash",
    );
  });

  it("after switching the target project, reads the model view from that Host with remote routing", async () => {
    stableHookValues.projectOptions.push(
      { workspacePath: "/local", label: "local" },
      {
        workspacePath: "/remote/project",
        workspaceIdentity: "ssh:server:/remote/project",
        remoteSessionId: "remote-session",
        remoteTarget: { type: "ssh", host: "server" },
        label: "remote",
      },
    );

    render(
      createElement(AutomationEditView, {
        editing: null,
        defaultWorkspacePath: "/local",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "remote" }));

    await waitFor(() => {
      expect(stableHookValues.modelSelectionTargets.at(-1)).toEqual({
        workspacePath: "/remote/project",
        remoteSessionId: "remote-session",
        workspaceIdentity: "ssh:server:/remote/project",
        remoteTarget: { type: "ssh", host: "server" },
      });
    });
  });

  it("editing a project-less automation keeps the session-side copy and icon", () => {
    const conversationWorkspacePath = "/Users/test/.zcode/workspace/default";
    stableHookValues.projectOptions.push({
      workspacePath: conversationWorkspacePath,
      label: "default",
      workspacePurpose: "conversation",
    });
    const conversationAutomation: ZCodeAutomation = {
      ...uiCreatedAutomation,
      projectId: null,
      workspaceKey: conversationWorkspacePath,
      workspacePath: conversationWorkspacePath,
    };

    const { container } = render(
      createElement(AutomationEditView, {
        editing: conversationAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    const workspaceLabel = screen.getByText("chat.empty.workOutsideProject");
    const workspaceButton = workspaceLabel.closest("button");
    expect(workspaceButton?.querySelector(".lucide-message-circle")).not.toBeNull();
    expect(workspaceButton?.querySelector(".lucide-folder-open")).toBeNull();
    expect(container.textContent).not.toContain("default");
  });

  it("a session-created minute plan shows custom only; merely opening it and going back must not prompt to save", async () => {
    const onBack = vi.fn();
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack,
      }),
    );

    expect(screen.getByTestId(TID_AUTOMATION_SCHEDULE_PREVIEW).textContent).toBe(
      "automations.schedule.customMinutes",
    );
    expect(screen.queryByText("automations.customRepeat.compactFrequency")).not.toBeNull();
    expect(stableHookValues.selectRegistrations).toBe(0);

    // Wait for the Select registration-race empty callback to fire before going
    // back, reproducing the "merely opening the detail view marked it unsaved"
    // regression.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    fireEvent.click(screen.getByRole("button", { name: sessionCreatedAutomation.title }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.queryByText("automations.unsaved.title")).toBeNull();
  });

  it("the same minute plan created from the UI still uses the visual schedule controls", async () => {
    render(
      createElement(AutomationEditView, {
        editing: uiCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("automations.customRepeat.compactFrequency")).toBeTruthy();
      expect(stableHookValues.selectRegistrations).toBeGreaterThan(0);
    });
    expect(screen.getByText("automations.customRepeat.compactFrequency")).toBeTruthy();
  });

  it("after the user resets the schedule of a session-created automation, reopening still restores the visual controls", async () => {
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedUiResetAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(stableHookValues.selectRegistrations).toBeGreaterThan(0);
    });
    expect(screen.getByTestId(TID_AUTOMATION_SCHEDULE_PREVIEW).textContent).toBe(
      "automations.schedule.daily",
    );
  });

  it("deleting the session-sourced custom schedule switches to the UI schedule entry", () => {
    render(
      createElement(AutomationEditView, {
        editing: sessionCreatedAutomation,
        defaultWorkspacePath: "/workspace",
        saving: false,
        onSubmit: vi.fn(async () => true),
        onBack: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));

    expect(screen.getByTestId(TID_AUTOMATION_SCHEDULE_ADD)).toBeTruthy();
    expect(screen.queryByText("automations.customRepeat.compactFrequency")).toBeNull();
  });
});
