// @vitest-environment jsdom
// Sidebar Stop sends the status panel's cancelBackgroundWork command to the parent session on its
// own Host (spec: sidebar-child-conversation-counts.md §8.3).
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sender: null as null | ((envelope: unknown) => Promise<unknown>),
  toast: vi.fn(),
}));
vi.mock("@/hooks/useTaskConversationCommandSender.js", () => ({
  useTaskConversationCommandSender: () => mocks.sender,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { useStopChildBackgroundWork } from "@/hooks/useStopChildBackgroundWork.js";

const parent = { workspacePath: "/repo", sessionId: "parent" };

beforeEach(() => {
  mocks.toast.mockReset();
  mocks.sender = null;
});

it("sends cancelBackgroundWork for the parent with the child's work id", async () => {
  const send = vi.fn(async (envelope: { commandId: string }) => ({
    commandId: envelope.commandId,
    status: "accepted",
  }));
  mocks.sender = send as never;
  const { result } = renderHook(() =>
    useStopChildBackgroundWork(parent, "taskList.childStopFailed"),
  );
  await act(() => result.current("work-1"));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({
    type: "cancelBackgroundWork",
    sessionId: "parent",
    payload: { workId: "work-1" },
  });
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("toasts when the Host rejects, throws, or is not attached", async () => {
  mocks.sender = (async (envelope: { commandId: string }) => ({
    commandId: envelope.commandId,
    status: "rejected",
    reasonCode: "proto.notFound",
  })) as never;
  const rejected = renderHook(() => useStopChildBackgroundWork(parent, "taskList.childStopFailed"));
  await act(() => rejected.result.current("work-1"));
  mocks.sender = (async () => {
    throw new Error("offline");
  }) as never;
  const thrown = renderHook(() => useStopChildBackgroundWork(parent, "taskList.childStopFailed"));
  await act(() => thrown.result.current("work-1"));
  mocks.sender = null;
  const detached = renderHook(() => useStopChildBackgroundWork(parent, "taskList.childStopFailed"));
  await act(() => detached.result.current("work-1"));
  expect(mocks.toast).toHaveBeenCalledTimes(3);
  expect(mocks.toast).toHaveBeenCalledWith("taskList.childStopFailed");
});
