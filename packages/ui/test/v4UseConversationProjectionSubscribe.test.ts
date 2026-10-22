// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

function createLease(sessionId: string) {
  const state = { status: "ready" } as unknown as ConversationStoreState;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);
  const lease = {
    sessionId,
    store: { subscribe, getState: () => state },
  } as unknown as SessionLease;
  return { lease, state, subscribe, unsubscribe };
}

describe("useConversationProjection", () => {
  it("keeps one store subscription across rerenders of the same lease", () => {
    const { lease, state, subscribe, unsubscribe } = createLease("session-a");
    const { result, rerender } = renderHook(({ current }) => useConversationProjection(current), {
      initialProps: { current: lease },
    });

    rerender({ current: lease });
    rerender({ current: lease });

    expect(result.current).toBe(state);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("resubscribes when the lease store changes", () => {
    const a = createLease("session-a");
    const b = createLease("session-b");
    const { rerender } = renderHook(({ current }) => useConversationProjection(current), {
      initialProps: { current: a.lease },
    });

    rerender({ current: b.lease });

    expect(a.unsubscribe).toHaveBeenCalledOnce();
    expect(b.subscribe).toHaveBeenCalledOnce();
  });
});
