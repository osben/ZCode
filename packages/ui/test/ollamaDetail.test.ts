// @vitest-environment jsdom

import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOllamaDetection } from "@/hooks/useOllamaDetection.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { OllamaDetail } from "@/settings/model-provider-section/OllamaDetail.js";

// specs/ollama-local-provider.md (OL1–OL3, OL8–OL10). Detection goes through the workspace's
// resolved services, so the tests stub `useWorkspaceServices` and route every probe through it.
const { providerSettingsService, useWorkspaceServices } = vi.hoisted(() => ({
  providerSettingsService: { detectOllama: vi.fn() },
  useWorkspaceServices: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({ useWorkspaceServices }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${Object.values(values).join(",")}` : id,
    },
  }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ROOT = "http://127.0.0.1:11434";
const REACHABLE = {
  reachable: true,
  baseUrl: ROOT,
  version: "0.40.11",
  models: [
    { name: "qwen3", capabilities: ["completion", "tools"] },
    { name: "phonon", capabilities: ["speech"] },
  ],
};
const REACHABLE_THREE = {
  ...REACHABLE,
  models: [
    { name: "qwen3", capabilities: ["completion", "tools"] },
    { name: "llama2", capabilities: ["completion", "tools"] },
    { name: "phonon", capabilities: ["speech"] },
  ],
};

function provider(modelIds: string[]): ProviderSettingsFormProvider {
  return {
    providerId: "ollama",
    executable: true,
    enabled: true,
    hasPersonalConfig: true,
    config: {
      access: { type: "api-key", apiKey: "ollama" },
      api: { type: "openai-chat-completions", baseUrl: `${ROOT}/v1` },
    },
    models: modelIds.map((modelId) => ({ modelId, config: {}, hasPersonalConfig: true })),
  } as unknown as ProviderSettingsFormProvider;
}

function detail(overrides: Partial<Parameters<typeof OllamaDetail>[0]> = {}) {
  return createElement(OllamaDetail, {
    workspacePath: "",
    provider: null,
    onCreateProvider: vi.fn(async () => ({})),
    onAddModel: vi.fn(async () => ({})),
    onDeleteModel: vi.fn(async () => ({})),
    onOpenProvider: vi.fn(),
    ...overrides,
  });
}

function checkbox(name: string): HTMLElement {
  const found = screen
    .getAllByTestId("ollama-model-checkbox")
    .find((element) => element.getAttribute("data-model-name") === name);
  if (!found) throw new Error(`no checkbox for ${name}`);
  return found;
}

describe("OllamaDetail", () => {
  beforeEach(() => {
    useWorkspaceServices.mockReturnValue({ providerSettingsService });
  });

  afterEach(() => {
    cleanup();
    providerSettingsService.detectOllama.mockReset();
    useWorkspaceServices.mockReset();
  });

  it("probes the default address once on open and reports an unreachable server (OL1)", async () => {
    providerSettingsService.detectOllama.mockResolvedValue({
      reachable: false,
      baseUrl: ROOT,
      error: "ECONNREFUSED",
    });
    render(detail());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("ECONNREFUSED"));
    expect(providerSettingsService.detectOllama).toHaveBeenCalledTimes(1);
    expect(providerSettingsService.detectOllama).toHaveBeenCalledWith({ baseUrl: ROOT });
    expect(screen.queryByTestId("ollama-save-button")).toBeNull();
  });

  it("resolves the probe through the workspace's services, not the context's (workspace host)", async () => {
    providerSettingsService.detectOllama.mockResolvedValue(REACHABLE);
    render(detail({ workspacePath: "/remote/ws", workspaceIdentity: "ws-identity" }));

    await waitFor(() => expect(screen.getAllByTestId("ollama-model-checkbox")).toHaveLength(2));
    expect(useWorkspaceServices).toHaveBeenCalledWith("/remote/ws", null, "ws-identity");
  });

  it("lists chat models as selectable and other models disabled (OL2, OL3)", async () => {
    providerSettingsService.detectOllama.mockResolvedValue(REACHABLE);
    render(detail());

    await waitFor(() => expect(screen.getAllByTestId("ollama-model-checkbox")).toHaveLength(2));
    expect(checkbox("qwen3").hasAttribute("disabled")).toBe(false);
    expect(checkbox("qwen3").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("phonon").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("ollama-models").textContent).toContain(
      "settings.modelProvider.ollama.eligibility.notChat",
    );
  });

  it("creates the provider and adds the checked model on Save (OL4)", async () => {
    providerSettingsService.detectOllama.mockResolvedValue(REACHABLE);
    const onCreateProvider = vi.fn(async () => ({}));
    const onAddModel = vi.fn(async () => ({}));
    render(detail({ onCreateProvider, onAddModel }));
    await waitFor(() => expect(screen.getAllByTestId("ollama-model-checkbox")).toHaveLength(2));
    expect(screen.getByTestId("ollama-save-button").hasAttribute("disabled")).toBe(true);

    fireEvent.click(checkbox("qwen3"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-save-button"));
    });

    expect(onCreateProvider).toHaveBeenCalledWith({
      providerId: "ollama",
      providerName: "Ollama",
      initialConfig: {
        access: { type: "api-key", apiKey: "ollama" },
        api: { type: "openai-chat-completions", baseUrl: `${ROOT}/v1` },
      },
    });
    expect(onAddModel).toHaveBeenCalledWith("ollama", "qwen3", {
      properties: { supportsToolCall: true },
    });
  });

  it("keeps the requested checklist across a mid-sync provider commit and a later failure (OL8)", async () => {
    providerSettingsService.detectOllama.mockResolvedValue(REACHABLE_THREE);
    const updatedProvider = provider(["qwen3", "llama2"]);
    const onDeleteModel = vi.fn(async () => {
      throw new Error("boom");
    });
    const onAddModel = vi.fn(async () => ({}));
    const { rerender } = render(
      detail({ provider: provider(["qwen3"]), onAddModel, onDeleteModel }),
    );
    await waitFor(() => expect(screen.getAllByTestId("ollama-model-checkbox")).toHaveLength(3));

    // Requested set: remove qwen3, add llama2. The successful add commits a provider view
    // mid-sync (as the real parent does); the delete then fails.
    fireEvent.click(checkbox("qwen3"));
    fireEvent.click(checkbox("llama2"));
    onAddModel.mockImplementationOnce(async () => {
      rerender(detail({ provider: updatedProvider, onAddModel, onDeleteModel }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-save-button"));
    });

    expect(screen.getByRole("alert").textContent).toContain("boom");
    // The requested set survived the provider view commit: qwen3 stays unchecked for removal.
    expect(checkbox("llama2").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("qwen3").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("ollama-save-button").hasAttribute("disabled")).toBe(false);

    // The second Save finishes the remaining step.
    onDeleteModel.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-save-button"));
    });
    expect(onDeleteModel).toHaveBeenCalledWith("ollama", "qwen3");
    expect(onDeleteModel).toHaveBeenCalledTimes(2);
  });

  it("drops the detection result when the address changes and re-detects on demand (OL10)", async () => {
    providerSettingsService.detectOllama
      .mockResolvedValueOnce(REACHABLE)
      .mockResolvedValue({ ...REACHABLE, baseUrl: "http://127.0.0.1:9999" });
    const onCreateProvider = vi.fn(async () => ({}));
    render(detail({ onCreateProvider }));
    await waitFor(() => expect(screen.getAllByTestId("ollama-model-checkbox")).toHaveLength(2));
    fireEvent.click(checkbox("qwen3"));
    expect(screen.getByTestId("ollama-save-button").hasAttribute("disabled")).toBe(false);

    const address = screen.getByLabelText("settings.modelProvider.ollama.address");
    fireEvent.change(address, { target: { value: "http://127.0.0.1:9999" } });

    // The previous result is gone: no models, no Save — even though server A was detected.
    expect(screen.queryByTestId("ollama-save-button")).toBeNull();
    expect(screen.queryByTestId("ollama-models")).toBeNull();

    fireEvent.keyDown(address, { key: "Enter" });
    await waitFor(() =>
      expect(providerSettingsService.detectOllama).toHaveBeenLastCalledWith({
        baseUrl: "http://127.0.0.1:9999",
      }),
    );
    await waitFor(() => expect(screen.getAllByTestId("ollama-model-checkbox")).toHaveLength(2));

    // A save after the new detection uses the new address's root.
    fireEvent.click(checkbox("qwen3"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-save-button"));
    });
    expect(onCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        initialConfig: expect.objectContaining({
          api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:9999/v1" },
        }),
      }),
    );
  });

  it("keeps the newest detection when an older one settles later (OL9)", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    providerSettingsService.detectOllama
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(REACHABLE);
    const { result } = renderHook(() => useOllamaDetection(""));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.detect(ROOT);
      await result.current.detect(ROOT);
    });
    await act(async () => {
      resolveFirst({ reachable: false, baseUrl: ROOT, error: "stale" });
      await first;
    });

    expect(result.current.result).toEqual(REACHABLE);
    expect(result.current.loading).toBe(false);
  });

  it("drops an in-flight probe when the address edit resets the detection (OL10)", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    providerSettingsService.detectOllama.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    const { result } = renderHook(() => useOllamaDetection(""));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.detect(ROOT);
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      result.current.reset();
    });
    await act(async () => {
      resolveFirst(REACHABLE);
      await first;
    });

    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
