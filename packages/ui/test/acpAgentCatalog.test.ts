// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { AcpAgentSummary } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpAgentCatalogDetail } from "@/settings/model-provider-section/AcpAgentsPanel.js";
import { ACP_AGENT_CATALOG } from "@/settings/model-provider-section/acpAgentConfig.js";

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService: { detectAcpAgents: vi.fn() } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openExternal: vi.fn() }),
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

function summary(agentId: string, installed: boolean): AcpAgentSummary {
  return {
    agentId,
    displayName: agentId,
    installed,
    version: installed ? "1.0.0" : null,
    commandPath: installed ? `/bin/${agentId}` : null,
    spawnArgs: ["acp"],
    loginArgs: [],
    statusArgs: null,
  };
}

describe("AcpAgentCatalogDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the documented install command only for agents that are not installed", () => {
    render(
      createElement(AcpAgentCatalogDetail, {
        status: "empty",
        detection: {
          status: "ready",
          supported: true,
          refreshing: false,
          agents: [summary("opencode", false), summary("cursor", true)],
          rescan: vi.fn(),
        },
      }),
    );

    expect(screen.getByText(ACP_AGENT_CATALOG.opencode.installCommand)).toBeTruthy();
    expect(screen.queryByText(ACP_AGENT_CATALOG.cursor.installCommand)).toBeNull();
  });
});
