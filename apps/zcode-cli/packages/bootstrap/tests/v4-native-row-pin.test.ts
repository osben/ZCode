import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";

function envelope(pinned: boolean): CommandEnvelope {
  return {
    commandId: "row-pin-command",
    clientId: "desktop-client",
    sessionId: "session-1",
    baseRevision: 4,
    baseLogEpoch: "epoch-1",
    type: "setRowPinned",
    payload: {
      target: { rowId: 9, entityId: "assistant-1" },
      pinned,
    },
    issuedAt: 1_700_000_000_000,
  };
}

function host(
  setRowPinned = vi.fn().mockResolvedValue(undefined),
  rowKind: "assistantText" | "userInput" | "reasoning" = "assistantText",
): V4CommandCoreHost {
  return {
    getRecord: () => ({ app: { sessionId: "session-1" } }) as never,
    resolveRowActionTarget: () =>
      ({
        ok: true,
        action: "setRowPinned",
        messageId: "assistant-1",
        row: { kind: rowKind },
      }) as never,
    setRowPinned,
  } as V4CommandCoreHost;
}

describe("v4 setRowPinned", () => {
  it("把 row CAS 解析出的 message/entity 与 pinned 交给持久化 host", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const executor = new V4CommandExecutor(host(persist));

    await executor.execute(envelope(true));

    expect(persist).toHaveBeenCalledWith("session-1", {
      entityId: "assistant-1",
      messageId: "assistant-1",
      pinned: true,
    });
  });

  it("userInput 行同样可以固定", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const executor = new V4CommandExecutor(host(persist, "userInput"));

    await executor.execute(envelope(true));

    expect(persist).toHaveBeenCalledWith("session-1", {
      entityId: "assistant-1",
      messageId: "assistant-1",
      pinned: true,
    });
  });

  it("stale row target 不写持久化", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const staleHost = host(persist);
    staleHost.resolveRowActionTarget = () =>
      ({ ok: false, status: "stale", reasonCode: "proto.staleTarget" }) as never;

    await expect(new V4CommandExecutor(staleHost).execute(envelope(true))).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });

  it("不支持的行 kind（reasoning）拒绝且不写持久化", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const executor = new V4CommandExecutor(host(persist, "reasoning"));

    await expect(executor.execute(envelope(false))).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
});
