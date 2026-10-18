// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { useOpenExistingSession } from "@/hooks/useOpenExistingSession.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  bindRemoteWorkspaceIdentity,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
});

function setup(stat = vi.fn(async () => ({ path: "/closed", type: "directory" }))) {
  const services = {
    fileService: { stat },
    gitService: { getLocalBranches: vi.fn(async () => ({ branches: [] })) },
    zcodeTaskService: { setTaskUnread: vi.fn(async () => ({ unreadAt: undefined })) },
  } as unknown as IServiceAccessor;
  registerBaseWorkspaceServices(services);
  const wrapper = ({ children }: { children?: ReactNode }) =>
    createElement(
      ServiceProvider,
      { services },
      createElement(
        TabStoreProvider,
        null,
        createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, children),
      ),
    );
  return { services, wrapper };
}

describe("sessions Settings navigation", () => {
  it("opens a closed project and its existing task, then Settings Back returns to that project", async () => {
    const { wrapper, services } = setup();
    const { result } = renderHook(
      () => ({ open: useOpenExistingSession(), tabs: useTabStoreApi() }),
      { wrapper },
    );
    act(() => {
      result.current.tabs.getState().addTab("/before");
      result.current.tabs.getState().openSettingsTab();
    });
    await act(() => result.current.open({ workspacePath: "/closed", taskId: "existing-task" }));
    expect(services.fileService.stat).toHaveBeenCalledWith({ path: "/closed" });
    expect(result.current.tabs.getState().activeWorkspacePath).toBe("/closed");
    expect(useZCodeSessionStore.getState().getWorkspaceState("/closed").activeTaskId).toBe(
      "existing-task",
    );
    act(() => result.current.tabs.getState().openSettingsTab());
    act(() => {
      expect(result.current.tabs.getState().activateTabByPath("/closed")).toBe(true);
    });
    expect(result.current.tabs.getState().activeWorkspacePath).toBe("/closed");
  });

  it("activates the local tab, not a remote tab sharing the same path, for a local session", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => ({ open: useOpenExistingSession(), tabs: useTabStoreApi() }),
      { wrapper },
    );
    let localTabId = "";
    act(() => {
      localTabId = result.current.tabs.getState().addTab("/same");
      result.current.tabs.getState().addTab("/same", {
        workspaceIdentity: "remote:a:/same",
        remoteSessionId: "a",
      });
      result.current.tabs.getState().openSettingsTab();
    });
    await act(() => result.current.open({ workspacePath: "/same", taskId: "local-task" }));
    expect(result.current.tabs.getState().activeTabId).toBe(localTabId);
    expect(result.current.tabs.getState().activeWorkspaceIdentity).toBeNull();
    expect(useZCodeSessionStore.getState().getWorkspaceState("/same").activeTaskId).toBe(
      "local-task",
    );
  });

  it("keeps Settings active when the directory is unavailable and never probes a remote path locally", async () => {
    const stat = vi.fn(async () => {
      throw new Error("unavailable directory");
    });
    const { wrapper } = setup(stat);
    const { result } = renderHook(
      () => ({ open: useOpenExistingSession(), tabs: useTabStoreApi() }),
      { wrapper },
    );
    act(() => {
      result.current.tabs.getState().addTab("/before");
      result.current.tabs.getState().openSettingsTab();
    });
    const before = result.current.tabs.getState().activeTabId;
    await expect(
      result.current.open({ workspacePath: "/missing", taskId: "task" }),
    ).rejects.toThrow("unavailable");
    expect(result.current.tabs.getState().activeTabId).toBe(before);
    await expect(
      result.current.open({
        workspacePath: "/missing",
        workspaceIdentity: "remote:a:/missing",
        taskId: "task",
      }),
    ).rejects.toThrow();
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("routes identical paths to the selected remote attachment and fails closed after disconnect", async () => {
    const { wrapper, services } = setup();
    const remoteA = {
      ...services,
      gitService: { getLocalBranches: vi.fn(async () => ({ branches: ["a"] })) },
    } as unknown as IServiceAccessor;
    const remoteB = {
      ...services,
      gitService: { getLocalBranches: vi.fn(async () => ({ branches: ["b"] })) },
    } as unknown as IServiceAccessor;
    registerRemoteWorkspaceSession({ sessionId: "a", services: remoteA });
    registerRemoteWorkspaceSession({ sessionId: "b", services: remoteB });
    bindRemoteWorkspaceIdentity("remote:a:/same", "a");
    bindRemoteWorkspaceIdentity("remote:b:/same", "b");
    const { result, rerender } = renderHook(
      () => useWorkspaceServicesResolution("/same", "b", "remote:b:/same"),
      { wrapper },
    );
    await result.current.services.gitService.getLocalBranches({ workspacePath: "/same" });
    expect(remoteB.gitService.getLocalBranches).toHaveBeenCalledTimes(1);
    expect(remoteA.gitService.getLocalBranches).not.toHaveBeenCalled();
    expect(services.gitService.getLocalBranches).not.toHaveBeenCalled();
    act(() =>
      useRemoteWorkspaceSessionStore.setState({
        sessionsById: { a: { sessionId: "a", services: remoteA } },
      }),
    );
    rerender();
    expect(result.current.rpcReady).toBe(false);
    await expect(
      result.current.services.gitService.getLocalBranches({ workspacePath: "/same" }),
    ).rejects.toThrow();
    expect(services.gitService.getLocalBranches).not.toHaveBeenCalled();
  });
});
