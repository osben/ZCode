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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OllamaDetail,
  useOllamaDetection,
} from "@/settings/model-provider-section/OllamaDetail.js";

// specs/ollama-local-provider.md (OL1–OL3, OL9).
const { providerSettingsService } = vi.hoisted(() => ({
  providerSettingsService: { detectOllama: vi.fn() },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService }),
}));
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

function detail(overrides: Partial<Parameters<typeof OllamaDetail>[0]> = {}) {
  return createElement(OllamaDetail, {
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
  afterEach(() => {
    cleanup();
    providerSettingsService.detectOllama.mockReset();
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

  it("keeps the newest detection when an older one settles later (OL9)", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    providerSettingsService.detectOllama
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(REACHABLE);
    const { result } = renderHook(() => useOllamaDetection());

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
});
