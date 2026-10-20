// @vitest-environment jsdom
import { createElement } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPortal } from "react-dom";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
  TID_MODEL_PROVIDER_NAME_EDIT_BUTTON,
  TID_MODEL_PROVIDER_NAME_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectedCopy } from "./helpers/uiCopy.js";
import {
  InlineEditableProviderCard,
  PROVIDER_TEXT_INPUT_IDLE_SAVE_MS,
  shouldApplyProviderSaveCompletion,
} from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import {
  formatModelContextWindowLabel,
  ProviderModelsSection,
} from "@/settings/model-provider-section/ProviderCardSections.js";
import { ModelRowInput } from "@/settings/model-provider-section/ProviderFormControls.js";
import { confirmAndDeleteModelProvider } from "@/settings/model-provider-section/modelProviderActions.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import {
  isInteractiveModelDragTarget,
  resolveReorderedModelIds,
  SortableProviderModelList,
} from "@/settings/model-provider-section/SortableProviderModelList.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
        const messages: Record<string, string> = {
          "settings.modelProvider.addModel": "Add model",
          "model.capability.vision": "Vision",
          "settings.modelProvider.contextWindow": "Context window",
          "settings.modelProvider.contextWindowBadgeLabel": "Context window: {value}",
          "settings.modelProvider.delete": "Delete",
          "settings.modelProvider.disableAction": "Disable",
          "settings.modelProvider.enableAction": "Enable",
          "settings.modelProvider.restoreDefaultAction": "Restore default",
          "settings.modelProvider.followRecommendedConfig": "Smart configuration",
          "settings.modelProvider.editModel": "Edit model settings",
          "settings.modelProvider.apiFormat": "API format",
          "settings.modelProvider.apiFormat.anthropicMessages": "Anthropic Messages (/v1/messages)",
          "settings.modelProvider.apiFormat.chatCompletions":
            "Chat Completions (/chat/completions)",
          "settings.modelProvider.apiFormat.responses": "Responses (/responses)",
          "settings.modelProvider.apiFormat.short.anthropicMessages": "Anthropic",
          "settings.modelProvider.apiFormat.short.chatCompletions": "Chat",
          "settings.modelProvider.apiFormat.short.responses": "Responses",
          "settings.modelProvider.apiFormat.title.anthropicMessages": "Anthropic Messages",
          "settings.modelProvider.baseUrl": "Base URL",
          "settings.modelProvider.baseUrlPlaceholder": "https://api.example.com",
          "settings.modelProvider.readOnlyField": "{field} (read only)",
          "settings.modelProvider.maxOutputTokens": "Max output tokens",
          "settings.modelProvider.inputModalities": "Input types",
          "settings.modelProvider.outputModalities": "Output types",
          "settings.modelProvider.modelDisplayName": "Display name",
          "settings.modelProvider.modelId": "Model ID",
          "settings.modelProvider.modelApiFormat.anthropic": "Anthropic Messages",
          "settings.modelProvider.modelApiFormat.openaiCompatible": "OpenAI Compatible",
          "settings.modelProvider.modelApiFormat.openaiResponses": "OpenAI Responses",
          "settings.modelProvider.models": "Model list",
          "settings.modelProvider.modelsEmpty":
            "No models are configured. Add a model to use it in chat.",
          "settings.modelProvider.testModel": "Test model",
          "settings.modelProvider.testModel.connectingWithIdentity": "Testing {provider} / {model}",
          "settings.modelProvider.testModel.successWithIdentity": "{provider} / {model} connected",
          "settings.modelProvider.testModel.failedWithIdentity":
            "Failed to connect {provider} / {model}: {reason}",
          "settings.modelProvider.providerSaving": "Saving {provider}",
          "settings.modelProvider.providerSaveSuccess": "{provider} saved",
          "settings.modelProvider.providerSaveFailure": "Failed to save {provider}: {error}",
          "settings.modelProvider.modelSaving": "Saving {provider} / {model}",
          "settings.modelProvider.modelSaveSuccess": "{provider} / {model} saved",
          "settings.modelProvider.modelSaveFailure": "Failed to save {provider} / {model}: {error}",
          "common.retry": "Retry",
          "common.close": "Close",
          "common.save": "Save",
          "common.cancel": "Cancel",
        };
        return (messages[id] ?? id).replace(
          /\{(\w+)\}/g,
          (_match, key: string) => values?.[key] ?? `{${key}}`,
        );
      },
    },
  }),
}));

const settingsService = vi.hoisted(() => ({ resolveModelConfig: vi.fn() }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService: settingsService }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    openExternal: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function renderWithProviderFeedback(element: React.ReactNode) {
  return render(createElement(ProviderDetailFeedbackBoundary, null, element));
}

function createModelProviderModelConfig(input: {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsJsonSchemaOutput?: boolean;
}): ProviderSettingsFormProvider["models"][number] {
  const maxOutputTokens = input.maxOutputTokens ?? 32_000;
  const config = {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: input.contextWindow ?? 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: input.supportsTools ?? true,
      supportsJsonSchemaOutput: input.supportsJsonSchemaOutput ?? true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: maxOutputTokens,
        map: "{'max_tokens': maxOutputTokens}",
      },
    },
  };
  return {
    kind: "candidate",
    modelId: input.id,
    builtin: false,
    personalConfig: structuredClone(config),
    hasPersonalConfig: true,
    executable: true,
    selectable: true,
    config,
  };
}

function createProvider(
  overrides: Partial<ProviderSettingsFormProvider> = {},
): ProviderSettingsFormProvider {
  return {
    providerId: "provider-deepseek",
    providerName: "DeepSeek",
    executable: true,
    enabled: true,
    hasPersonalConfig: true,
    personalConfig: {
      access: { type: "api-key", apiKey: "sk-demo" },
      api: { type: "anthropic-messages", baseUrl: "https://api.deepseek.com" },
      personalModelIds: ["deepseek-v4-flash"],
      enabled: true,
    },
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-demo" },
      api: { type: "anthropic-messages", baseUrl: "https://api.deepseek.com" },
      personalModelIds: ["deepseek-v4-flash"],
      enabled: true,
    },
    models: [
      createModelProviderModelConfig({
        id: "deepseek-v4-flash",
        kinds: ["anthropic", "openai-compatible"],
      }),
    ],
    ...overrides,
  };
}

