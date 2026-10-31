import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExternalAgentConfigOption,
  ExternalAgentConfigState,
} from "@zcode/shared/zcode-protocol-v4";

const captured = vi.hoisted(() => ({
  radioGroups: [] as Array<Record<string, unknown>>,
  modeSwitchProps: null as Record<string, unknown> | null,
  shortcutParams: null as Record<string, unknown> | null,
  catalogOptions: null as unknown,
  catalogService: null as unknown,
}));
const composerHostService = vi.hoisted(() => ({ host: "composer-workspace" }));

// The host catalog read (S6 readiness) is stubbed; the composer shows it when no live projection exists.
vi.mock("@/hooks/useAcpAgentCatalog.js", () => ({
  useAcpAgentCatalog: (service: unknown) => {
    captured.catalogService = service;
    return { options: captured.catalogOptions };
  },
}));
// The composer reads the catalog from its workspace context's host (specs/acp-agent-runtime.md "Settings: workspace host").
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService: composerHostService }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: (props: { children?: ReactNode }) =>
    createElement("span", null, props.children),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => {
  const children = (props: { children?: ReactNode }) => createElement("span", null, props.children);
  return {
    DropdownMenu: children,
    DropdownMenuTrigger: children,
    DropdownMenuContent: children,
    DropdownMenuLabel: children,
    DropdownMenuSeparator: () => createElement("hr"),
    DropdownMenuRadioItem: (props: { children?: ReactNode; value: string }) =>
      createElement("span", { "data-radio-value": props.value }, props.children),
    DropdownMenuRadioGroup: (props: Record<string, unknown> & { children?: ReactNode }) => {
      captured.radioGroups.push(props);
      return children(props);
    },
  };
});

vi.mock("@/chat-input-toolbar/RollingToolbarLabel.js", () => ({
  RollingToolbarLabel: ({ label }: { label: string }) => createElement("span", null, label),
}));

vi.mock("@/lib/pickerFocus.js", () => ({
  restoreComposerInputFocusAfterPickerClose: vi.fn(),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useShortcutCommandLabel: () => "Ctrl+Shift+M",
}));

vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  useToolbarShortcutBindings: (params: Record<string, unknown>) => {
    captured.shortcutParams = params;
  },
}));

// The ZCode permission-mode switch is replaced as a whole; a sentinel proves which branch rendered.
vi.mock("@/v4/composer/V4ComposerToolbar.js", () => ({
  V4ComposerModeSwitch: (props: Record<string, unknown>) => {
    captured.modeSwitchProps = props;
    return createElement("span", { "data-testid": "chat-mode-select-trigger" });
  },
}));

import { V4ComposerModeArea } from "@/v4/composer/V4ExternalAgentConfigControls.js";

function selectOption(
  id: string,
  category: string | null,
  values: string[],
  currentValue = values[0]!,
): ExternalAgentConfigOption {
  return {
    id,
    name: `Agent ${id}`,
    description: null,
    category,
    currentValue,
    options: values.map((value) => ({
      value,
      name: `${value} (agent)`,
      description: null,
      group: null,
    })),
  };
}

const projection: ExternalAgentConfigState = {
  agentId: "mock",
  options: [
    selectOption("mode", "mode", ["default", "plan", "acceptEdits"]),
    selectOption("model", "model", ["sonnet", "opus"]),
    selectOption("verbosity", null, ["low", "high"]),
  ],
};

