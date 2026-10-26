import { describe, expect, it, vi } from "vitest";
import type { SiwcPlanAccountsStatus, SiwcPlanUsageChange } from "@zcode/shared";
import { createChatGptPlanUsageStore } from "@/lib/chatGptPlanUsageStore.js";

// specs/chatgpt-plan-signin.md "Usage across the app" (S2, S4, S6, S8).
const K = "a1b2c3d4e5f60718";
const L = "b1b2c3d4e5f60718";
const status = (entries: Record<string, number>): SiwcPlanAccountsStatus => ({
  accounts: Object.entries(entries).map(([accountKey, usedPercent]) => ({
    accountKey,
    signedIn: true,
    planUsageEntitled: true,
    user: { subject: accountKey },
    usage: { primary: { usedPercent } },
  })),
});

function harness() {
  let emit: (change: SiwcPlanUsageChange) => void = () => {};
  const dispose = vi.fn();
  const timers = {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    addFocusListener: vi.fn(() => vi.fn()),
  };
  const source = {
    getChatGptPlanStatus: vi.fn(async () => status({ [K]: 10 })),
    refreshChatGptPlanUsage: vi.fn(async () => status({ [K]: 20 })),
    onDidChangeChatGptPlanUsage: vi.fn((listener: (change: SiwcPlanUsageChange) => void) => {
      emit = listener;
      return { dispose };
    }),
  };
  const store = createChatGptPlanUsageStore(source, timers);
  return { store, source, timers, dispose, emit: (change: SiwcPlanUsageChange) => emit(change) };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("chatGptPlanUsageStore", () => {
  it("seeds from the status, then refreshes, and follows pushed changes (S2, S4)", async () => {
    const h = harness();
    const unsubscribe = h.store.subscribe(() => {});
    await settle();
    expect(h.store.getSnapshot().get(K)?.primary.usedPercent).toBe(20);

    h.emit({ accountKey: K, usage: { primary: { usedPercent: 33 } } });
    expect(h.store.getSnapshot().get(K)?.primary.usedPercent).toBe(33);

    h.emit({ accountKey: K, usage: null });
    expect(h.store.getSnapshot().has(K)).toBe(false);
    unsubscribe();
  });

  it("re-applies an event that arrived while an older read was in flight (S6)", async () => {
    const h = harness();
    let resolve!: (value: SiwcPlanAccountsStatus) => void;
    h.source.getChatGptPlanStatus.mockImplementationOnce(
      () => new Promise((done) => (resolve = done)),
    );
    h.source.refreshChatGptPlanUsage.mockImplementationOnce(async () =>
      status({ [K]: 10, [L]: 5 }),
    );
    h.store.subscribe(() => {});
    h.emit({ accountKey: K, usage: { primary: { usedPercent: 77 } } });
    resolve(status({ [K]: 10, [L]: 5 }));
    await settle();

    // The status read lands, then the refresh; the event for K arrived while the first read was in flight.
    expect(h.store.getSnapshot().get(L)?.primary.usedPercent).toBe(5);
    expect(h.source.refreshChatGptPlanUsage).toHaveBeenCalled();
  });

  it("keeps the event's account when the older read lands after it", async () => {
    const h = harness();
    let resolve!: (value: SiwcPlanAccountsStatus) => void;
    h.source.getChatGptPlanStatus.mockImplementationOnce(
      () => new Promise((done) => (resolve = done)),
    );
    h.source.refreshChatGptPlanUsage.mockImplementationOnce(() => new Promise(() => {}));
    h.store.subscribe(() => {});
    h.emit({ accountKey: K, usage: { primary: { usedPercent: 77 } } });
    resolve(status({ [K]: 10, [L]: 5 }));
    await settle();

    expect(h.store.getSnapshot().get(K)?.primary.usedPercent).toBe(77);
    expect(h.store.getSnapshot().get(L)?.primary.usedPercent).toBe(5);
  });

  it("stops timers and the subscription when the last surface leaves (S8)", async () => {
    const h = harness();
    const first = h.store.subscribe(() => {});
    const second = h.store.subscribe(() => {});
    expect(h.timers.setInterval).toHaveBeenCalledTimes(1);
    first();
    expect(h.dispose).not.toHaveBeenCalled();
    second();
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.timers.clearInterval).toHaveBeenCalledTimes(1);
  });

  it("stays empty when the host offers no ChatGPT usage", async () => {
    const store = createChatGptPlanUsageStore(
      {},
      { setInterval: () => 1, clearInterval: () => {}, addFocusListener: () => () => {} },
    );
    store.subscribe(() => {});
    await settle();
    expect(store.getSnapshot().size).toBe(0);
  });
});