describe("ProviderModelsSection compact model rows", () => {
  it.each(["individual-coding-plan", "team-coding-plan", "start-plan", "manual", "standard"])(
    "settings page shares the vision-badge decision, connection=%s",
    (mode) => {
      const provider = createProvider();
      provider.config.access =
        mode === "manual"
          ? { type: "zhipu-coding-plan-api-key", apiKey: "fixture" }
          : mode === "standard"
            ? { type: "api-key", apiKey: "fixture" }
            : {
                type: "zhipu-account",
                accountType: "bigmodel",
                mode: mode as "individual-coding-plan" | "team-coding-plan" | "start-plan",
              };
      provider.models = ["GLM-5.3", "GLM-5.3-Flash"].map((id) => {
        const model = createModelProviderModelConfig({ id });
        model.config.properties!.inputFormat = {
          ...model.config.properties?.inputFormat,
          supportsImage: true,
        };
        return model;
      });
      render(
        createElement(InlineEditableProviderCard, {
          provider,
          onSave: vi.fn(),
        }),
      );
      expect(screen.getAllByText(expectedCopy("model.capability.vision"))).toHaveLength(
        mode === "standard" ? 2 : 1,
      );
      expect(provider.models[0]!.config.properties?.inputFormat?.supportsImage).toBe(true);
    },
  );
  it("switching providers must not reuse the previous provider's edit session even for the same model ID", async () => {
    const initial = createProvider();
    const view = render(
      createElement(InlineEditableProviderCard, {
        provider: initial,
        onSave: vi.fn(),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: expectedCopy("settings.modelProvider.editModel"),
      }),
    );
    fireEvent.change(document.querySelector('input[inputmode="numeric"]')!, {
      target: { value: "123456" },
    });
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: { ...initial, providerId: "other-provider" },
        onSave: vi.fn(),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: expectedCopy("settings.modelProvider.editModel"),
      }),
    );
    expect(
      (document.querySelector('input[inputmode="numeric"]') as HTMLInputElement).value,
    ).not.toBe("123456");
  });
  it("Todo138: a new empty ID has no tier chips; after resolution the recommended chips appear, and clearing the ID restores the empty draft", async () => {
    const config = createModelProviderModelConfig({ id: "new-model" }).config;
    settingsService.resolveModelConfig.mockResolvedValue({
      inheritedConfig: config,
      effectiveConfig: config,
      issues: [],
      revision: 1,
    });
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({ models: [] }),
        onSave: vi.fn(),
        onAddPersonalModel: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON));
    const chips = () => document.querySelectorAll("[data-model-reasoning-chip]");
    expect(chips()).toHaveLength(0);
    expect(settingsService.resolveModelConfig).not.toHaveBeenCalled();
    const id = document.querySelector("[data-model-identity-row] input")!;
    fireEvent.change(id, { target: { value: "new-model" } });
    fireEvent.blur(id);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]?.textContent).toContain("disabled");
    const calls = settingsService.resolveModelConfig.mock.calls.length;
    fireEvent.change(id, { target: { value: "" } });
    fireEvent.blur(id);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(settingsService.resolveModelConfig).toHaveBeenCalledTimes(calls);
  });
  it("adding waits for the real save; a failure keeps the draft and allows retry", async () => {
    const config = createModelProviderModelConfig({ id: "new-model" }).config;
    settingsService.resolveModelConfig.mockResolvedValue({
      inheritedConfig: config,
      effectiveConfig: config,
      issues: [],
      revision: 1,
    });
    let rejectSave!: (error: Error) => void;
    const onAddModel = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({ models: [] }),
        onSave: vi.fn(),
        onAddPersonalModel: () => onAddModel(),
      }),
    );
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON));
    fireEvent.change(document.querySelector('[data-model-identity-row="true"] input')!, {
      target: { value: "new-model" },
    });
    fireEvent.blur(document.querySelector('[data-model-identity-row="true"] input')!);
    await waitFor(() => expect(settingsService.resolveModelConfig).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", {
        name: expectedCopy("common.save"),
        exact: true,
      }),
    );
    await waitFor(() => expect(onAddModel).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-model-identity-row="true"] input')).not.toBeNull();
    await act(async () => {
      rejectSave(new Error("disk write failed"));
    });
    expect(screen.getByText("disk write failed")).not.toBeNull();
    expect(
      screen.queryByRole("button", {
        name: expectedCopy("common.retry"),
        exact: true,
      }),
    ).toBeNull();
    expect(
      (document.querySelector('[data-model-identity-row="true"] input') as HTMLInputElement).value,
    ).toBe("new-model");
    onAddModel.mockResolvedValueOnce();
    fireEvent.click(
      screen.getByRole("button", {
        name: expectedCopy("common.save"),
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-model-identity-row="true"] input')).toBeNull(),
    );
    expect(onAddModel).toHaveBeenCalledTimes(2);
  });
  it("Todo89: a View refresh must not drop the edit draft; a conflict keeps the input, and only reopening reads the new baseline", async () => {
    const model = createModelProviderModelConfig({ id: "draft-model" });
    const onCommit = vi.fn().mockRejectedValue(new Error("revision conflict"));
    const props = { model, providerId: "test", onCommit, settingsRevision: 7 };
    const rendered = renderWithProviderFeedback(createElement(ModelRowInput, props));
    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    fireEvent.change(document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!, {
      target: { value: "123456" },
    });
    rendered.rerender(
      createElement(
        ProviderDetailFeedbackBoundary,
        null,
        createElement(ModelRowInput, {
          ...props,
          model: structuredClone(model),
          settingsRevision: 8,
        }),
      ),
    );
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.save") }));
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(onCommit.mock.calls[0]?.[1]).toBe(7);
    expect(await screen.findByText("revision conflict")).toBeTruthy();
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.cancel") }));
    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("200000");
  });

  it("Todo89: an incomplete model keeps the repair, enable/disable, and personal-member delete entries", () => {
    const model = createModelProviderModelConfig({ id: "broken" });
    model.config = {};
    model.personalConfig = {};
    model.executable = false;
    render(
      createElement(ProviderModelsSection, {
        providerId: "test",
        models: [model],
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );
    expect(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel"))).toBeTruthy();
    expect(screen.getByRole("switch")).toBeTruthy();
    expect(screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0"))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    expect(
      (document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')! as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("keeps the original sparse overlay for an untouched Model Draft and never fabricates default false values", () => {
    const inherited = createModelProviderModelConfig({ id: "draft-model" });
    inherited.config.optionSpecs = {
      reasoningLevel: {
        values: ["low", "high"],
        map: "{'effort': reasoningLevel}",
      },
      maxOutputTokens: inherited.config.optionSpecs.maxOutputTokens,
    };
    const model = {
      ...inherited,
      personalConfig: {
        properties: { inputFormat: { supportsPdf: true } },
        optionSpecs: { reasoningLevel: { map: null } },
      },
      hasPersonalConfig: true,
      inheritedConfig: structuredClone(inherited.config),
      config: {
        ...inherited.config,
        properties: {
          ...inherited.config.properties,
          inputFormat: {
            ...inherited.config.properties.inputFormat,
            supportsPdf: true,
          },
        },
        optionSpecs: {
          ...inherited.config.optionSpecs,
          reasoningLevel: {
            ...inherited.config.optionSpecs?.reasoningLevel,
            map: null,
          },
        },
      },
    };

    const result = resolveProviderModelDraftCommit({
      currentModel: model,
      draft: createProviderModelDraftValues(model),
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig).toEqual({
      properties: { inputFormat: { supportsPdf: true } },
    });
    expect(result.model.personalConfig).not.toHaveProperty("requiresMfjsToolSchema");
    expect(result.model.personalConfig.properties?.requiresMfjsToolSchema).toBeUndefined();
    expect(result.model.personalConfig.properties?.inputFormat?.supportsPdf).toBe(true);
  });

  it("only the save response of the current Draft revision may update the feedback", () => {
    expect(shouldApplyProviderSaveCompletion(3, 3)).toBe(true);
    expect(shouldApplyProviderSaveCompletion(4, 3)).toBe(false);
  });

  it("a successful model connection shows the full identity in the provider detail bottom banner", async () => {
    const model = createModelProviderModelConfig({ id: "deepseek-v4-flash" });
    renderWithProviderFeedback(
      createElement(ModelRowInput, {
        providerId: "deepseek",
        model,
        onCommit: vi.fn(async () => undefined),
        onTest: vi.fn(async () => ({ success: true as const })),
      }),
    );

    fireEvent.click(screen.getByTitle(expectedCopy("settings.modelProvider.testModel")));

    expect(
      screen.getByText(
        expectedCopy("settings.modelProvider.testModel.connectingWithIdentity", {
          provider: "deepseek",
          model: "deepseek-v4-flash",
        }),
      ),
    ).toBeTruthy();
    await screen.findByText(
      expectedCopy("settings.modelProvider.testModel.successWithIdentity", {
        provider: "deepseek",
        model: "deepseek-v4-flash",
      }),
    );
    expect(screen.getByTestId("provider-detail-feedback-viewport")).toBeTruthy();
    expect(screen.queryByText("Connected!")).toBeNull();
    expect(screen.getByRole("status").className).toContain("bg-success/10");
    expect(screen.getByRole("status").className).toContain("text-success");
    expect(screen.getByRole("status").querySelector("button")).not.toBeNull();
  });

  it.each(["success", "failure", "throw"])(
    "connection test %s uses the display name and keeps the identity arguments",
    async (outcome) => {
      const provider = createProvider();
      const onTestModel = vi.fn(async () => {
        if (outcome === "throw") throw new Error("network-error");
        return outcome === "success"
          ? { success: true as const }
          : { success: false as const, error: { message: "auth-error" } };
      });
      renderWithProviderFeedback(
        createElement(InlineEditableProviderCard, {
          provider,
          onSave: vi.fn(),
          onTestModel,
        }),
      );
      fireEvent.click(screen.getAllByTitle(expectedCopy("settings.modelProvider.testModel"))[0]!);
      expect(screen.getByText(/Testing DeepSeek/)).toBeTruthy();
      await waitFor(() =>
        expect(
          screen.getByText(
            outcome === "success" ? /DeepSeek .* connected/ : /Failed to connect DeepSeek/,
          ),
        ).toBeTruthy(),
      );
      expect(onTestModel).toHaveBeenCalledWith(provider.providerId, provider.models[0]!.modelId);
    },
  );

  it("testing stays unavailable while the provider is disabled; re-enabling keeps the test affordance", async () => {
    const provider = createProvider({ enabled: false });
    const onTestModel = vi.fn(async () => ({ success: true as const }));
    const onSave = vi.fn();
    const mounted = renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider,
        onSave,
        onTestModel,
      }),
    );
    const testButton = screen.getAllByTitle(
      "settings.modelProvider.testModel.enableProviderFirst",
    )[0] as HTMLButtonElement;
    expect(testButton.disabled).toBe(true);
    fireEvent.click(testButton);
    expect(onTestModel).not.toHaveBeenCalled();
    mounted.rerender(
      createElement(
        ProviderDetailFeedbackBoundary,
        null,
        createElement(InlineEditableProviderCard, {
          provider: { ...provider, enabled: true },
          onSave,
          onTestModel,
        }),
      ),
    );
    fireEvent.click(screen.getAllByTitle(expectedCopy("settings.modelProvider.testModel"))[0]!);
    await waitFor(() => expect(onTestModel).toHaveBeenCalledTimes(1));
  });

  it("a test after a provider rename uses the new name and falls back to the identity without one", async () => {
    const onTestModel = vi.fn(async () => ({ success: true as const }));
    const onSave = vi.fn();
    const provider = createProvider();
    const mounted = renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider,
        onSave,
        onTestModel,
      }),
    );
    for (const name of ["Account Plan", "Renamed", ""]) {
      mounted.rerender(
        createElement(
          ProviderDetailFeedbackBoundary,
          null,
          createElement(InlineEditableProviderCard, {
            provider: { ...provider, providerName: name },
            onSave,
            onTestModel,
          }),
        ),
      );
      fireEvent.click(screen.getAllByTitle(expectedCopy("settings.modelProvider.testModel"))[0]!);
      expect(
        await screen.findByText(
          expectedCopy("settings.modelProvider.testModel.successWithIdentity", {
            provider: name || provider.providerId,
            model: provider.models[0]!.modelId,
          }),
        ),
      ).toBeTruthy();
    }
    expect(onTestModel.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [provider.providerId, provider.models[0]!.modelId]),
    );
  });

  it.each(["provider-unavailable", "model-unavailable"] as const)(
    "eligibility error %s uses the localized notice",
    async (code) => {
      renderWithProviderFeedback(
        createElement(ModelRowInput, {
          providerId: "p",
          model: createModelProviderModelConfig({ id: "m" }),
          onCommit: vi.fn(),
          onTest: vi.fn(async () => ({
            success: false as const,
            error: { code, message: "fallback" },
          })),
        }),
      );
      fireEvent.click(screen.getByTitle(expectedCopy("settings.modelProvider.testModel")));
      expect(
        await screen.findByText(
          expectedCopy("settings.modelProvider.testModel.failedWithIdentity", {
            provider: "p",
            model: "m",
            reason: `settings.modelProvider.testModel.${
              code === "provider-unavailable" ? "providerUnavailable" : "modelUnavailable"
            }`,
          }),
        ),
      ).toBeTruthy();
    },
  );

  it("no dirty state is shown; saving and success replace each other by the same key in the provider detail column", async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave,
      }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    expect(baseUrl.getAttribute("data-testid")).toBe(TID_MODEL_PROVIDER_BASE_URL_INPUT);
    expect(screen.getByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER)).toBeTruthy();

    fireEvent.change(baseUrl, {
      target: { value: "https://next.example.com" },
    });
    expect(screen.queryByTestId("model-provider-save-status")).toBeNull();
    fireEvent.blur(baseUrl);
    expect(screen.queryByTestId("model-provider-save-status")).toBeNull();
    expect(
      screen.getByText(
        expectedCopy("settings.modelProvider.providerSaving", {
          provider: "DeepSeek",
        }),
      ),
    ).toBeTruthy();
    resolveSave?.();

    await screen.findByText(
      expectedCopy("settings.modelProvider.providerSaveSuccess", {
        provider: "DeepSeek",
      }),
    );
    expect(
      screen.queryByText(
        expectedCopy("settings.modelProvider.providerSaving", {
          provider: "DeepSeek",
        }),
      ),
    ).toBeNull();
  });

  it("provider text inputs auto-save after an idle pause; blur flushes and does not double-submit", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => undefined);
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave,
      }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    fireEvent.change(baseUrl, {
      target: { value: "https://idle.example.com" },
    });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS - 1);
    });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0].config.api?.baseUrl).toBe("https://idle.example.com");

    fireEvent.blur(baseUrl);
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("API key saves when idle; the name requires explicit confirmation and IME completion does not auto-save", async () => {
    vi.useFakeTimers();
    const apiKeySave = vi.fn(async () => undefined);
    const apiKeyView = render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave: apiKeySave,
      }),
    );
    fireEvent.change(screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT), {
      target: { value: "sk-idle" },
    });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(apiKeySave.mock.calls[0]?.[0].config.access).toMatchObject({
      apiKey: "sk-idle",
    });
    apiKeyView.unmount();

    const nameSave = vi.fn(async () => undefined);
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave: nameSave,
        nameEditable: true,
      }),
    );
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), {
      key: "Enter",
    });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const nameInput = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    fireEvent.compositionStart(nameInput);
    fireEvent.change(nameInput, {
      target: { value: "DeepSeek Idle" },
    });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(nameSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(nameInput);
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(nameSave).not.toHaveBeenCalled();
    fireEvent.blur(nameInput);
    expect(nameSave.mock.calls[0]?.[0].providerName).toBe("DeepSeek Idle");
    expect(nameSave.mock.calls[0]?.[0].providerNameUpdate).toBe("DeepSeek Idle");
  });

  it("after Esc cancels the name, neither blur, idle, nor unmount saves; key auto-save must not carry the name", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async () => undefined);
    const view = render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave,
      }),
    );
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), {
      key: "Enter",
    });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const input = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    fireEvent.change(input, { target: { value: "Cancelled" } });
    fireEvent.change(screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT), {
      target: { value: "sk-confirmed" },
    });
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("providerNameUpdate");
    expect(onSave.mock.calls[0]?.[0].config.access.apiKey).toBe("sk-confirmed");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await act(async () => {
      vi.advanceTimersByTime(PROVIDER_TEXT_INPUT_IDLE_SAVE_MS);
    });
    view.unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("a committed Enter confirms the name exactly once; a blank title and the more menu do not toggle enablement", async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave,
      }),
    );
    const toggle = screen.getByTestId("model-provider-enabled-switch");
    expect(toggle.closest("label")).toBeNull();
    fireEvent.click(screen.getByTestId("model-provider-header"));
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), {
      key: "Enter",
    });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const input = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    input.focus();
    fireEvent.change(input, { target: { value: "Confirmed" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      providerNameUpdate: "Confirmed",
      enabled: true,
    });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("enabledUpdate");
  });

  it.each([false, true])(
    "menu delete still goes through the existing confirmation, confirmed=%s",
    async (confirmed) => {
      const provider = createProvider();
      const confirmDialog = vi.fn(async () => confirmed);
      const deleteProvider = vi.fn(async () => undefined);
      const intl = {
        formatMessage: ({ id }: { id: string }) => id,
      } as Parameters<typeof confirmAndDeleteModelProvider>[0]["intl"];
      const onSave = vi.fn(async () => undefined);
      render(
        createElement(InlineEditableProviderCard, {
          provider,
          onSave,
          onDelete: () =>
            confirmAndDeleteModelProvider({
              provider,
              confirmDialog,
              deleteProvider,
              intl,
            }),
        }),
      );
      fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), {
        key: "Enter",
      });
      fireEvent.click(screen.getByRole("menuitem", { name: "common.delete" }));
      await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
      expect(deleteProvider).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      if (confirmed) expect(deleteProvider).toHaveBeenCalledWith(provider.providerId);
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it("a failed name save can retry the same confirmation; switching providers does not resend the unconfirmed name", async () => {
    const onSave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue();
    const provider = createProvider();
    const view = renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, { provider, onSave }),
    );
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), {
      key: "Enter",
    });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    const input = screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT);
    fireEvent.change(input, { target: { value: "Retry name" } });
    fireEvent.blur(input);
    await screen.findByText(
      expectedCopy("settings.modelProvider.providerSaveFailure", {
        provider: "DeepSeek",
        error: "disk full",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.retry") }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[0]?.[0]).toEqual(onSave.mock.calls[1]?.[0]);
    fireEvent.keyDown(screen.getByTestId("model-provider-actions-button"), {
      key: "Enter",
    });
    fireEvent.click(screen.getByTestId(TID_MODEL_PROVIDER_NAME_EDIT_BUTTON));
    fireEvent.change(screen.getByTestId(TID_MODEL_PROVIDER_NAME_INPUT), {
      target: { value: "Discard on switch" },
    });
    view.rerender(
      createElement(
        ProviderDetailFeedbackBoundary,
        null,
        createElement(InlineEditableProviderCard, {
          provider: createProvider({
            providerId: "other",
            providerName: "Other",
          }),
          onSave,
        }),
      ),
    );
    expect(screen.queryByTestId(TID_MODEL_PROVIDER_NAME_INPUT)).toBeNull();
    view.unmount();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("an external View update keeps dirty fields and refreshes untouched ones", () => {
    const initial = createProvider();
    const view = render(
      createElement(InlineEditableProviderCard, {
        provider: initial,
        onSave: vi.fn(),
      }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com") as HTMLInputElement;

    fireEvent.change(baseUrl, {
      target: { value: "https://draft.example.com" },
    });
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({
          personalConfig: {
            ...initial.personalConfig,
            access: { type: "api-key", apiKey: "sk-external" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://external.example.com",
            },
          },
          config: {
            ...initial.config,
            access: { type: "api-key", apiKey: "sk-external" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://external.example.com",
            },
          },
        }),
        onSave: vi.fn(),
      }),
    );

    expect(baseUrl.value).toBe("https://draft.example.com");
    expect((screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT) as HTMLInputElement).value).toBe(
      "sk-external",
    );
  });

  it("pressing Enter on Base URL ends editing and submits the full draft", async () => {
    const onSave = vi.fn(async () => {});
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave,
      }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    baseUrl.focus();
    fireEvent.change(baseUrl, {
      target: { value: "https://enter.example.com" },
    });
    fireEvent.keyDown(baseUrl, { key: "Enter" });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].config.api?.baseUrl).toBe("https://enter.example.com");
  });

  it("Enter confirming a candidate in an IME must not submit Base URL", async () => {
    const onSave = vi.fn(async () => {});
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave,
      }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    baseUrl.focus();
    fireEvent.change(baseUrl, {
      target: { value: "https://中文.example.com" },
    });
    fireEvent.compositionStart(baseUrl);
    fireEvent.keyDown(baseUrl, { key: "Enter" });

    await act(async () => undefined);
    expect(onSave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(baseUrl);

    fireEvent.compositionEnd(baseUrl);
    fireEvent.keyDown(baseUrl, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it("a Template instance shows the frozen endpoint and schema while keeping the API key and model config", () => {
    const provider = createProvider({
      config: {
        ...createProvider().config,
        group: "standard-personal",
        templateId: "deepseek",
      },
    });
    render(
      createElement(InlineEditableProviderCard, {
        provider,
        onSave: vi.fn(),
        readOnlyEndpoints: true,
        nameEditable: false,
      }),
    );

    expect(screen.queryByTestId(TID_MODEL_PROVIDER_BASE_URL_INPUT)).toBeNull();
    expect(screen.queryByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER)).toBeNull();
    expect(screen.getByText("https://api.deepseek.com")).toBeTruthy();
    expect(screen.getByText("Anthropic Messages (/v1/messages)")).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: expectedCopy("settings.modelProvider.readOnlyField", {
          field: expectedCopy("settings.modelProvider.baseUrl"),
        }),
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: expectedCopy("settings.modelProvider.readOnlyField", {
          field: expectedCopy("settings.modelProvider.apiFormat"),
        }),
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("model-provider-name-edit-button")).toBeNull();
    expect(screen.queryByTestId("model-provider-actions-button")).toBeNull();
    expect(screen.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT)).toBeTruthy();
    expect(screen.getByText("deepseek-v4-flash")).toBeTruthy();
  });

  it("a save failure replaces the bottom saving banner, extends its stay, and offers retry", async () => {
    const onSave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce();
    renderWithProviderFeedback(
      createElement(InlineEditableProviderCard, {
        provider: createProvider(),
        onSave,
      }),
    );
    const baseUrl = screen.getByPlaceholderText("https://api.example.com");

    fireEvent.change(baseUrl, {
      target: { value: "https://next.example.com" },
    });
    fireEvent.blur(baseUrl);
    await screen.findByText(
      expectedCopy("settings.modelProvider.providerSaveFailure", {
        provider: "DeepSeek",
        error: "disk full",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.retry") }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });

  it("derives the new order from the dragged model IDs", () => {
    expect(
      resolveReorderedModelIds({
        activeModelId: "model-b",
        overModelId: "model-a",
        modelIds: ["model-a", "model-b", "model-c"],
      }),
    ).toEqual(["model-b", "model-a", "model-c"]);
  });

  it("the model name can start a whole-row drag; real interactive controls must not trigger it", () => {
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    const name = document.createElement("span");
    const action = document.createElement("button");
    row.append(name, action);

    expect(isInteractiveModelDragTarget(name)).toBe(false);
    expect(isInteractiveModelDragTarget(action)).toBe(true);
  });

  it("a model dialog or overlay bubbling through a Portal to the model row must not start a background drag", () => {
    const dialog = document.createElement("section");
    dialog.setAttribute("data-slot", "dialog-content");
    const dialogBlankArea = document.createElement("div");
    dialog.append(dialogBlankArea);
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");

    expect(isInteractiveModelDragTarget(dialogBlankArea)).toBe(true);
    expect(isInteractiveModelDragTarget(overlay)).toBe(true);
  });

  it.each(["input", "textarea", "select", "button", "a", "editable", "portal"])(
    "Space inside %s must not start a background model drag",
    (kind) => {
      const target =
        kind === "portal"
          ? createPortal(
              createElement("section", {
                "data-slot": "dialog-content",
                "data-testid": "key-target",
              }),
              document.body,
            )
          : createElement(kind === "editable" ? "div" : kind, {
              "data-testid": "key-target",
              ...(kind === "editable" ? { contentEditable: true } : {}),
            });
      const onReorder = vi.fn();
      render(
        createElement(SortableProviderModelList, {
          modelIds: ["one", "two"],
          onReorder,
          renderModel: (id) => (id === "one" ? target : id),
        }),
      );
      const control = screen.getByTestId("key-target");
      expect(fireEvent.keyDown(control, { key: " ", code: "Space" })).toBe(true);
      expect(
        screen
          .getAllByLabelText("settings.modelProvider.reorderModel")[0]!
          .getAttribute("aria-pressed"),
      ).not.toBe("true");
      expect(onReorder).not.toHaveBeenCalled();
    },
  );

  it("Space on the model row itself still starts the keyboard drag", () => {
    const onReorder = vi.fn();
    render(
      createElement(SortableProviderModelList, {
        modelIds: ["one", "two"],
        onReorder,
        renderModel: (id) => id,
      }),
    );
    const row = screen.getAllByLabelText("settings.modelProvider.reorderModel")[0]!;
    expect(fireEvent.keyDown(row, { key: " ", code: "Space" })).toBe(false);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("model rows show the vision marker by image capability, not by guessing from the model id", () => {
    const model = createModelProviderModelConfig({
      id: "unknown-vision-model",
    });
    model.config.properties!.inputFormat!.supportsImage = true;
    const { rerender } = render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model,
        onCommit: vi.fn(),
      }),
    );
    expect(screen.getByLabelText(expectedCopy("model.capability.vision"))).toBeTruthy();
    const textOnly = createModelProviderModelConfig({ id: "GLM-5.3" });
    rerender(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: textOnly,
        onCommit: vi.fn(),
      }),
    );
    expect(screen.queryByLabelText(expectedCopy("model.capability.vision"))).toBeNull();
  });

  it("the Model Draft dialog closes only after the Host atomic save succeeds", async () => {
    let resolveSave!: () => void;
    const onCommit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: createModelProviderModelConfig({ id: "draft-model" }),
        onCommit,
        settingsRevision: 9,
      }),
    );

    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.save") }));

    await waitFor(() =>
      expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ modelId: "draft-model" }), 9),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: expectedCopy("common.save"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    resolveSave();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Enter confirming a candidate in an IME must not save the Model ID", async () => {
    const onCommit = vi.fn(async () => undefined);
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: createModelProviderModelConfig({ id: "draft-model" }),
        onCommit,
      }),
    );

    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    const modelIdInput = screen.getByDisplayValue("draft-model");
    fireEvent.compositionStart(modelIdInput);
    fireEvent.keyDown(modelIdInput, { key: "Enter" });

    await act(async () => undefined);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.compositionEnd(modelIdInput);
    fireEvent.keyDown(modelIdInput, { key: "Enter" });
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
  });

  it("a failed Model Draft save keeps the dialog, the draft, and an explicit error", async () => {
    const onCommit = vi.fn(async () => {
      throw new Error("revision conflict");
    });
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model: createModelProviderModelConfig({ id: "draft-model" }),
        onCommit,
        settingsRevision: 4,
      }),
    );

    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    fireEvent.change(screen.getByDisplayValue("draft-model"), {
      target: { value: "renamed-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: expectedCopy("common.save") }));

    await waitFor(() => expect(screen.getByText("revision conflict")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("renamed-model")).toBeTruthy();
  });

  it("Model ID Resolution discards late stale responses", async () => {
    const baseModel = createModelProviderModelConfig({ id: "draft-model" });
    const model = {
      ...baseModel,
      personalConfig: {},
      inheritedConfig: structuredClone(baseModel.config),
      hasPersonalConfig: false,
    };
    const resolvers = new Map<
      string,
      (resolution: {
        inheritedConfig: typeof baseModel.config;
        effectiveConfig: typeof baseModel.config;
        issues: [];
      }) => void
    >();
    const onResolveDraft = vi.fn(
      (nextModelId: string) =>
        new Promise<{
          inheritedConfig: typeof baseModel.config;
          effectiveConfig: typeof baseModel.config;
          issues: [];
        }>((resolve) => resolvers.set(nextModelId, resolve)),
    );
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model,
        onCommit: vi.fn(async () => undefined),
        onResolveDraft,
      }),
    );

    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    const modelIdInput = screen.getByDisplayValue("draft-model");
    fireEvent.change(modelIdInput, { target: { value: "first-model" } });
    fireEvent.blur(modelIdInput);
    await waitFor(() => expect(onResolveDraft).toHaveBeenCalledWith("first-model", {}));
    fireEvent.change(modelIdInput, { target: { value: "second-model" } });
    fireEvent.blur(modelIdInput);
    await waitFor(() => expect(onResolveDraft).toHaveBeenCalledWith("second-model", {}));

    const secondConfig = structuredClone(baseModel.config);
    secondConfig.properties!.contextWindow = 222_000;
    resolvers.get("second-model")?.({
      inheritedConfig: secondConfig,
      effectiveConfig: secondConfig,
      issues: [],
    });
    const contextWindowInput = document.querySelector<HTMLInputElement>(
      'input[inputmode="numeric"]',
    );
    await waitFor(() => expect(contextWindowInput?.placeholder).toBe("222000"));

    const firstConfig = structuredClone(baseModel.config);
    firstConfig.properties!.contextWindow = 111_000;
    resolvers.get("first-model")?.({
      inheritedConfig: firstConfig,
      effectiveConfig: firstConfig,
      issues: [],
    });
    await waitFor(() => expect(contextWindowInput?.placeholder).toBe("222000"));
  });

  it("turning off follow materializes the current draft without losing unsaved edits", () => {
    const base = createModelProviderModelConfig({ id: "draft-model" });
    const model = {
      ...base,
      inheritedConfig: structuredClone(base.config),
      personalConfig: {},
    };
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model,
        onCommit: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    const context = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    fireEvent.change(context, { target: { value: "345000" } });
    fireEvent.click(
      screen.getByRole("switch", {
        name: expectedCopy("settings.modelProvider.followRecommendedConfig"),
      }),
    );
    expect(context.value).toBe("345000");
    expect(context.placeholder).toBe("");
  });

  it("after a rename resolves, turning off follow uses the inherited facts of the new Model ID", async () => {
    const original = createModelProviderModelConfig({
      id: "draft-model",
      supportsTools: true,
    });
    const model = {
      ...original,
      personalConfig: { properties: { contextWindow: 300_000 } },
      hasPersonalConfig: true,
      inheritedConfig: structuredClone(original.config),
      config: {
        ...original.config,
        properties: { ...original.config.properties, contextWindow: 300_000 },
      },
    };
    const renamedInherited = createModelProviderModelConfig({
      id: "renamed-model",
      contextWindow: 100_000,
      supportsTools: false,
    }).config;
    const onResolveDraft = vi.fn(async () => ({
      inheritedConfig: renamedInherited,
      effectiveConfig: {
        ...renamedInherited,
        properties: { ...renamedInherited.properties, contextWindow: 300_000 },
      },
      issues: [],
    }));
    render(
      createElement(ModelRowInput, {
        providerId: "provider-demo",
        model,
        onCommit: vi.fn(async () => undefined),
        onResolveDraft,
      }),
    );

    fireEvent.click(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel")));
    fireEvent.change(screen.getByDisplayValue("draft-model"), {
      target: { value: "renamed-model" },
    });
    fireEvent.blur(screen.getByDisplayValue("renamed-model"));
    await waitFor(() => expect(onResolveDraft).toHaveBeenCalled());
    const contextWindowInput = document.querySelector<HTMLInputElement>(
      'input[inputmode="numeric"]',
    );
    await waitFor(() => expect(contextWindowInput?.placeholder).toBe("100000"));

    fireEvent.click(
      screen.getByRole("switch", {
        name: expectedCopy("settings.modelProvider.followRecommendedConfig"),
      }),
    );

    expect(
      screen
        .getByRole("switch", {
          name: expectedCopy("settings.modelProvider.followRecommendedConfig"),
        })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value).toBe(
        "300000",
      ),
    );
    expect(
      document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.placeholder,
    ).toBe("");
  });

  it("renders the context window as a compact token capacity", () => {
    expect(formatModelContextWindowLabel(999)).toBe("999");
    expect(formatModelContextWindowLabel(128000)).toBe("128K");
    expect(formatModelContextWindowLabel(1500000)).toBe("1.5M");
    expect(formatModelContextWindowLabel(1000000)).toBe("1M");
    expect(formatModelContextWindowLabel(128000, "zh-CN")).toBe("128K");
    expect(formatModelContextWindowLabel(1000000, "zh-CN")).toBe("1M");
  });

  it("shows only compact model rows by default; the metadata edit entry folds into the dialog", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [
          createModelProviderModelConfig({
            id: "deepseek-v3.2",
            name: "DeepSeek V3.2",
            contextWindow: 128000,
            maxOutputTokens: 4096,
            defaultKind: "openai-compatible",
            kinds: ["openai-compatible"],
          }),
        ],
        apiKeyValue: "sk-demo",
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );

    expect(html).toContain("deepseek-v3.2");
    expect(html).toContain(">128K<");
    expect(html).toContain(
      `aria-label="${expectedCopy("settings.modelProvider.contextWindowBadgeLabel", { value: "128K" })}"`,
    );
    expect(html).toContain(`aria-label="${expectedCopy("settings.modelProvider.editModel")}"`);
    expect(html).not.toContain(expectedCopy("settings.modelProvider.modelDisplayName"));
    expect(html).not.toContain(expectedCopy("settings.modelProvider.maxOutputTokens"));
  });

  it("renders the drag handle only when a personal-model reorder entry is provided", () => {
    const common = {
      providerId: "test-provider",
      models: [
        createModelProviderModelConfig({
          id: "deepseek-v3.2",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          defaultKind: "openai-compatible" as const,
          kinds: ["openai-compatible" as const],
        }),
      ],
      apiKeyValue: "sk-demo",
      onModelCommit: vi.fn(),
      onDeleteModel: vi.fn(),
      onAddModel: vi.fn(),
    };

    expect(
      renderToStaticMarkup(
        createElement(ProviderModelsSection, {
          ...common,
          onReorderModelIds: vi.fn(),
        }),
      ),
    ).toContain('aria-label="settings.modelProvider.reorderModel"');
    expect(renderToStaticMarkup(createElement(ProviderModelsSection, common))).not.toContain(
      'aria-label="settings.modelProvider.reorderModel"',
    );
  });

  it("a Built-in model cannot be deleted but can be reordered, edited into overrides, and given a sparse enabled overlay", () => {
    const model = {
      ...createModelProviderModelConfig({ id: "builtin-model" }),
      builtin: true,
      personalConfig: {},
      hasPersonalConfig: false,
    };
    const onModelCommit = vi.fn();
    const onModelEnabledChange = vi.fn();
    render(
      createElement(ProviderModelsSection, {
        providerId: "builtin-provider",
        models: [model],
        apiKeyValue: "sk-demo",
        onModelCommit,
        onModelEnabledChange,
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
        onReorderModelIds: vi.fn(),
      }),
    );

    expect(screen.getByText("builtin-model")).toBeTruthy();
    expect(screen.queryByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0"))).toBeNull();
    expect(screen.getByLabelText("settings.modelProvider.reorderModel")).toBeTruthy();
    expect(screen.getByLabelText(expectedCopy("settings.modelProvider.editModel"))).toBeTruthy();

    fireEvent.click(
      screen.getByRole("switch", {
        name: expectedCopy("settings.modelProvider.disableAction"),
      }),
    );
    expect(onModelEnabledChange).toHaveBeenCalledWith("builtin-model", false);
    expect(onModelCommit).not.toHaveBeenCalled();
  });

  it("a Provider card's Model enabled submits only the enable leaf, not the model draft", async () => {
    const model = {
      ...createModelProviderModelConfig({ id: "builtin-model" }),
      builtin: true,
      personalConfig: {},
      hasPersonalConfig: false,
    };
    const onSave = vi.fn(async () => undefined);
    const onSavePersonalModelDraft = vi.fn(async () => undefined);
    const onSetPersonalModelEnabled = vi.fn(async () => undefined);
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({ models: [model] }),
        onSave,
        onSavePersonalModelDraft,
        onSetPersonalModelEnabled,
        settingsRevision: 7,
      }),
    );

    fireEvent.click(
      screen.getByRole("switch", {
        name: expectedCopy("settings.modelProvider.disableAction"),
      }),
    );

    await waitFor(() => expect(onSetPersonalModelEnabled).toHaveBeenCalledTimes(1));
    expect(onSetPersonalModelEnabled).toHaveBeenCalledWith(
      "provider-deepseek",
      "builtin-model",
      false,
    );
    expect(onSavePersonalModelDraft).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("with a Built-in/Personal name collision, the Built-in member is kept and the model switch shows no restore-default", () => {
    const model = {
      ...createModelProviderModelConfig({ id: "same-id" }),
      builtin: true,
      hasPersonalConfig: true,
      personalConfig: { enabled: false },
    };
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "builtin-provider",
        models: [model],
        apiKeyValue: "sk-demo",
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
        onReorderModelIds: vi.fn(),
      }),
    );

    expect(html).toContain(">same-id</span>");
    expect(html).not.toContain('<input type="text"');
    expect(html).not.toContain(`aria-label="${expectedCopy("settings.modelProvider.delete")}"`);
    expect(html).not.toContain(expectedCopy("settings.modelProvider.restoreDefaultAction"));
    expect(html).toContain(`aria-label="${expectedCopy("settings.modelProvider.editModel")}"`);
    expect(html).toContain('aria-label="settings.modelProvider.reorderModel"');
  });

  it("model rows show the context window from the config, not rewritten by model-id suffix", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [
          createModelProviderModelConfig({
            id: "deepseek-v4-pro[1m]",
            contextWindow: 128000,
            defaultKind: "openai-compatible",
            kinds: ["openai-compatible"],
          }),
        ],
        apiKeyValue: "sk-demo",
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );

    expect(html).toContain("deepseek-v4-pro[1m]");
    expect(html).toContain(">128K<");
    expect(html).toContain(
      `aria-label="${expectedCopy("settings.modelProvider.contextWindowBadgeLabel", { value: "128K" })}"`,
    );
  });

  it("model rows keep a usable test entry for both models", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelsSection, {
        providerId: "test-provider",
        models: [
          createModelProviderModelConfig({
            id: "anthropic-model",
            kinds: ["anthropic"],
          }),
          createModelProviderModelConfig({
            id: "openai-compatible-model",
            kinds: ["openai-compatible"],
          }),
        ],
        apiKeyValue: "sk-demo",
        onTestModel: vi.fn(),
        onModelCommit: vi.fn(),
        onDeleteModel: vi.fn(),
        onAddModel: vi.fn(),
      }),
    );

    expect(html).toContain("anthropic-model");
    expect(html).toContain("openai-compatible-model");
    expect(
      html.match(new RegExp(`title="${expectedCopy("settings.modelProvider.testModel")}"`, "g")),
    ).toHaveLength(2);
    expect(html).not.toContain('disabled=""');
  });

  it("a model is removed only after the authoritative View arrives, not by locally hiding the row", async () => {
    const onSave = vi.fn();
    const onDeletePersonalModel = vi.fn(async () => undefined);
    const provider = createProvider({
      models: [createModelProviderModelConfig({ id: "user-added-model" })],
    });
    const view = render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({
          models: [
            createModelProviderModelConfig({
              id: "user-added-model",
              kinds: ["openai-compatible"],
            }),
          ],
        }),
        onSave,
        onDeletePersonalModel,
      }),
    );

    fireEvent.click(screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0")));
    expect(screen.queryByText("user-added-model")).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: { ...provider, models: [] },
        onSave,
        onDeletePersonalModel,
      }),
    );
    expect(screen.queryByText("user-added-model")).toBeNull();
    expect(screen.getByText(expectedCopy("settings.modelProvider.modelsEmpty"))).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDeletePersonalModel).toHaveBeenCalledWith("provider-deepseek", "user-added-model");
  });

  it("mouse down on the delete button must not trigger the model-row drag", () => {
    render(
      createElement(InlineEditableProviderCard, {
        provider: createProvider({
          models: [
            createModelProviderModelConfig({
              id: "focused-model",
              kinds: ["openai-compatible"],
            }),
          ],
        }),
        onSave: vi.fn(),
      }),
    );

    const deleteButton = screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0"));

    expect(fireEvent.mouseDown(deleteButton)).toBe(false);
  });

  it("a failed delete must not roll back to the old list nor overwrite a View that arrived meanwhile", async () => {
    let rejectDelete!: (error: Error) => void;
    const onDeletePersonalModel = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDelete = reject;
        }),
    );
    const provider = createProvider({
      models: [createModelProviderModelConfig({ id: "managed-remote-model" })],
    });
    const view = render(
      createElement(InlineEditableProviderCard, {
        provider,
        onSave: vi.fn(),
        onDeletePersonalModel,
      }),
    );
    fireEvent.click(screen.getByTestId(testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, "0")));
    const refreshed = {
      ...provider,
      models: [...provider.models, createModelProviderModelConfig({ id: "external-new-model" })],
    };
    view.rerender(
      createElement(InlineEditableProviderCard, {
        provider: refreshed,
        onSave: vi.fn(),
        onDeletePersonalModel,
      }),
    );
    await act(async () => {
      rejectDelete(new Error("disk write failed"));
    });
    expect(screen.queryByText("managed-remote-model")).not.toBeNull();
    expect(screen.queryByText("external-new-model")).not.toBeNull();
  });
});
