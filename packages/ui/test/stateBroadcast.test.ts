// @vitest-environment jsdom
// Cross-window state sync (store/stateBroadcast.ts): local changes broadcast once, received
// changes apply without rebroadcasting, and the Host broadcast service's local echo
// (broadcastService.send fires this window's emitter first) does not create a loop.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastMessage, IBroadcastService } from "@zcode/services";
import { createZCodeStore } from "@/store/index.js";

type BroadcastListener = (message: BroadcastMessage) => void;

function createBroadcastHarness({ echoLocally }: { echoLocally: boolean }) {
  const listeners = new Set<BroadcastListener>();
  const emit = (message: BroadcastMessage) => {
    for (const listener of listeners) {
      listener(message);
    }
  };
  const send = vi.fn(async (message: BroadcastMessage) => {
    if (echoLocally) {
      emit(message);
    }
  });
  const service = {
    send,
    onMessage: (listener: BroadcastListener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  } as unknown as IBroadcastService;
  return { service, send, emit };
}

function stateMessages(send: ReturnType<typeof vi.fn>, channel: string): unknown[] {
  return send.mock.calls
    .map(([message]) => message as BroadcastMessage)
    .filter((message) => message.channel === channel)
    .map((message) => message.payload);
}

describe("wireStateBroadcast", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("broadcasts a local change exactly once", () => {
    const harness = createBroadcastHarness({ echoLocally: false });
    const store = createZCodeStore(harness.service);

    store.getState().setUiFontSizePx(16);

    expect(stateMessages(harness.send, "state:uiFontSizePx")).toEqual([16]);
  });

  it("applies a received change without rebroadcasting it", () => {
    const harness = createBroadcastHarness({ echoLocally: false });
    const store = createZCodeStore(harness.service);
    harness.send.mockClear();

    harness.emit({ channel: "state:uiFontSizePx", payload: 18 });

    expect(store.getState().uiFontSizePx).toBe(18);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("does not loop on the local echo of its own broadcast", () => {
    const harness = createBroadcastHarness({ echoLocally: true });
    const store = createZCodeStore(harness.service);

    // The default selection is dark, so switch to light to produce a real change.
    store.getState().setTheme("light");

    expect(store.getState().theme).toBe("light");
    expect(stateMessages(harness.send, "state:theme")).toEqual(["light"]);
  });

  it("ignores unknown fields and payloads of the wrong type", () => {
    const harness = createBroadcastHarness({ echoLocally: false });
    const store = createZCodeStore(harness.service);
    const before = store.getState().uiFontSizePx;
    harness.send.mockClear();

    harness.emit({ channel: "state:unknownField", payload: "x" });
    harness.emit({ channel: "state:uiFontSizePx", payload: "18" });

    expect(store.getState().uiFontSizePx).toBe(before);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("keeps broadcasting local changes after applying a received one", () => {
    const harness = createBroadcastHarness({ echoLocally: false });
    const store = createZCodeStore(harness.service);
    harness.emit({ channel: "state:uiFontSizePx", payload: 18 });
    harness.send.mockClear();

    store.getState().setUiFontSizePx(14);

    expect(stateMessages(harness.send, "state:uiFontSizePx")).toEqual([14]);
  });
});
