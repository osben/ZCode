// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AcpAgentSummary, IProviderSettingsService } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { AcpAgentDetail } from "@/settings/model-provider-section/AcpAgentCard.js";

const { providerSettingsService } = vi.hoisted(() => ({
  providerSettingsService: {
    getAcpAgentStatus: vi.fn(async () => ({ supported: true, exitCode: 0, output: "ok" })),
    testAcpAgent: vi.fn(),
    startAcpAgentLogin: vi.fn(),
    getAcpAgentCatalog: vi.fn(async (): Promise<Record<string, unknown>> => ({ supported: true })),
    setAcpAgentHiddenModels: vi.fn(async () => ({ supported: true })),
  },
}));

// The detail runs on the workspace host's service it is given, never the context's
// (specs/acp-agent-runtime.md "Settings: workspace host").
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => {
    throw new Error("the ACP detail must not read the services context");
  },
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

function agent(statusArgs: string[] | null): AcpAgentSummary {
  return {
    agentId: "opencode",
    displayName: "opencode",
    installed: true,
    version: "2.0.31",
    commandPath: "/bin/opencode",
    spawnArgs: ["acp"],
    loginArgs: ["auth", "login"],
    statusArgs,
  };
}

function detail(props: Partial<Parameters<typeof AcpAgentDetail>[0]> & { agent: AcpAgentSummary }) {
  return createElement(
    TooltipProvider,
    null,
    createElement(AcpAgentDetail, {
      providerSettingsService: providerSettingsService as unknown as IProviderSettingsService,
      enabled: false,
      conflict: false,
      onRescan: vi.fn(),
      rescanning: false,
      onEnable: vi.fn(async () => {}),
      onUpdate: vi.fn(async () => {}),
      onDisable: vi.fn(async () => {}),
      ...props,
    }),
  );
}

