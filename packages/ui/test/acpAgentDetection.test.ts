// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AcpAgentDetectionResult,
  AcpAgentSummary,
  IProviderSettingsService,
} from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import {
  formatAcpScanError,
  useAcpAgentDetection,
} from "@/settings/model-provider-section/AcpAgentsPanel.js";
import { createRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

// One stable service object, as the real container provides; a fresh object per render would re-run the scan effect.
const providerSettingsService = { detectAcpAgents: vi.fn() };
const detectAcpAgents = providerSettingsService.detectAcpAgents;
const service = providerSettingsService as unknown as IProviderSettingsService;

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
    const { result: hook } = renderHook(() => useAcpAgentDetection(service, true));
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(detectAcpAgents).toHaveBeenCalledTimes(1);
    expect(hook.current.agents.map((item) => item.agentId)).toEqual(["opencode"]);
  });

  it("reports the host's supported flag and keeps no agents on an unsupported host", async () => {
    // Availability is the host's answer (specs/acp-agent-runtime.md "Availability (platform rule)").
    detectAcpAgents.mockReset();
    detectAcpAgents.mockResolvedValue({ supported: false, agents: [], detectedAt: 0 });
    const { result: hook } = renderHook(() => useAcpAgentDetection(service, true));
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(hook.current.supported).toBe(false);
    expect(hook.current.agents).toEqual([]);
  });

  it("drops a stale response that arrives after a newer rescan", async () => {
    detectAcpAgents.mockReset();
    const first = deferred<AcpAgentDetectionResult>();
    const second = deferred<AcpAgentDetectionResult>();
    detectAcpAgents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result: hook } = renderHook(() => useAcpAgentDetection(service, true));
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

// specs/acp-agent-runtime.md "Settings: workspace host" (WH3–WH5).
describe("useAcpAgentDetection on the workspace host", () => {
  function hostService() {
    const detect = vi.fn();
    return { detect, service: { detectAcpAgents: detect } as unknown as IProviderSettingsService };
  }

  it("WH3: sends no call without a remote attachment and scans once it is attached", async () => {
    const waiting = hostService();
    const attached = hostService();
    attached.detect.mockResolvedValue(result([agent("codex", true)]));
    const { result: hook, rerender } = renderHook(
      ({ host, ready }: { host: IProviderSettingsService; ready: boolean }) =>
        useAcpAgentDetection(host, ready),
      { initialProps: { host: waiting.service, ready: false } },
    );
    expect(hook.current.status).toBe("error");
    expect(hook.current.disconnected).toBe(true);
    act(() => hook.current.rescan());
    expect(waiting.detect).not.toHaveBeenCalled();
    expect(formatAcpScanError(hook.current, (id) => id)).toBe(
      "settings.modelProvider.acp.remoteDisconnected",
    );

    rerender({ host: attached.service, ready: true });
    await waitFor(() => expect(hook.current.status).toBe("ready"));
    expect(attached.detect).toHaveBeenCalledTimes(1);
    expect(hook.current.agents.map((item) => item.agentId)).toEqual(["codex"]);
    expect(hook.current.disconnected).toBeFalsy();
  });

  it("WH4: a disconnected-code failure is shown as the not-connected message, not the raw code", async () => {
    const host = hostService();
    host.detect.mockRejectedValue(createRemoteWorkspaceDisconnectedError());
    const { result: hook } = renderHook(() => useAcpAgentDetection(host.service, true));
    await waitFor(() => expect(hook.current.status).toBe("error"));
    expect(hook.current.disconnected).toBe(true);
    expect(formatAcpScanError(hook.current, (id) => id)).toBe(
      "settings.modelProvider.acp.remoteDisconnected",
    );
  });

  it("WH11: a disconnected rescan replaces the host's earlier agents with the error", async () => {
    const host = hostService();
    host.detect.mockResolvedValueOnce(result([agent("opencode", true)]));
    const { result: hook } = renderHook(() => useAcpAgentDetection(host.service, true));
    await waitFor(() => expect(hook.current.status).toBe("ready"));

    host.detect.mockRejectedValueOnce(createRemoteWorkspaceDisconnectedError());
    await act(async () => {
      hook.current.rescan();
    });

    await waitFor(() => expect(hook.current.status).toBe("error"));
    expect(hook.current.agents).toEqual([]);
    expect(hook.current.disconnected).toBe(true);
    // Retry stays available: the attachment exists, so the next scan can run.
    expect(hook.current.awaitingHost).toBeUndefined();
  });

  it("keeps the earlier agents when a rescan fails for another reason", async () => {
    const host = hostService();
    host.detect.mockResolvedValueOnce(result([agent("opencode", true)]));
    const { result: hook } = renderHook(() => useAcpAgentDetection(host.service, true));
    await waitFor(() => expect(hook.current.status).toBe("ready"));

    host.detect.mockRejectedValueOnce(new Error("spawn failed"));
    await act(async () => {
      hook.current.rescan();
    });

    await waitFor(() => expect(hook.current.error).toBe("spawn failed"));
    expect(hook.current.status).toBe("ready");
    expect(hook.current.agents.map((item) => item.agentId)).toEqual(["opencode"]);
  });

  it("WH5: a host change drops the previous host's agents and its late answer", async () => {
    const hostA = hostService();
    const hostB = hostService();
    hostA.detect.mockResolvedValueOnce(result([agent("opencode", true)]));
    const { result: hook, rerender } = renderHook(
      ({ host }: { host: IProviderSettingsService }) => useAcpAgentDetection(host, true),
      { initialProps: { host: hostA.service } },
    );
    await waitFor(() => expect(hook.current.status).toBe("ready"));

    // A rescan of host A is in flight when the workspace host becomes B.
    const lateA = deferred<AcpAgentDetectionResult>();
    hostA.detect.mockReturnValueOnce(lateA.promise);
    act(() => hook.current.rescan());
    const answerB = deferred<AcpAgentDetectionResult>();
    hostB.detect.mockReturnValueOnce(answerB.promise);
    rerender({ host: hostB.service });
    expect(hook.current.status).toBe("loading");
    expect(hook.current.agents).toEqual([]);

    await act(async () => {
      answerB.resolve(result([agent("claude", true)]));
    });
    await act(async () => {
      lateA.resolve(result([agent("gemini", true)]));
    });
    expect(hook.current.agents.map((item) => item.agentId)).toEqual(["claude"]);
    expect(hostB.detect).toHaveBeenCalledTimes(1);
  });
});
