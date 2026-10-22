// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { AcpAgentDetectionResult, AcpAgentSummary } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { useAcpAgentDetection } from "@/settings/model-provider-section/AcpAgentsPanel.js";

// One stable service object, as the real container provides; a fresh object per render would re-run the scan effect.
const { providerSettingsService } = vi.hoisted(() => ({
  providerSettingsService: { detectAcpAgents: vi.fn() },
}));
const detectAcpAgents = providerSettingsService.detectAcpAgents;

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ providerSettingsService }),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function agent(agentId: string, installed: boolean): AcpAgentSummary {
  return {
    agentId,
    displayName: agentId,
    installed,
    version: null,
    commandPath: installed ? `/bin/${agentId}` : null,
    spawnArgs: ["acp"],
    loginArgs: [],
    statusArgs: null,
  };
}

function result(agents: AcpAgentSummary[]): AcpAgentDetectionResult {
  return { supported: true, agents, detectedAt: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useAcpAgentDetection", () => {
  it("runs one detection per mount", async () => {
    detectAcpAgents.mockReset();
    detectAcpAgents.mockResolvedValue(result([agent("opencode", true)]));
    const { result: hook } = renderHook(() => useAcpAgentDetection({ enabled: true }));
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(detectAcpAgents).toHaveBeenCalledTimes(1);
    expect(hook.current.agents.map((item) => item.agentId)).toEqual(["opencode"]);
  });

  it("probes nothing while the gate is off", () => {
    detectAcpAgents.mockReset();
    renderHook(() => useAcpAgentDetection({ enabled: false }));
    expect(detectAcpAgents).not.toHaveBeenCalled();
  });

  it("drops a stale response that arrives after a newer rescan", async () => {
    detectAcpAgents.mockReset();
    const first = deferred<AcpAgentDetectionResult>();
    const second = deferred<AcpAgentDetectionResult>();
    detectAcpAgents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result: hook } = renderHook(() => useAcpAgentDetection({ enabled: true }));
    act(() => hook.current.rescan());
    await act(async () => {
      second.resolve(result([agent("cursor", true)]));
    });
    await act(async () => {
      first.resolve(result([agent("opencode", true)]));
    });
    expect(hook.current.agents.map((item) => item.agentId)).toEqual(["cursor"]);
    expect(hook.current.refreshing).toBe(false);
  });
});
