import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { V4ComposerModelControls } from "@/v4/composer/V4ComposerToolbar.js";
import type { ModelConfigSelect } from "@/ModelConfigSelect.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type ModelConfigSelectProps = ComponentProps<typeof ModelConfigSelect>;
type V4ComposerModelControlsProps = ComponentProps<typeof V4ComposerModelControls>;

const customValue = "custom:custom-openai:gpt-4o";

const captured = vi.hoisted(() => ({
  modelSelectProps: null as ModelConfigSelectProps | null,
  thoughtControlProps: null as {
    indicatorClassName?: string;
    triggerClassName?: string;
    composerCollapsePriority?: number;
    onValueChange: (value: string) => void;
    option: { currentValue?: unknown; options?: Array<{ value: string }> };
  } | null,
  usageProps: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "account-a" } as { id: string } | null, authSessionSeq: 1 },
  connectionSwitchError: null as string | null,
  selectConnection: vi.fn(),
  codingPlanEntitlements: {} as Record<string, unknown>,
  codingPlanEntitlementsRefresh: vi.fn(async () => undefined),
  // Fix rationale: the context-hover start plan onAccess mounts per
  // enabledStartPlanProviderIds; the default empty array simulates Start Plan
  // having no separate Account Access yet, and cases needing the entry provide
  // the provider id explicitly.
  codingPlanEntitlementsEnabledStartPlanIds: [] as string[],
  configOptions: [] as Array<Record<string, unknown>>,
  configOptionsError: true,
  enterpriseProducts: { snapshot: { productList: [] }, loading: false, error: null } as Record<
    string,
    unknown
  >,
  modelSelectionView: {
    revision: 1,
    providers: [
      {
        providerId: "custom-openai",
        providerName: "Custom OpenAI",
        config: {
          access: { type: "api-key", apiKey: "test-key" },
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://api.example.com/v1",
          },
          models: ["gpt-4o"],
        },
        models: [
          {
            modelId: "gpt-4o",
            config: {
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: { max: 32_000, map: "{}" },
              },
            },
          },
        ],
      },
    ],
  } as null | {
    revision: number;
    providers: Array<{
      providerId: string;
      providerName?: string;
      config: Record<string, unknown>;
      models: Array<{ modelId: string; config: Record<string, unknown> }>;
    }>;
  },
  providerSettingsView: {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [],
  } as ProviderSettingsView,
  recoverCustomModelSelection: vi.fn(async () => {}),
  selectModel: vi.fn(),
  settings: {
    providerFamilyConnectionSelections: {},
    providerFamilyDomain: {},
  } as Record<string, unknown>,
  usageEntitlement: { snapshot: null, loading: false, error: null } as Record<string, unknown>,
  usageEntitlementRefresh: vi.fn(async () => undefined),
}));

function completeDisabledModelConfig() {
  return {
    optionSpecs: {
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: { max: 32_000, map: "{}" },
    },
  };
}

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (selector: (state: typeof mocks.auth) => unknown) =>
    selector(mocks.auth),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({ useBaseWorkspaceServices: () => ({}) }));
vi.mock("@/hooks/useComposerConnectionSwitch.js", () => ({
  useComposerConnectionSwitch: () => ({
    pending: false,
    error: mocks.connectionSwitchError,
    select: mocks.selectConnection,
  }),
}));
vi.mock("@/ModelConfigSelect.js", async () => {
  const React = await import("react");
  return {
    ModelConfigSelect: (props: ModelConfigSelectProps) => {
      captured.modelSelectProps = props;
      if (props.triggerRef && "current" in props.triggerRef) {
        (props.triggerRef as { current: HTMLSpanElement | null }).current = {
          contains: () => false,
          getClientRects: () => [{ width: 1 }] as unknown as DOMRectList,
        } as HTMLSpanElement;
      }
      return React.createElement("button", {
        "data-testid": "mock-model-select",
        disabled: props.disabled,
      });
    },
  };
});

vi.mock("@/chat-input-toolbar/display.js", async () => {
  const React = await import("react");
  return {
    ChatContextUsage: (props: Record<string, unknown>) => {
      captured.usageProps.push(props);
      return React.createElement("span", { "data-testid": "mock-usage" });
    },
  };
});

vi.mock("@/chat-input-toolbar/ThoughtLevelCycleControl.js", async () => {
  const React = await import("react");
  return {
    ThoughtLevelCycleControl: (props: {
      onValueChange: (value: string) => void;
      option: { currentValue?: unknown; options?: Array<{ value: string }> };
    }) => {
      captured.thoughtControlProps = props;
      return React.createElement("span", { "data-testid": "mock-thought" });
    },
  };
});

vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  useToolbarShortcutBindings: vi.fn(),
}));

vi.mock("@/chat-input-toolbar/modelSelection.js", () => ({
  resolveModelSelectTriggerDisplay: (value: string) => ({ value }),
  shouldShowManageModelsAction: () => false,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => vi.fn(),
}));

vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: mocks.providerSettingsView
      ? { status: "ready", view: mocks.providerSettingsView }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: mocks.settings,
  }),
}));

vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlement: vi.fn((_options) => ({
    ...mocks.usageEntitlement,
    refresh: mocks.usageEntitlementRefresh,
  })),
}));

vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => ({
    configOptions: mocks.configOptions,
    loading: false,
    error: mocks.configOptionsError,
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: vi.fn() }),
}));

vi.mock("@/settings/model-provider-section/useCodingPlanEntitlements.js", () => ({
  useCodingPlanEntitlements: () => ({
    entitlements: mocks.codingPlanEntitlements,
    enabledStartPlanProviderIds: mocks.codingPlanEntitlementsEnabledStartPlanIds,
    refresh: mocks.codingPlanEntitlementsRefresh,
  }),
}));

vi.mock("@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js", () => ({
  useEnterpriseCodingPlanProducts: () => mocks.enterpriseProducts,
}));

vi.mock("@/lib/sidebarUsageCodingPlanProviderPreference.js", async () => {
  const actual = await vi.importActual("@/lib/sidebarUsageCodingPlanProviderPreference.js");
  return {
    ...(actual as Record<string, unknown>),
    writeSidebarUsageCodingPlanProviderPreference: vi.fn(),
  };
});

vi.mock("@/lib/codingPlanUsageSources.js", async () => {
  const actual = await vi.importActual("@/lib/codingPlanUsageSources.js");
  return actual;
});

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: vi.fn(),
  setPendingSettingsUsageIntent: vi.fn(),
}));

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    window: windowMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function addAccountProviderAccess(
  providerId: string,
  access:
    | {
        accountType: "zai" | "bigmodel";
        mode: "individual-coding-plan";
      }
    | {
        accountType: "zai" | "bigmodel";
        mode: "team-coding-plan";
      },
  label = providerId,
) {
  mocks.providerSettingsView = {
    revision: mocks.providerSettingsView.revision + 1,
    addableProviders: mocks.providerSettingsView.addableProviders,
    providerOrder: mocks.providerSettingsView.providerOrder,
    providers: [
      ...mocks.providerSettingsView.providers.filter(
        (provider) => provider.providerId !== providerId,
      ),
      {
        providerId,
        enabled: true,
        executable: true,
        effectiveConfig: {
          access: {
            type: "zhipu-account",
            entitled: true,
            ...access,
          },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://example.com",
          },
          label,
          builtinModelIds: [],
        },
        issues: [],
        models: [],
      },
    ],
  };
}

function createActiveEntitlement(providerId: string, extra: Record<string, unknown> = {}) {
  return {
    generatedAt: 1,
    authenticated: true,
    provider: {
      id: providerId,
      name: providerId,
    },
    remaining: null,
    subscription: null,
    quota: {
      level: "pro",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 35,
          usageDetails: [],
        },
      ],
    },
    ...extra,
  };
}

