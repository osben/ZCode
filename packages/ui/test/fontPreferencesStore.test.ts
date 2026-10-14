// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IBroadcastService } from "@zcode/services";
import { MONO_FONT_FAMILY_STORAGE_KEY, UI_FONT_FAMILY_STORAGE_KEY } from "@/lib/uiFonts.js";
import { createZCodeStore } from "@/store/index.js";

describe("font preference store synchronization", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--font-sans");
    document.documentElement.style.removeProperty("--font-mono");
  });

  it("persists local changes, broadcasts them, and applies incoming changes without rebroadcast", () => {
    let receive: Parameters<IBroadcastService["onMessage"]>[0] | undefined;
    const send = vi.fn(async () => {});
    const service: IBroadcastService = {
      send,
      acquireClaim: async () => ({ status: "unavailable" }),
      commitClaim: async () => {},
      releaseClaim: async () => {},
      tryClaim: async () => false,
      onMessage: (listener) => {
        receive = listener;
        return { dispose: () => {} };
      },
    };
    const store = createZCodeStore(service);

    store.getState().setUiFontFamily("Inter Test");
    expect(localStorage.getItem(UI_FONT_FAMILY_STORAGE_KEY)).toBe("Inter Test");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toContain("Inter Test");
    expect(send).toHaveBeenCalledWith({ channel: "state:uiFontFamily", payload: "Inter Test" });

    send.mockClear();
    receive?.({ channel: "state:monoFontFamily", payload: "Mono Test" });
    expect(store.getState().monoFontFamily).toBe("Mono Test");
    expect(localStorage.getItem(MONO_FONT_FAMILY_STORAGE_KEY)).toBe("Mono Test");
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toContain("Mono Test");
    expect(send).not.toHaveBeenCalled();
  });
});
