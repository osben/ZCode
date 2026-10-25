// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderModelsSection } from "@/settings/model-provider-section/ProviderCardSections.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import { MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS } from "@/settings/model-provider-section/useIdleTrigger.js";
import enUS from "@/i18n/locales/en-US.js";

const providerSettingsServiceMock = vi.hoisted(() => ({
  resolveModelConfig: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    providerSettingsService: providerSettingsServiceMock,
  }),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open
      ? createElement(
          "div",
          null,
          children,
          createElement(
            "button",
            {
              "aria-label": "Close dialog (mock)",
              onClick: () => onOpenChange?.(false),
              type: "button",
            },
            "close",
          ),
        )
      : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement("section", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("footer", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("header", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
  DialogTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "common.cancel": enUS["common.cancel"],
          "common.loading": enUS["common.loading"],
          "common.save": enUS["common.save"],
          "settings.modelProvider.addModel": enUS["settings.modelProvider.addModel"],
          "settings.modelProvider.advanced": enUS["settings.modelProvider.advanced"],
          "settings.modelProvider.contextWindow": enUS["settings.modelProvider.contextWindow"],
          "settings.modelProvider.editModel": enUS["settings.modelProvider.editModel"],
          "settings.modelProvider.editModelDescription":
            enUS["settings.modelProvider.editModelDescription"],
          "settings.modelProvider.maxOutputTokens": enUS["settings.modelProvider.maxOutputTokens"],
          "settings.modelProvider.modelId": enUS["settings.modelProvider.modelId"],
          "settings.modelProvider.models": enUS["settings.modelProvider.models"],
          "settings.modelProvider.modelDefaultsLoaded":
            enUS["settings.modelProvider.modelDefaultsLoaded"],
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

function createModelConfigResolution(maxOutputTokens = 32_000, contextWindow = 128_000) {
  const optionSpecs = {
    reasoningLevel: {
      values: ["disabled"],
      map: "{}",
    },
    maxOutputTokens: {
      max: maxOutputTokens,
      map: "{'max_tokens': maxOutputTokens}",
    },
  };
  return {
    inheritedConfig: {
      properties: {
        contextWindow,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs,
    },
    effectiveConfig: {
      properties: {
        contextWindow,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs,
    },
    issues: [],
  };
}

function renderAddModelSection(onAddModel = vi.fn(() => true)) {
  render(
    createElement(ProviderModelsSection, {
      providerId: "personal-provider",
      models: [],
      apiKeyValue: "",
      currentApiFormat: "openai-chat-completions",
      onModelCommit: vi.fn(),
      onDeleteModel: vi.fn(),
      onAddModel,
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: enUS["settings.modelProvider.addModel"],
    }),
  );
  const contextWindowInput = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
  if (!contextWindowInput) throw new Error("context window input did not render");
  return {
    contextWindowInput,
    maxOutputTokensInput: screen.getByLabelText(
      enUS["settings.modelProvider.maxOutputTokens"],
    ) as HTMLInputElement,
    modelIdInput: screen.getByPlaceholderText(
      enUS["settings.modelProvider.modelId"],
    ) as HTMLInputElement,
    onAddModel,
    saveButton: screen.getByRole("button", {
      name: enUS["common.save"],
    }) as HTMLButtonElement,
  };
}

describe("provider model config resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    providerSettingsServiceMock.resolveModelConfig.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("numeric fields use input, help sits outside the label and the reasoning editor renders", () => {
    render(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          idValue: "custom-model",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "8192",
          reasoningLevelValuesValue: [],
          inputFormatValue: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    const maxOutputTokensInput = screen.getByLabelText(
      enUS["settings.modelProvider.maxOutputTokens"],
    );
    expect(maxOutputTokensInput.tagName).toBe("INPUT");
    expect(screen.getByLabelText(enUS["settings.modelProvider.contextWindow"]).tagName).toBe(
      "INPUT",
    );
    for (const help of document.querySelectorAll("[data-model-help]")) {
      expect(help.closest("label")).toBeNull();
    }
    expect(document.querySelector('[data-model-reasoning-level-editor="true"]')).toBeTruthy();
  });

  it("add-model waits for the shared idle time to resolve and allows overriding the Config Rule backfill", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(
      createModelConfigResolution(64_000),
    );
    const onAddModel = vi.fn();
    const { maxOutputTokensInput, modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    expect(maxOutputTokensInput.disabled).toBe(true);
    fireEvent.change(modelIdInput, { target: { value: "g" } });
    fireEvent.change(modelIdInput, { target: { value: "glm" } });
    fireEvent.change(modelIdInput, { target: { value: "glm-5" } });

    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(onAddModel).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS - 1);
    });
    expect(providerSettingsServiceMock.resolveModelConfig).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(providerSettingsServiceMock.resolveModelConfig).toHaveBeenCalledTimes(1);
    expect(providerSettingsServiceMock.resolveModelConfig).toHaveBeenCalledWith({
      providerId: "personal-provider",
      modelId: "glm-5",
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("64000");
    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);

    fireEvent.change(maxOutputTokensInput, { target: { value: "96000" } });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(onAddModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "glm-5",
        config: expect.objectContaining({
          properties: expect.objectContaining({ contextWindow: 128_000 }),
          optionSpecs: expect.objectContaining({
            maxOutputTokens: expect.objectContaining({ max: 96_000 }),
          }),
        }),
      }),
    );
    expect(onAddModel.mock.calls[0]?.[0].personalConfig).toEqual({
      optionSpecs: {
        maxOutputTokens: { max: 96_000 },
      },
    });
  });

  it("explicit save resolves the current model immediately and commits in the same click", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(
      createModelConfigResolution(128_000, 1_000_000),
    );
    const onAddModel = vi.fn();
    const { modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    fireEvent.change(modelIdInput, { target: { value: "GLM-5.3-Flash" } });
    await act(async () => {
      fireEvent.click(saveButton);
      await Promise.resolve();
    });

    expect(providerSettingsServiceMock.resolveModelConfig).toHaveBeenCalledTimes(1);
    expect(onAddModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "GLM-5.3-Flash",
        config: expect.objectContaining({
          properties: expect.objectContaining({ contextWindow: 1_000_000 }),
        }),
      }),
    );
  });

  it("a late default config does not clobber boolean fields the user already changed", async () => {
    let finishResolution:
      | ((resolution: ReturnType<typeof createModelConfigResolution>) => void)
      | undefined;
    providerSettingsServiceMock.resolveModelConfig.mockReturnValue(
      new Promise((resolve) => {
        finishResolution = resolve;
      }),
    );
    const onAddModel = vi.fn();
    const { modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    fireEvent.change(modelIdInput, { target: { value: "delayed-model" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-model-advanced-trigger]")!);
    const webSearch = screen.getByRole("checkbox", {
      name: "settings.modelProvider.supportsNativeWebSearch",
    });
    fireEvent.click(webSearch);
    expect(webSearch.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      finishResolution?.(createModelConfigResolution(64_000));
      await Promise.resolve();
    });
    expect(webSearch.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(onAddModel.mock.calls[0]?.[0].personalConfig).toMatchObject({
      properties: { supportsNativeWebSearch: true },
    });
  });

  it("clearing a Config Rule backfill is allowed and submits undefined", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(
      createModelConfigResolution(64_000),
    );
    const onAddModel = vi.fn();
    const { maxOutputTokensInput, modelIdInput, saveButton } = renderAddModelSection(onAddModel);

    fireEvent.change(modelIdInput, { target: { value: "glm-5" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("64000");

    fireEvent.change(maxOutputTokensInput, { target: { value: "" } });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(onAddModel).toHaveBeenCalledTimes(1);
    expect(onAddModel.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        modelId: "glm-5",
        config: expect.objectContaining({
          optionSpecs: {
            maxOutputTokens: {
              max: 64_000,
              map: "{'max_tokens': maxOutputTokens}",
            },
            reasoningLevel: { values: ["disabled"], map: "{}" },
          },
        }),
      }),
    );
  });

  it("a failed Config Rule resolution stays blank and restores manual input", async () => {
    providerSettingsServiceMock.resolveModelConfig.mockRejectedValue(
      new Error("config resolution unavailable"),
    );
    const { maxOutputTokensInput, modelIdInput, saveButton } = renderAddModelSection();

    fireEvent.change(modelIdInput, {
      target: { value: "config-error-model" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });

    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
  });

  it("changing the model ID clears the previous model's Config Resolution values", async () => {
    providerSettingsServiceMock.resolveModelConfig
      .mockResolvedValueOnce(createModelConfigResolution(64_000, 256_000))
      .mockResolvedValueOnce(createModelConfigResolution(16_000, 64_000));
    const { contextWindowInput, modelIdInput } = renderAddModelSection();

    fireEvent.change(modelIdInput, { target: { value: "first-model" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(contextWindowInput.value).toBe("");
    expect(contextWindowInput.placeholder).toBe("256000");

    fireEvent.change(modelIdInput, { target: { value: "second-model" } });
    expect(contextWindowInput.value).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(contextWindowInput.value).toBe("");
    expect(contextWindowInput.placeholder).toBe("64000");
  });

  it("a Config Rule resolution started before the model ID changed is ignored", async () => {
    let resolveFirstLookup:
      | ((resolution: ReturnType<typeof createModelConfigResolution>) => void)
      | undefined;
    const firstLookup = new Promise<ReturnType<typeof createModelConfigResolution>>((resolve) => {
      resolveFirstLookup = resolve;
    });
    providerSettingsServiceMock.resolveModelConfig
      .mockReturnValueOnce(firstLookup)
      .mockResolvedValueOnce(createModelConfigResolution(16_000));
    const { maxOutputTokensInput, modelIdInput } = renderAddModelSection();

    fireEvent.change(modelIdInput, { target: { value: "first-model" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    fireEvent.change(modelIdInput, { target: { value: "second-model" } });
    expect(maxOutputTokensInput.value).toBe("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("16000");

    await act(async () => {
      resolveFirstLookup?.(createModelConfigResolution(64_000));
      await firstLookup;
    });
    expect(maxOutputTokensInput.value).toBe("");
    expect(maxOutputTokensInput.placeholder).toBe("16000");
  });

  it("editing a model only shows and edits existing values without catalog lookups", () => {
    const onDraftChange = vi.fn();
    const onCommit = vi.fn(() => true);
    render(
      createElement(ProviderModelMetadataDialog, {
        mode: "edit",
        open: true,
        draft: {
          idValue: "custom-model",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "8192",
          reasoningLevelValuesValue: [],
          inputFormatValue: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange,
        onCommit,
      }),
    );

    const maxOutputTokensInput = screen.getByLabelText(
      enUS["settings.modelProvider.maxOutputTokens"],
    ) as HTMLInputElement;

    // Todo141: max output lives in the basic section and advanced stays collapsed; viewing/editing/expanding must not trigger catalog lookups.
    const advanced = document.querySelector<HTMLElement>("[data-model-advanced]")!;
    const trigger = advanced.querySelector<HTMLButtonElement>("[data-model-advanced-trigger]")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(advanced.contains(maxOutputTokensInput)).toBe(false);
    expect(maxOutputTokensInput.disabled).toBe(false);
    expect(maxOutputTokensInput.value).toBe("8192");
    fireEvent.change(maxOutputTokensInput, { target: { value: "16384" } });
    expect(onDraftChange).toHaveBeenCalledWith({
      maxOutputTokensValue: "16384",
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(providerSettingsServiceMock.resolveModelConfig).not.toHaveBeenCalled();
  });

  it("shows the reasoning defaults and does not repeat the success banner for the same resolution", async () => {
    const resolution = createModelConfigResolution(128_000, 1_000_000);
    resolution.inheritedConfig.optionSpecs = {
      ...resolution.inheritedConfig.optionSpecs,
      reasoningLevel: {
        values: ["low", "high", "max"],
        map: "{'reasoning_effort': reasoningLevel}",
      },
    };
    resolution.effectiveConfig.optionSpecs = resolution.inheritedConfig.optionSpecs;
    providerSettingsServiceMock.resolveModelConfig.mockResolvedValue(resolution);
    const { modelIdInput } = renderAddModelSection();

    fireEvent.change(modelIdInput, { target: { value: "GLM-5.3-Flash" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS);
    });

    const editor = document.querySelector('[data-model-reasoning-level-editor="true"]');
    expect(editor).toBeTruthy();
    expect(editor?.textContent).toContain("low");
    expect(editor?.textContent).toContain("high");
    expect(editor?.textContent).toContain("max");
    expect(document.querySelector("textarea")?.getAttribute("placeholder")).toBe(
      "{'reasoning_effort': reasoningLevel}",
    );
    expect(screen.getAllByText(enUS["settings.modelProvider.modelDefaultsLoaded"])).toHaveLength(1);

    fireEvent.blur(modelIdInput);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_501);
    });
    expect(screen.queryByText(enUS["settings.modelProvider.modelDefaultsLoaded"])).toBeNull();
  });
});