function render(
  overrides: {
    draftProviderId?: string;
    sessionId?: string | null;
    sessionProviderId?: string | null;
    externalAgentConfig?: ExternalAgentConfigState;
    catalog?: ExternalAgentConfigOption[] | null;
    draftExternalAgentChoices?: Record<string, Record<string, Record<string, string>>>;
    draftExternalAgentKey?: string | null;
    onSetDraftExternalAgentChoice?: (
      draftSessionId: string,
      agentId: string,
      configId: string,
      value: string,
    ) => void;
    onSetExternalAgentConfigOption?: (configId: string, value: string) => void;
  } = {},
) {
  captured.catalogOptions = "catalog" in overrides ? overrides.catalog : null;
  const props = {
    workspacePath: "/workspace",
    provider: "glm" as const,
    draftConfig: {
      mode: "build",
      modelSelection: { providerId: overrides.draftProviderId ?? "acp:mock", modelId: "default" },
    },
    disabled: false,
    activeConfigPicker: null,
    onConfigPickerOpenChange: vi.fn(),
    onSwitchMode: vi.fn(),
    sessionId: "sessionId" in overrides ? overrides.sessionId! : "session-1",
    sessionProviderId: "sessionProviderId" in overrides ? overrides.sessionProviderId : "acp:mock",
    externalAgentConfig:
      "externalAgentConfig" in overrides ? overrides.externalAgentConfig : projection,
    onSetExternalAgentConfigOption:
      "onSetExternalAgentConfigOption" in overrides
        ? overrides.onSetExternalAgentConfigOption
        : vi.fn(),
    draftExternalAgentChoices: overrides.draftExternalAgentChoices,
    draftExternalAgentKey:
      "draftExternalAgentKey" in overrides ? overrides.draftExternalAgentKey : "draft-1",
    onSetDraftExternalAgentChoice: overrides.onSetDraftExternalAgentChoice,
  };
  const html = renderToStaticMarkup(
    createElement(V4ComposerModeArea, props as Parameters<typeof V4ComposerModeArea>[0]),
  );
  return { html, props };
}

beforeEach(() => {
  captured.radioGroups = [];
  captured.modeSwitchProps = null;
  captured.shortcutParams = null;
  captured.catalogOptions = null;
});

