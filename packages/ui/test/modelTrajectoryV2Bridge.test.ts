// v2 轨迹入口复用 v1 的单例 store 桥（modelTrajectoryStore + useModelTrajectoryOpenBridge），
// 仅靠 request.kind 区分 v1/v2。这里钉住两个契约：kind 缺省仍表示 v1；bridge 原样转发 kind，
// 由 useAppPanels.handleOpenModelTrajectory 按 kind 路由到对应 opener。
// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";

function resetStore() {
  useModelTrajectoryStore.setState({ pendingRequest: null });
}

afterEach(() => {
  // 拆掉上一个用例的订阅，否则旧 hook 会先消费新请求（bridge 的多 workspace 防串设计）。
  cleanup();
  resetStore();
  vi.restoreAllMocks();
});

describe("modelTrajectoryStore kind routing", () => {
  it("defaults to v1 semantics when kind is absent", () => {
    useModelTrajectoryStore.getState().requestOpen({
      taskId: "task-1",
      workspaceKey: "/workspace",
    });
    const pending = useModelTrajectoryStore.getState().pendingRequest;
    expect(pending).toMatchObject({ taskId: "task-1", workspaceKey: "/workspace" });
    expect(pending?.kind).toBeUndefined();
  });

  it("preserves kind: v2 so the handler routes to the v2 opener", () => {
    useModelTrajectoryStore.getState().requestOpen({
      taskId: "task-1",
      workspaceKey: "/workspace",
      kind: "v2",
    });
    expect(useModelTrajectoryStore.getState().pendingRequest?.kind).toBe("v2");
  });

  it("consumes the pending request by id so other workspaces skip it", () => {
    useModelTrajectoryStore.getState().requestOpen({
      taskId: "task-1",
      workspaceKey: "/workspace",
      kind: "v2",
    });
    const requestId = useModelTrajectoryStore.getState().pendingRequest?.requestId;
    useModelTrajectoryStore.getState().consumeRequest(requestId!);
    expect(useModelTrajectoryStore.getState().pendingRequest).toBeNull();
  });
});

describe("useModelTrajectoryOpenBridge kind forwarding", () => {
  it("forwards kind to the workspace handler and consumes the request", () => {
    const onOpen = vi.fn();
    renderHook(() => useModelTrajectoryOpenBridge("/workspace", onOpen));

    useModelTrajectoryStore.getState().requestOpen({
      taskId: "task-1",
      workspaceKey: "/workspace",
      kind: "v2",
    });

    expect(onOpen).toHaveBeenCalledWith({
      taskId: "task-1",
      title: undefined,
      kind: "v2",
    });
    expect(useModelTrajectoryStore.getState().pendingRequest).toBeNull();
  });

  it("forwards absent kind (v1 default) untouched", () => {
    const onOpen = vi.fn();
    renderHook(() => useModelTrajectoryOpenBridge("/workspace", onOpen));

    useModelTrajectoryStore.getState().requestOpen({
      taskId: "task-1",
      workspaceKey: "/workspace",
      title: "Demo",
    });

    expect(onOpen).toHaveBeenCalledWith({
      taskId: "task-1",
      title: "Demo",
      kind: undefined,
    });
  });

  it("ignores requests addressed to another workspace key", () => {
    const onOpen = vi.fn();
    renderHook(() => useModelTrajectoryOpenBridge("/workspace-a", onOpen));

    useModelTrajectoryStore.getState().requestOpen({
      taskId: "task-1",
      workspaceKey: "/workspace-b",
      kind: "v2",
    });

    expect(onOpen).not.toHaveBeenCalled();
    expect(useModelTrajectoryStore.getState().pendingRequest).not.toBeNull();
  });
});
