// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useBaseWorkspaceServices: vi.fn(),
  useWorkspaceServicesResolution: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: mocks.useBaseWorkspaceServices,
  useWorkspaceServicesResolution: mocks.useWorkspaceServicesResolution,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import { useSystemPromptOverrides } from "../src/hooks/useSystemPromptOverrides.js";

function makeService(content = "default:cli-prefix") {
  return {
    listSections: vi.fn(async () => ({
      sections: [
        {
          key: "cli-prefix",
          defaultContent: content,
          overrideContent: null,
          filePath: "/host/.zcode/system-prompt/cli-prefix.md",
          isOverridden: false,
        },
      ],
    })),
    writeOverride: vi.fn(async () => undefined),
    deleteOverride: vi.fn(async () => undefined),
    getOverridesDirectory: vi.fn(async () => ({ path: "/host/.zcode/system-prompt" })),
  };
}

const localTarget = { workspacePath: "/local/repo" };
const remoteTargetA = { workspacePath: "/remote/a", workspaceIdentity: "ssh:a" };
const remoteTargetB = { workspacePath: "/remote/b", workspaceIdentity: "ssh:b" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.toast.mockReset();
  mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: makeService() });
  mocks.useWorkspaceServicesResolution.mockReturnValue({
    isRemoteTarget: false,
    rpcReady: true,
    services: { systemPromptService: makeService() },
  });
});

afterEach(() => cleanup());

describe("useSystemPromptOverrides", () => {
  it("loads and writes through the local service for a local workspace", async () => {
    const service = makeService();
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: service });
    const { result } = renderHook(() => useSystemPromptOverrides(localTarget));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom local prefix");
    });
    await act(() => result.current.saveEditor());

    expect(service.listSections).toHaveBeenCalledTimes(2);
    expect(service.writeOverride).toHaveBeenCalledWith({
      key: "cli-prefix",
      content: "custom local prefix",
    });
  });

  it("uses the active remote service for load, save, and restore", async () => {
    const localService = makeService("local default");
    const remoteService = makeService("remote default");
    mocks.useBaseWorkspaceServices.mockReturnValue({ systemPromptService: localService });
    mocks.useWorkspaceServicesResolution.mockReturnValue({
      isRemoteTarget: true,
      rpcReady: true,
      services: { systemPromptService: remoteService },
    });
    const { result } = renderHook(() => useSystemPromptOverrides(remoteTargetA));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.sections[0]?.defaultContent).toBe("remote default");
    act(() => {
      result.current.openEditor("cli-prefix", "remote default");
      result.current.setDraft("custom remote prefix");
    });
    await act(() => result.current.saveEditor());
    await act(() => result.current.restoreDefault("cli-prefix"));

    expect(remoteService.writeOverride).toHaveBeenCalledWith({
      key: "cli-prefix",
      content: "custom remote prefix",
    });
    expect(remoteService.deleteOverride).toHaveBeenCalledWith({ key: "cli-prefix" });
    expect(localService.listSections).not.toHaveBeenCalled();
    expect(localService.writeOverride).not.toHaveBeenCalled();
    expect(localService.deleteOverride).not.toHaveBeenCalled();
  });

  it("keeps an in-flight write bound to the service it started on", async () => {
    const serviceA = makeService();
    const serviceB = makeService();
    const pendingWrite = deferred<void>();
    serviceA.writeOverride.mockImplementation(() => pendingWrite.promise);
    let currentService = serviceA;
    mocks.useWorkspaceServicesResolution.mockImplementation(() => ({
      isRemoteTarget: true,
      rpcReady: true,
      services: { systemPromptService: currentService },
    }));
    const { result, rerender } = renderHook(({ target }) => useSystemPromptOverrides(target), {
      initialProps: { target: remoteTargetA },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.openEditor("cli-prefix", "default:cli-prefix");
      result.current.setDraft("custom");
    });
    let save!: Promise<void>;
    act(() => {
      save = result.current.saveEditor();
    });

    currentService = serviceB;
    rerender({ target: remoteTargetB });
    await waitFor(() => expect(serviceB.listSections).toHaveBeenCalled());
    await act(async () => {
      pendingWrite.resolve();
      await save;
    });

    expect(serviceA.writeOverride).toHaveBeenCalledTimes(1);
    expect(serviceB.writeOverride).not.toHaveBeenCalled();
  });

  it("does not load or write through a remote service while the connection is not ready", async () => {
    const remoteService = makeService();
    mocks.useWorkspaceServicesResolution.mockReturnValue({
      isRemoteTarget: true,
      rpcReady: false,
      services: { systemPromptService: remoteService },
    });
    const { result } = renderHook(() => useSystemPromptOverrides(remoteTargetA));
    await waitFor(() => expect(result.current.status).toBe("waiting"));

    act(() => {
      result.current.openEditor("cli-prefix", "default");
      result.current.setDraft("custom");
    });
    await act(() => result.current.saveEditor());

    expect(remoteService.listSections).not.toHaveBeenCalled();
    expect(remoteService.writeOverride).not.toHaveBeenCalled();
  });
});
