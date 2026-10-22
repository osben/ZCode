// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { AcpAgentSummary } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { AcpAgentDetail } from "@/settings/model-provider-section/AcpAgentCard.js";

const { providerSettingsService } = vi.hoisted(() => ({
  providerSettingsService: {
    getAcpAgentStatus: vi.fn(async () => ({ supported: true, exitCode: 0, output: "ok" })),
    testAcpAgent: vi.fn(),
    startAcpAgentLogin: vi.fn(),
  },
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
});