function renderToolbarMarkup(overrides: Partial<V4ComposerModelControlsProps> = {}): string {
  // A pure toolbar test provides an initialized Composer explicitly; production
  // initialization is owned by the scope owner.
  const seed = overrides.config ?? {
    provider: "custom-openai",
    model: "gpt-4o",
    thought: "disabled",
    mode: "build",
  };
  return renderToStaticMarkup(
    // HighspeedModelIndicator uses ControlHintTooltip and throws without a
    // TooltipProvider, so toolbar snapshots always wrap in the provider.
    createElement(
      TooltipProvider,
      null,
      createElement(V4ComposerModelControls, {
        workspacePath: "/workspace",
        modelSelectionView: mocks.modelSelectionView,
        sessionId: null,
        phase: null,
        config: {
          provider: "custom-openai",
          model: "gpt-4o",
          thought: "medium",
          thoughtLevels: ["medium", "high"],
          followupMode: "queue",
          mode: "build",
        },
        usage: {
          contextWindow: {
            usedTokens: 1024,
            maxTokens: 2048,
            autoCompactThresholdTokens: null,
          },
          cumulative: {
            inputTokens: 1024,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        disabled: false,
        onSelectModel: mocks.selectModel,
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
        draftConfig: {
          mode: seed.mode,
          modelSelection: {
            providerId: seed.provider,
            modelId: seed.model,
            ...(seed.thought ? { options: { reasoningLevel: seed.thought } } : {}),
          },
        },
        ...overrides,
      }),
    ),
  );
}

function latestUsageProps(): Record<string, unknown> {
  return captured.usageProps[captured.usageProps.length - 1] ?? {};
}

afterEach(() => {
  mocks.auth = { user: { id: "account-a" }, authSessionSeq: 1 };
  mocks.connectionSwitchError = null;
  mocks.selectConnection.mockClear();
  captured.modelSelectProps = null;
  captured.thoughtControlProps = null;
  captured.usageProps = [];
  mocks.codingPlanEntitlementsRefresh.mockClear();
  mocks.usageEntitlementRefresh.mockClear();
  mocks.codingPlanEntitlements = {};
  mocks.codingPlanEntitlementsEnabledStartPlanIds = [];
  mocks.configOptions = [];
  mocks.configOptionsError = true;
  mocks.enterpriseProducts = { snapshot: { productList: [] }, loading: false, error: null };
  mocks.modelSelectionView = {
    revision: 1,
    providers: [
      {
        providerId: "custom-openai",
        providerName: "Custom OpenAI",
        config: {
          access: { type: "api-key", apiKey: "test-key" },
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://api.example.com/v1",
          },
          models: ["gpt-4o"],
        },
        models: [{ modelId: "gpt-4o", config: completeDisabledModelConfig() }],
      },
    ],
  };
  mocks.providerSettingsView = {
    revision: 1,
    addableProviders: [],
    providerOrder: [],
    providers: [],
  };
  mocks.settings = {
    providerFamilyConnectionSelections: {},
    providerFamilyDomain: {},
  };
  mocks.usageEntitlement = { snapshot: null, loading: false, error: null };
  vi.clearAllMocks();
});

describe("V4ComposerModelControls recovery", () => {
  it("the entry does not flip to disabled when the same Host re-reads with a retained catalog; first load stays disabled", () => {
    renderToolbarMarkup({
      modelSelectionState: { status: "loading", catalog: mocks.modelSelectionView },
    });
    expect(captured.modelSelectProps?.disabled).toBe(false);
    renderToolbarMarkup({ modelSelectionState: { status: "loading" } });
    expect(captured.modelSelectProps?.disabled).toBe(true);
  });
  it("hides the context token usage ring while a Highspeed card is active", () => {
    const normalHtml = renderToolbarMarkup();
    const highspeedHtml = renderToolbarMarkup({ modelLocked: true });

    expect(normalHtml).toContain('data-testid="mock-usage"');
    expect(highspeedHtml).not.toContain('data-testid="mock-usage"');
  });

  it("places the countdown between the model and Think controls and shows the remaining time", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const html = renderToolbarMarkup({
      highspeedExpiresAt: 60_000,
      highspeedModel: "GLM-5.3",
      highspeedPresented: true,
    });
    const modelIndex = html.indexOf('data-highspeed-model-indicator="true"');
    const countdownIndex = html.indexOf('data-highspeed-countdown="true"');
    const thoughtIndex = html.indexOf('data-testid="mock-thought"');

    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(countdownIndex).toBeGreaterThan(modelIndex);
    expect(thoughtIndex).toBeGreaterThan(countdownIndex);
    expect(html).toContain("00:00:59");
    expect(html).toMatch(
      /title="chat.highspeed.remainingTime"[^>]*data-highspeed-countdown="true"/,
    );
  });

  it("a Composer with an existing session and an empty model still opens the model menu to reselect", () => {
    renderToolbarMarkup({
      sessionId: "existing-session",
      draftMode: false,
      draftConfig: { mode: "build" },
    });
    expect(captured.modelSelectProps).not.toBeNull();
    expect(captured.modelSelectProps?.normalizedValue).toBe("");
    expect(captured.thoughtControlProps).toBeNull();
  });

  it("renders an explicit retry action when the target Host model view fails", () => {
    const html = renderToolbarMarkup({
      modelSelectionView: null,
      modelSelectionState: { status: "error", error: new Error("read failed") },
      modelSelectionReload: vi.fn(),
    });

    expect(html).toContain("chat.toolbar.model.loadFailedRetry");
    expect(html).not.toContain('data-testid="mock-model-select"');
  });

  it("a Start entitlement catalog update does not auto-change the composer model or show the stale claim guide", async () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    mocks.settings = {
      providerFamilyConnectionSelections: { bigmodel: { kind: "start-plan" } },
      providerFamilyDomain: {},
    };
    mocks.modelSelectionView = {
      revision: 2,
      providers: [
        {
          providerId,
          providerName: "BigModel Start Plan",
          config: {
            access: { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://open.bigmodel.cn/api/anthropic",
            },
            models: ["GLM-5.3-Flash"],
          },
          models: [{ modelId: "GLM-5.3-Flash", config: completeDisabledModelConfig() }],
        },
      ],
    };

    const root: Root = createRoot(installMinimalDom());
    const props = {
      workspacePath: "/workspace",
      modelSelectionView: mocks.modelSelectionView,
      sessionId: null,
      phase: null,
      draftConfig: {
        mode: "build",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-4o",
          options: { reasoningLevel: "medium" },
        },
      },
      config: {
        provider: "custom-openai",
        model: "gpt-4o",
        thought: "medium",
        thoughtLevels: ["medium"],
        followupMode: "queue" as const,
        mode: "build" as const,
      },
      usage: null,
      disabled: false,
      onSelectModel: mocks.selectModel,
      onSelectThought: vi.fn(),
      onSwitchMode: vi.fn(),
    };

    await act(async () => {
      root.render(createElement(V4ComposerModelControls, props));
      await flushMicrotasks();
    });

    expect(mocks.selectModel).not.toHaveBeenCalled();
    expect(captured.modelSelectProps?.guideTooltipOpen).toBeUndefined();

    await act(async () => {
      root.render(createElement(V4ComposerModelControls, props));
      await flushMicrotasks();
    });
    expect(mocks.selectModel).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("the merged entry shows only the model name; the provider stays in the tooltip and menu", () => {
    renderToolbarMarkup();

    expect(captured.modelSelectProps?.triggerLabel).toBe("gpt-4o");
    expect(captured.modelSelectProps?.tooltipTitle).toBe("Custom OpenAI/gpt-4o");
    expect(captured.modelSelectProps?.triggerLabelPrefix).toBeUndefined();
  });

  it("uses only the Registry providerName once the Registry is published", () => {
    mocks.modelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "custom-openai",
          providerName: "Registry OpenAI",
          config: {
            access: { type: "api-key", apiKey: "test-key" },
            api: {
              type: "openai-chat-completions",
              baseUrl: "https://registry.example.com/v1",
            },
            models: ["gpt-4o"],
          },
          models: [{ modelId: "gpt-4o", config: completeDisabledModelConfig() }],
        },
      ],
    };

    renderToolbarMarkup();

    expect(captured.modelSelectProps?.triggerLabel).toBe("gpt-4o");
    expect(captured.modelSelectProps?.tooltipTitle).toBe("Registry OpenAI/gpt-4o");
  });

  it("does not treat a stale configOptions model as the selection source while prewarm is not ready", async () => {
    mocks.configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: customValue,
        options: [{ value: customValue, name: "GPT-4o" }],
      },
    ];
    mocks.modelSelectionView = {
      revision: 2,
      providers: [
        ...mocks.modelSelectionView!.providers,
        {
          providerId: "alternate-provider",
          providerName: "Alternate API",
          config: {
            access: { type: "api-key", apiKey: "alternate-key" },
            api: {
              type: "openai-chat-completions",
              baseUrl: "https://alt.example.com/v1",
            },
            models: ["deepseek-v4-pro"],
          },
          models: [{ modelId: "deepseek-v4-pro", config: completeDisabledModelConfig() }],
        },
      ],
    };

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: null,
          phase: null,
          config: null,
          draftMode: true,
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
        }),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      captured.modelSelectProps?.onValueChange("custom:alternate-provider:deepseek-v4-pro");
      await flushMicrotasks();
    });

    expect(mocks.selectModel).toHaveBeenCalledWith("alternate-provider", "deepseek-v4-pro", null);

    await act(async () => {
      root.unmount();
    });
  });

  it("V4 task boundaries no longer refresh the entitlement", async () => {
    const root: Root = createRoot(installMinimalDom());
    const renderPhase = (phase: V4ComposerModelControlsProps["phase"]) =>
      createElement(V4ComposerModelControls, {
        workspacePath: "/workspace",
        modelSelectionView: mocks.modelSelectionView,
        sessionId: "session-usage-refresh",
        phase,
        config: {
          provider: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          model: "glm-5",
          thought: "medium",
          thoughtLevels: ["medium"],
          followupMode: "queue",
          mode: "build",
        },
        usage: null,
        disabled: false,
        onSelectModel: mocks.selectModel,
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
      });

    await act(async () => {
      root.render(renderPhase("running"));
      await flushMicrotasks();
    });
    expect(mocks.codingPlanEntitlementsRefresh).not.toHaveBeenCalled();

    await act(async () => {
      root.render(renderPhase("completedInterrupted"));
      await flushMicrotasks();
    });
    expect(mocks.codingPlanEntitlementsRefresh).not.toHaveBeenCalled();

    await act(async () => {
      root.render(renderPhase("running"));
      await flushMicrotasks();
    });
    expect(mocks.codingPlanEntitlementsRefresh).not.toHaveBeenCalled();

    await act(async () => {
      root.render(renderPhase("completedSuccess"));
      await flushMicrotasks();
    });
    expect(mocks.codingPlanEntitlementsRefresh).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores empty thought events from the controlled Select during model switches", () => {
    mocks.configOptions = [
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
        ],
      },
    ];
    mocks.configOptionsError = false;
    const onSelectThought = vi.fn();

    renderToolbarMarkup({ onSelectThought });
    expect(captured.thoughtControlProps).toBeNull();
    expect(captured.modelSelectProps?.composerOptions).toBeDefined();
    captured.modelSelectProps?.composerOptions?.onValueChange("");
    expect(onSelectThought).not.toHaveBeenCalled();

    captured.modelSelectProps?.composerOptions?.onValueChange("high");
    expect(onSelectThought).toHaveBeenCalledWith("high", {
      provider: "custom-openai",
      model: "gpt-4o",
    });
  });

  it("session-state candidate levels come only from the target Host view, not the stale session or workspace catalog", () => {
    mocks.configOptions = [
      {
        id: "thought_level",
        name: "Thought Level",
        category: "thought_level",
        type: "select",
        currentValue: "off",
        options: ["off", "low", "medium", "high", "max"].map((value) => ({ value })),
      },
    ];

    mocks.modelSelectionView!.providers[0]!.models.push({
      modelId: "GLM-5.2",
      config: {
        optionSpecs: {
          reasoningLevel: { values: ["low", "high", "max"], map: "{}" },
        },
      },
    });
    renderToolbarMarkup({
      config: {
        provider: "custom-openai",
        model: "GLM-5.2",
        thought: "high",
        thoughtLevels: ["max", "high", "nothink"],
        followupMode: "queue",
        mode: "build",
      },
    });

    expect(captured.modelSelectProps?.composerOptions?.levels.map(({ value }) => value)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it.each([{ thoughtLevels: [] }, { thoughtLevels: ["disabled"] }])(
    "a recovered empty level is not backfilled from the catalog: $thoughtLevels",
    ({ thoughtLevels }) => {
      renderToolbarMarkup({
        config: {
          provider: "custom-openai",
          model: "gpt-4o",
          thought: "",
          thoughtLevels,
          followupMode: "queue",
          mode: "build",
        },
      });
      expect(captured.modelSelectProps?.composerOptions?.value).toBe("");
    },
  );

  it("after draft prewarm completes, the composer selection and Host candidates still show without consuming stale projection levels", () => {
    renderToolbarMarkup({
      draftMode: true,
      draftConfig: {
        mode: "build",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-4o",
          options: { reasoningLevel: "disabled" },
        },
      },
      config: {
        provider: "custom-openai",
        model: "gpt-4o",
        thought: "high",
        thoughtLevels: ["max", "high", "nothink"],
        followupMode: "queue",
        mode: "build",
      },
    });

    expect(captured.modelSelectProps?.composerOptions).toMatchObject({
      value: "disabled",
      levels: [{ value: "disabled" }],
    });
  });

  it("switching the draft target model does not reuse the stale prewarmed projection thought level", () => {
    renderToolbarMarkup({
      draftMode: true,
      config: {
        provider: "custom-openai",
        model: "gpt-4o",
        thought: "high",
        thoughtLevels: ["medium", "high"],
        followupMode: "queue",
        mode: "build",
      },
      draftConfig: {
        modelSelection: { providerId: "custom-openai", modelId: "gpt-4.1" },
      },
    });

    expect(captured.thoughtControlProps).toBeNull();
  });

  it("does not pass derived capacity or plan props for a non-plan model with no usage", () => {
    renderToolbarMarkup({
      usage: null,
    });

    const props = latestUsageProps();
    expect(props).not.toHaveProperty("contextCapacityTokens");
    expect(props.codingPlanUsageRemaining).toBeUndefined();
    expect(props.startPlanBalance).toBeUndefined();
  });

  it("does not build the model menu from a stale provider snapshot before the Registry is published", () => {
    mocks.modelSelectionView = null;
    renderToolbarMarkup();

    expect(captured.modelSelectProps).toBeNull();
  });

  it("passes Coding Plan usage only when the current connection is the selected OAuth Coding Plan", () => {
    addAccountProviderAccess(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      { accountType: "zai", mode: "individual-coding-plan" },
      "Z.ai - Coding Plan",
    );
    mocks.codingPlanEntitlements = {
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        snapshot: createActiveEntitlement(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
        loading: false,
        error: null,
      },
    };

    renderToolbarMarkup({
      config: {
        provider: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        model: "glm-5",
        thought: "medium",
        thoughtLevels: ["medium"],
        followupMode: "queue",
        mode: "build",
      },
      usage: null,
    });
    expect(latestUsageProps().codingPlanUsageRemaining).toBeUndefined();

    captured.usageProps = [];
    mocks.settings = {
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
      },
      providerFamilyDomain: {},
    };
    renderToolbarMarkup({
      config: {
        provider: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        model: "glm-5",
        thought: "medium",
        thoughtLevels: ["medium"],
        followupMode: "queue",
        mode: "build",
      },
      usage: null,
    });

    const props = latestUsageProps();
    expect(props.codingPlanUsageRemaining).toMatchObject({
      selectedProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    });
    expect(props.startPlanBalance).toBeUndefined();
  });

  it("does not derive Coding Plan usage from a legacy provider without Account Access", () => {
    mocks.codingPlanEntitlements = {
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        snapshot: createActiveEntitlement(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
        loading: false,
        error: null,
      },
    };
    mocks.settings = {
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
      },
      providerFamilyDomain: {},
    };

    renderToolbarMarkup({
      config: {
        provider: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        model: "glm-5",
        thought: "medium",
        thoughtLevels: ["medium"],
        followupMode: "queue",
        mode: "build",
      },
      usage: null,
    });

    expect(latestUsageProps().codingPlanUsageRemaining).toBeUndefined();
  });

  it.each([
    undefined,
    { kind: "start-plan" },
    { kind: "individual-coding-plan" },
    { kind: "team-coding-plan", organizationId: "org", projectId: "project", productId: "plan" },
  ] as const)(
    "Start balance follows composer selection independent of saved connection %j",
    (selection) => {
      mocks.codingPlanEntitlements = {
        [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
          snapshot: createActiveEntitlement(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan),
          loading: false,
          error: null,
        },
      };
      mocks.settings = {
        providerFamilyConnectionSelections: {
          zai: selection,
        },
        providerFamilyDomain: {},
      };

      renderToolbarMarkup({
        config: {
          provider: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
          model: "glm-5",
          thought: "medium",
          thoughtLevels: ["medium"],
          followupMode: "queue",
          mode: "build",
        },
        usage: null,
      });

      const props = latestUsageProps();
      expect(props.codingPlanUsageRemaining).toBeUndefined();
      expect(props.startPlanBalance).toMatchObject({
        loading: false,
        snapshot: {
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
          },
        },
      });
    },
  );

  it("does not pass Start Plan balance when the entitlement hook hides fallback balance", () => {
    mocks.codingPlanEntitlements = {
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        snapshot: createActiveEntitlement(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
        loading: false,
        error: null,
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        snapshot: null,
        loading: false,
        error: null,
      },
    };
    mocks.settings = {
      providerFamilyConnectionSelections: {
        zai: { kind: "start-plan" },
      },
      providerFamilyDomain: {},
    };

    renderToolbarMarkup({
      config: {
        provider: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        model: "glm-5",
        thought: "medium",
        thoughtLevels: ["medium"],
        followupMode: "queue",
        mode: "build",
      },
      usage: null,
    });

    expect(latestUsageProps().startPlanBalance).toBeUndefined();
  });

  it("attaches the hover access refresh entry when the Start Plan entitlement is enabled", () => {
    mocks.codingPlanEntitlements = {
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        snapshot: null,
        loading: false,
        error: null,
      },
    };
    mocks.codingPlanEntitlementsEnabledStartPlanIds = [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan];
    mocks.settings = {
      providerFamilyConnectionSelections: {
        zai: { kind: "start-plan" },
      },
      providerFamilyDomain: {},
    };

    renderToolbarMarkup({
      config: {
        provider: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        model: "glm-5",
        thought: "medium",
        thoughtLevels: ["medium"],
        followupMode: "queue",
        mode: "build",
      },
      usage: null,
    });

    const startPlanBalance = latestUsageProps().startPlanBalance as {
      onAccess?: () => unknown;
    };
    // Fix rationale: start plan users previously had no hover onAccess entry, so
    // the context panel never proactively refreshed the daily balance.
    expect(typeof startPlanBalance?.onAccess).toBe("function");
    expect(startPlanBalance.onAccess).not.toBeNull();
  });

  it("recovers a Team Plan usage source from entitlement snapshot when products are not hydrated", () => {
    const teamSourceId = "team:bigmodel:team-pro:org-1:project-1";
    addAccountProviderAccess(BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, {
      accountType: "bigmodel",
      mode: "team-coding-plan",
    });
    mocks.settings = {
      providerFamilyConnectionSelections: {
        bigmodel: {
          kind: "team-coding-plan",
          productId: "team-pro",
          organizationId: "org-1",
          projectId: "project-1",
        },
      },
      providerFamilyDomain: {},
    };
    mocks.codingPlanEntitlements = {
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: {
        snapshot: createActiveEntitlement(BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, {
          context: {
            scope: "team",
            organizationId: "org-1",
            projectId: "project-1",
            productId: "team-pro",
            displayName: "Platform",
          },
          subscription: {
            details: [
              {
                beginTime: "2026-01-01T00:00:00Z",
                expireTime: "2026-12-31T00:00:00Z",
                productId: "team-pro",
                productName: "Platform",
                purchaseTime: "2026-01-01T00:00:00Z",
              },
            ],
          },
        }),
        loading: false,
        error: null,
      },
    };
    mocks.usageEntitlement = {
      snapshot: createActiveEntitlement(BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, {
        context: {
          scope: "team",
          organizationId: "org-1",
          projectId: "project-1",
          productId: "team-pro",
          displayName: "Platform",
        },
      }),
      loading: false,
      error: null,
    };

    renderToolbarMarkup({
      config: {
        provider: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        model: "glm-5",
        thought: "medium",
        thoughtLevels: ["medium"],
        followupMode: "queue",
        mode: "build",
      },
      usage: null,
    });

    expect(latestUsageProps().codingPlanUsageRemaining).toMatchObject({
      selectedProviderId: teamSourceId,
    });
  });

  it("routes custom model selection to the recovery callback when configOptions failed", async () => {
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: null,
          phase: null,
          draftConfig: {
            mode: "build",
            modelSelection: {
              providerId: "primary-provider",
              modelId: "source-model",
              options: { reasoningLevel: "high" },
            },
          },
          config: {
            provider: "primary-provider",
            model: "source-model",
            thought: "high",
            thoughtLevels: ["high"],
            followupMode: "queue",
            mode: "build",
          },
          draftMode: true,
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
          onRecoverCustomModelSelection: mocks.recoverCustomModelSelection,
        }),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      captured.modelSelectProps?.onValueChange(customValue);
      await flushMicrotasks();
    });

    expect(mocks.recoverCustomModelSelection).toHaveBeenCalledWith(customValue, {
      provider: "primary-provider",
      model: "source-model",
    });
    expect(mocks.selectModel).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not expose a legacy-only provider after an empty Registry view is published", async () => {
    mocks.modelSelectionView = { revision: 1, providers: [] };
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: null,
          phase: null,
          config: {
            provider: "primary-provider",
            model: "source-model",
            thought: "high",
            thoughtLevels: ["high"],
            followupMode: "queue",
            mode: "build",
          },
          draftMode: true,
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
          onRecoverCustomModelSelection: mocks.recoverCustomModelSelection,
        }),
      );
      await flushMicrotasks();
    });

    expect(captured.modelSelectProps).toBeNull();
    expect(mocks.recoverCustomModelSelection).not.toHaveBeenCalled();
    expect(mocks.selectModel).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not route builtin model selection through custom recovery when configOptions failed", async () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    mocks.modelSelectionView = {
      revision: 2,
      providers: [
        {
          providerId,
          providerName: "BigModel Coding",
          config: {
            access: {
              type: "zhipu-account",
            },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://open.bigmodel.cn/api/anthropic",
            },
            models: ["glm-5"],
          },
          models: [{ modelId: "glm-5", config: completeDisabledModelConfig() }],
        },
      ],
    };
    const value = `custom:${encodeURIComponent(providerId)}:glm-5`;
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: null,
          phase: null,
          config: null,
          draftMode: true,
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
          onRecoverCustomModelSelection: mocks.recoverCustomModelSelection,
        }),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      captured.modelSelectProps?.onValueChange(value);
      await flushMicrotasks();
    });

    expect(mocks.recoverCustomModelSelection).not.toHaveBeenCalled();
    expect(mocks.selectModel).toHaveBeenCalledWith(providerId, "glm-5", null);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not write a menu-first fallback when a session model is absent from the visible catalog", async () => {
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(V4ComposerModelControls, {
          workspacePath: "/workspace",
          modelSelectionView: mocks.modelSelectionView,
          sessionId: "session-removed-model",
          phase: "completedSuccess",
          config: {
            provider: "removed-provider",
            model: "removed-model",
            thought: "high",
            thoughtLevels: ["high"],
            followupMode: "queue",
            mode: "build",
          },
          usage: null,
          disabled: false,
          onSelectModel: mocks.selectModel,
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
        }),
      );
      await flushMicrotasks();
    });

    expect(mocks.selectModel).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});