describe("AcpAgentDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("probes login status once per agent, not once per rescan", async () => {
    providerSettingsService.getAcpAgentStatus.mockClear();
    const { rerender } = render(detail({ agent: agent(["auth", "list"]) }));
    await waitFor(() => expect(providerSettingsService.getAcpAgentStatus).toHaveBeenCalledTimes(1));
    // A rescan delivers a new agent object with a new statusArgs array for the same agent.
    await act(async () => {
      rerender(detail({ agent: agent(["auth", "list"]) }));
    });
    expect(providerSettingsService.getAcpAgentStatus).toHaveBeenCalledTimes(1);
  });

  it("names the agent in the enable switch label", () => {
    render(detail({ agent: agent(null) }));
    expect(screen.getByRole("switch").getAttribute("aria-label")).toBe(
      "settings.modelProvider.acp.enableAgentLabel:opencode",
    );
  });

  it("announces a scan failure as an alert", () => {
    render(detail({ agent: agent(null), scanError: "boom" }));
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });

  // specs/acp-agent-runtime.md "Settings: models and Advanced" (SM1, SM2, SM4–SM7).
  const MODEL_OPTION = {
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    currentValue: "a",
    options: ["a", "b", "c"].map((value) => ({
      value,
      name: `Model ${value}`,
      description: null,
      group: null,
    })),
  };

  function modelCheckbox(value: string): HTMLElement {
    const found = screen
      .getAllByTestId("acp-agent-model-checkbox")
      .find((element) => element.getAttribute("data-model-value") === value);
    if (!found) throw new Error(`no checkbox for ${value}`);
    return found;
  }

  it("lists the agent's models checked and keeps Advanced collapsed", async () => {
    providerSettingsService.getAcpAgentCatalog.mockResolvedValueOnce({
      supported: true,
      options: [MODEL_OPTION],
    });
    render(detail({ agent: agent(null) }));

    await waitFor(() => expect(screen.getAllByTestId("acp-agent-model-checkbox")).toHaveLength(3));
    expect(modelCheckbox("b").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("acp-agent-advanced-trigger").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("stores an unchecked model as hidden and disables the last visible one", async () => {
    providerSettingsService.setAcpAgentHiddenModels.mockClear();
    providerSettingsService.getAcpAgentCatalog.mockResolvedValueOnce({
      supported: true,
      options: [MODEL_OPTION],
      hiddenModels: ["c"],
    });
    render(detail({ agent: agent(null) }));
    await waitFor(() => expect(modelCheckbox("c").getAttribute("aria-checked")).toBe("false"));

    await act(async () => {
      fireEvent.click(modelCheckbox("b"));
    });

    expect(providerSettingsService.setAcpAgentHiddenModels).toHaveBeenCalledWith({
      agentId: "opencode",
      hiddenModels: ["b", "c"],
    });
    expect(modelCheckbox("a").hasAttribute("disabled")).toBe(true);
  });

  it("reverts the checkbox and alerts when the write fails", async () => {
    providerSettingsService.getAcpAgentCatalog.mockResolvedValueOnce({
      supported: true,
      options: [MODEL_OPTION],
    });
    providerSettingsService.setAcpAgentHiddenModels.mockRejectedValueOnce(new Error("disk full"));
    render(detail({ agent: agent(null) }));
    await waitFor(() => expect(screen.getAllByTestId("acp-agent-model-checkbox")).toHaveLength(3));

    await act(async () => {
      fireEvent.click(modelCheckbox("b"));
    });

    await waitFor(() => expect(modelCheckbox("b").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("alert").textContent).toContain("disk full");
  });

  it("shows the empty state until a successful Test loads the models", async () => {
    providerSettingsService.getAcpAgentCatalog
      .mockResolvedValueOnce({ supported: true })
      .mockResolvedValueOnce({ supported: true, options: [MODEL_OPTION] });
    providerSettingsService.testAcpAgent.mockResolvedValueOnce({
      ok: true,
      frames: [],
      framesDropped: 0,
      durationMs: 5,
    });
    render(detail({ agent: agent(null) }));
    await waitFor(() => expect(screen.getByTestId("acp-agent-models-empty")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("acp-agent-test-button"));
    });

    await waitFor(() => expect(screen.getAllByTestId("acp-agent-model-checkbox")).toHaveLength(3));
  });

  it("reloads the catalog even when the test prompt fails (SM8)", async () => {
    providerSettingsService.getAcpAgentCatalog
      .mockResolvedValueOnce({ supported: true })
      .mockResolvedValueOnce({ supported: true, options: [MODEL_OPTION] });
    providerSettingsService.testAcpAgent.mockResolvedValueOnce({
      ok: false,
      error: { message: "prompt timeout" },
      frames: [],
      framesDropped: 0,
      durationMs: 5,
    });
    render(detail({ agent: agent(null) }));
    await waitFor(() => expect(screen.getByTestId("acp-agent-models-empty")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("acp-agent-test-button"));
    });

    // The handshake recorded the agent's options before the prompt failed, so the list still fills.
    await waitFor(() => expect(screen.getAllByTestId("acp-agent-model-checkbox")).toHaveLength(3));
    expect(screen.getByRole("alert").textContent).toContain("prompt timeout");
  });

  it("says so when the agent offers no model select", async () => {
    providerSettingsService.getAcpAgentCatalog.mockResolvedValueOnce({
      supported: true,
      options: [{ ...MODEL_OPTION, id: "mode", category: "mode" }],
    });
    render(detail({ agent: agent(null) }));
    await waitFor(() =>
      expect(screen.getByTestId("acp-agent-models-empty").textContent).toBe(
        "settings.modelProvider.acp.modelsNotOffered",
      ),
    );
  });

  it("expands Advanced while the env text has an invalid line", async () => {
    render(
      detail({
        agent: agent(null),
        savedAccess: { command: "/bin/opencode", args: [], env: {} },
      }),
    );
    fireEvent.click(screen.getByTestId("acp-agent-advanced-trigger"));
    const env = screen.getByLabelText("settings.modelProvider.acp.environment");
    fireEvent.click(screen.getByTestId("acp-agent-advanced-trigger"));
    expect(screen.getByTestId("acp-agent-advanced-trigger").getAttribute("aria-expanded")).toBe(
      "false",
    );

    fireEvent.change(env, { target: { value: "not an env line" } });

    expect(screen.getByTestId("acp-agent-advanced-trigger").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
