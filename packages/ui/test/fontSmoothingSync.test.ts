// @vitest-environment jsdom
// macOS font smoothing preference: default on, persisted as "true"/"false" under the 3.18.1 key,
// reflected as an <html> class, and broadcast-synced without a rebroadcast loop.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastMessage, IBroadcastService } from "@zcode/services";
import { createZCodeStore } from "@/store/index.js";

const STORAGE_KEY = "zcode-macos-font-smoothing";

function createBroadcastHarness() {
  const listeners = new Set<(message: BroadcastMessage) => void>();
  const send = vi.fn(async () => {});
  const service = {
    send,
    onMessage: (listener: (message: BroadcastMessage) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  } as unknown as IBroadcastService;
  const emit = (message: BroadcastMessage) => {
    for (const listener of listeners) listener(message);
  };
  return { service, send, emit };
}

describe("font smoothing preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("font-smoothing-enabled");
  });

  it("defaults to enabled when nothing is stored", () => {
    const store = createZCodeStore(createBroadcastHarness().service);

    expect(store.getState().fontSmoothingEnabled).toBe(true);
    expect(document.documentElement.classList.contains("font-smoothing-enabled")).toBe(true);
  });

  it("reads a stored 'false' as disabled", () => {
    localStorage.setItem(STORAGE_KEY, "false");

    const store = createZCodeStore(createBroadcastHarness().service);

    expect(store.getState().fontSmoothingEnabled).toBe(false);
    expect(document.documentElement.classList.contains("font-smoothing-enabled")).toBe(false);
  });

  it("persists a local change, toggles the class, and broadcasts it once", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    harness.send.mockClear();

    store.getState().setFontSmoothingEnabled(false);

    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    expect(document.documentElement.classList.contains("font-smoothing-enabled")).toBe(false);
    const broadcasts = harness.send.mock.calls
      .map(([message]) => message as BroadcastMessage)
      .filter((message) => message.channel === "state:fontSmoothingEnabled");
    expect(broadcasts.map((message) => message.payload)).toEqual([false]);
  });

  it("applies a received boolean without rebroadcasting it", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);
    harness.send.mockClear();

    harness.emit({ channel: "state:fontSmoothingEnabled", payload: false });

    expect(store.getState().fontSmoothingEnabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    expect(
      harness.send.mock.calls.filter(
        ([message]) => (message as BroadcastMessage).channel === "state:fontSmoothingEnabled",
      ),
    ).toHaveLength(0);
  });

  it("ignores a received non-boolean payload", () => {
    const harness = createBroadcastHarness();
    const store = createZCodeStore(harness.service);

    harness.emit({ channel: "state:fontSmoothingEnabled", payload: "false" });

    expect(store.getState().fontSmoothingEnabled).toBe(true);
  });
});