it("after a display failure, retrying the current connection is allowed instead of returning early on the selected key", () => {
  mocks.connectionSwitchError = "retry";
  renderToolbarMarkup();
  const menu = captured.modelSelectProps?.composerOptions?.providerMenu;
  expect(menu).toBeDefined();
  const selected = menu!.groups.find((group) => group.key === menu!.selectedKey)!;
  expect(selected).toBeDefined();
  menu!.onSelect(selected);
  expect(mocks.selectConnection).toHaveBeenCalledTimes(1);
});

it("after team usage is cached, clearing only the user while the provider stays ready hides the stale source immediately and disables requests", async () => {
  const { useUsageEntitlement } = await import("@/hooks/useUsageEntitlement.js");
  const provider = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
  addAccountProviderAccess(provider, { accountType: "bigmodel", mode: "team-coding-plan" });
  mocks.settings = {
    providerFamilyDomain: "bigmodel",
    providerFamilyConnectionSelections: {
      bigmodel: {
        kind: "team-coding-plan",
        productId: "team-pro",
        organizationId: "org-1",
        projectId: "project-1",
      },
    },
  };
  mocks.codingPlanEntitlements = {
    [provider]: {
      snapshot: createActiveEntitlement(provider, {
        context: {
          scope: "team",
          productId: "team-pro",
          organizationId: "org-1",
          projectId: "project-1",
          displayName: "Private Team",
        },
      }),
      loading: false,
      error: null,
    },
  };
  mocks.usageEntitlement = {
    snapshot: createActiveEntitlement(provider, {
      context: {
        scope: "team",
        productId: "team-pro",
        organizationId: "org-1",
        projectId: "project-1",
        displayName: "Private Team",
      },
    }),
    loading: false,
    error: null,
  };
  const root = createRoot(installMinimalDom());
  const props = {
    draftConfig: {
      mode: "build" as const,
      modelSelection: { providerId: provider, modelId: "glm-5" },
    },
    workspacePath: "/workspace",
    sessionId: null,
    phase: null,
    config: {
      provider,
      model: "glm-5",
      thought: "medium",
      thoughtLevels: ["medium"],
      followupMode: "queue" as const,
      mode: "build" as const,
    },
    usage: null,
    disabled: false,
    onSelectModel: mocks.selectModel,
    onSelectThought: vi.fn(),
    onSwitchMode: vi.fn(),
  };
  try {
    await act(async () => root.render(createElement(V4ComposerModelControls, props)));
    expect(latestUsageProps().codingPlanUsageRemaining).toBeDefined();
    mocks.auth.user = null;
    await act(async () =>
      root.render(
        createElement(V4ComposerModelControls, { ...props, config: { ...props.config } }),
      ),
    );
    expect(latestUsageProps().codingPlanUsageRemaining).toBeUndefined();
    expect(useUsageEntitlement).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, accountAccess: undefined }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