describe("V4ComposerModeArea (S6 agent configuration options)", () => {
  it("renders the agent's mode and model selects with agent labels and no ZCode permission modes", () => {
    const { html } = render();

    expect(captured.modeSwitchProps).toBeNull();
    expect(html).not.toContain("chat-mode-select-trigger");
    expect(html).not.toContain("chat-mode-select-item");
    expect(html).toContain('data-testid="external-agent-config-trigger-mode"');
    expect(html).toContain('data-testid="external-agent-config-trigger-model"');
    // Effort is not offered and other selects are not shown in S6.
    expect(html).not.toContain("external-agent-config-trigger-effort");
    expect(html).not.toContain("verbosity");
    // Labels and value names come from the agent untranslated.
    expect(html).toContain("Agent mode");
    expect(html).toContain("default (agent)");
    expect(html).toContain("opus (agent)");
    expect(html).toContain('data-testid="external-agent-config-hint"');
    expect(html).toContain("chat.toolbar.externalAgent.hint");
    expect(html).not.toContain("chat.toolbar.externalAgent.availableAfterFirstMessage");
  });

  it("shows Effort only when the agent offers a thought_level or effort option", () => {
    const { html } = render({
      externalAgentConfig: {
        agentId: "mock",
        options: [...projection.options, selectOption("effort", null, ["low", "high"])],
      },
    });
    expect(html).toContain('data-testid="external-agent-config-trigger-effort"');
  });

  it("renders the ZCode mode switch unchanged for a non-ACP model", () => {
    const { html, props } = render({ draftProviderId: "glm", sessionProviderId: "glm" });

    expect(html).toContain("chat-mode-select-trigger");
    expect(html).not.toContain("external-agent-config-trigger");
    expect(captured.modeSwitchProps).toEqual({
      workspacePath: props.workspacePath,
      provider: props.provider,
      draftConfig: props.draftConfig,
      disabled: props.disabled,
      activeConfigPicker: props.activeConfigPicker,
      onConfigPickerOpenChange: props.onConfigPickerOpenChange,
      onSwitchMode: props.onSwitchMode,
    });
  });

  it("shows the placeholder only when no projection exists for the agent", () => {
    const { html } = render({ externalAgentConfig: undefined });

    expect(html).toContain('data-testid="external-agent-config-trigger-mode"');
    expect(html).toContain('data-testid="external-agent-config-trigger-model"');
    expect(html).not.toContain("external-agent-config-trigger-effort");
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html.match(/data-external-agent-config-available="false"/g)).toHaveLength(2);
    expect(html).toContain("chat.toolbar.externalAgent.availableAfterFirstMessage");
    expect(html).toContain("chat.toolbar.externalAgent.hint");
    expect(captured.radioGroups).toHaveLength(0);
    expect(captured.shortcutParams).toMatchObject({ hasAnyOption: false });
  });

  it("shows the catalog selects with a session of this agent, enabled", () => {
    const { html } = render({
      externalAgentConfig: undefined,
      catalog: projection.options,
      sessionId: "prewarm-1",
    });

    expect(html).not.toContain("chat.toolbar.externalAgent.availableAfterFirstMessage");
    expect(html).toContain("Agent mode");
    expect(html.match(/data-external-agent-config-available="true"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-disabled="true"');
    expect(captured.shortcutParams).toMatchObject({ hasAnyOption: true });
    expect(captured.catalogService).toBe(composerHostService);
  });

  it("in a draft, shows the catalog and a choice only updates the draft state", () => {
    const onDraft = vi.fn();
    const onSession = vi.fn();
    render({
      externalAgentConfig: undefined,
      catalog: projection.options,
      sessionId: null,
      onSetDraftExternalAgentChoice: onDraft,
      onSetExternalAgentConfigOption: onSession,
    });

    const modeGroup = captured.radioGroups.find((group) => group.value === "default")!;
    (modeGroup.onValueChange as (value: string) => void)("plan");
    expect(onDraft).toHaveBeenCalledWith("draft-1", "mock", "mode", "plan");
    expect(onSession).not.toHaveBeenCalled();
  });

  it("shows the placeholder without a draft session id, so no draft choice is taken", () => {
    const onDraft = vi.fn();
    const { html } = render({
      externalAgentConfig: undefined,
      catalog: projection.options,
      sessionId: null,
      draftExternalAgentKey: null,
      onSetDraftExternalAgentChoice: onDraft,
    });

    expect(html).toContain("chat.toolbar.externalAgent.availableAfterFirstMessage");
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("shows the draft's choices as the current values of the catalog", () => {
    const { html } = render({
      externalAgentConfig: undefined,
      catalog: projection.options,
      sessionId: null,
      draftExternalAgentChoices: { "draft-1": { mock: { mode: "plan" } } },
      onSetDraftExternalAgentChoice: vi.fn(),
    });

    expect(html).toContain("Agent mode: plan (agent)");
  });

  it.each([["when the session model is not this agent yet", { sessionProviderId: "glm" }]])(
    "shows the catalog selects disabled %s",
    (_name, overrides) => {
      const onSet = vi.fn();
      const { html } = render({
        ...overrides,
        externalAgentConfig: undefined,
        catalog: projection.options,
        onSetExternalAgentConfigOption: onSet,
      });

      expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
      expect(html.match(/data-external-agent-config-available="false"/g)).toHaveLength(2);
      expect(html).not.toContain("chat.toolbar.externalAgent.availableAfterFirstMessage");
      expect(captured.shortcutParams).toMatchObject({ hasAnyOption: false });
      const modeGroup = captured.radioGroups.find((group) => group.value === "default")!;
      (modeGroup.onValueChange as (value: string) => void)("plan");
      expect(onSet).not.toHaveBeenCalled();
    },
  );

  it("choosing a value sends the option id and value", () => {
    const onSet = vi.fn();
    render({ onSetExternalAgentConfigOption: onSet });

    const modeGroup = captured.radioGroups.find((group) => group.value === "default")!;
    (modeGroup.onValueChange as (value: string) => void)("plan");
    expect(onSet).toHaveBeenCalledWith("mode", "plan");

    const modelGroup = captured.radioGroups.find((group) => group.value === "sonnet")!;
    (modelGroup.onValueChange as (value: string) => void)("opus");
    expect(onSet).toHaveBeenLastCalledWith("model", "opus");
  });

  it("adds a filter input only to a select with more than 8 values", () => {
    const many = Array.from({ length: 9 }, (_, index) => `model-${index}`);
    const { html } = render({
      externalAgentConfig: {
        agentId: "mock",
        options: [projection.options[0]!, selectOption("model", "model", many)],
      },
    });
    expect(html.match(/data-testid="external-agent-config-search"/g)).toHaveLength(1);
    expect(html).toContain('placeholder="chat.toolbar.externalAgent.searchPlaceholder"');

    const few = render();
    expect(few.html).not.toContain("external-agent-config-search");
  });

  it("cycleSessionMode cycles the agent's mode option", () => {
    const onSet = vi.fn();
    render({ onSetExternalAgentConfigOption: onSet });

    expect(captured.shortcutParams).toMatchObject({
      hasAnyOption: true,
      modeOption: { id: "mode", category: "mode", type: "select", currentValue: "default" },
    });
    (captured.shortcutParams!.onCycleSessionMode as () => void)();
    expect(onSet).toHaveBeenCalledWith("mode", "plan");
  });
});
