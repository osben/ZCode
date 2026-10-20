// @vitest-environment jsdom

// The pen of the draft (docs/dynamic-workflow/presentation.md "The draft and the pen"): one station at a
// time, 24 ms per character, a 120 ms pause between stations; stations the pen has not reached are not
// revealed; a name that grows mid-write keeps being written; catching up with the stream means idle.
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PEN_GAP_MS,
  PEN_MS,
  useTypewriter,
} from "@/components/workflow-timeline/use-typewriter.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Each character the pen writes is a setState → effect that schedules the next timer; one advance can
// only take one step, so we move forward step by step in segments.
function tick(ms: number) {
  let left = ms;
  do {
    const step = Math.min(PEN_MS, left);
    act(() => {
      vi.advanceTimersByTime(step);
    });
    left -= step;
  } while (left > 0);
}

describe("useTypewriter", () => {
  it("第一站立即揭示、逐字写出；写完才停一拍揭示下一站", () => {
    const view = renderHook(({ names }: { names: string[] | undefined }) => useTypewriter(names), {
      initialProps: { names: ["plan", "verify"] as string[] | undefined },
    });
    expect(view.result.current).toMatchObject({ idle: false, shown: [0], visible: 1 });

    tick(PEN_MS * 2);
    expect(view.result.current.shown).toEqual([2]);
    tick(PEN_MS * 2);
    expect(view.result.current).toMatchObject({ idle: false, shown: [4], visible: 1 });

    // Finished writing the plan: waits 120 ms before revealing verify (the second station is still off
    // the track during that time).
    tick(PEN_GAP_MS - 1);
    expect(view.result.current.visible).toBe(1);
    tick(1);
    expect(view.result.current).toMatchObject({ shown: [4, 0], visible: 2 });

    tick(PEN_MS * 6);
    expect(view.result.current).toMatchObject({ idle: true, shown: [4, 6], visible: 2 });
  });

  it("名字中途变长（未闭合的标记又来了字）笔接着写；换成新数组但内容不变不会打断笔", () => {
    const view = renderHook(({ names }: { names: string[] }) => useTypewriter(names), {
      initialProps: { names: ["ver"] },
    });
    tick(PEN_MS * 3);
    expect(view.result.current).toMatchObject({ idle: true, shown: [3] });

    view.rerender({ names: ["verify"] });
    expect(view.result.current.idle).toBe(false);
    tick(PEN_MS * 3);
    expect(view.result.current).toMatchObject({ idle: true, shown: [6] });

    // The script swaps in a new array on every arriving chunk: the content is unchanged, so the pen's
    // position neither moves nor resets.
    view.rerender({ names: ["verify"] });
    expect(view.result.current).toMatchObject({ idle: true, shown: [6], visible: 1 });
  });

  it("名字在前缀上变了（流式下的稳健性）退回公共前缀；不是草稿时静默", () => {
    const view = renderHook(({ names }: { names: string[] | undefined }) => useTypewriter(names), {
      initialProps: { names: ["plan"] as string[] | undefined },
    });
    tick(PEN_MS * 4);
    expect(view.result.current.shown).toEqual([4]);
    view.rerender({ names: ["plot"] });
    tick(0);
    expect(view.result.current.shown[0]).toBe(2);

    view.rerender({ names: undefined });
    expect(view.result.current).toEqual({ idle: false, shown: [], visible: 0 });
  });

  it("两站一起到：第二站等第一站写完再揭示", () => {
    const view = renderHook(() => useTypewriter(["a", "b"]));
    tick(PEN_MS);
    expect(view.result.current).toMatchObject({ shown: [1], visible: 1 });
    tick(PEN_GAP_MS);
    expect(view.result.current).toMatchObject({ shown: [1, 0], visible: 2 });
  });

  it("空草稿（还没有一站）笔静默：不揭示不存在的站，也不空转；第一站到了才揭示，站数回到 0 笔收回", async () => {
    // Not using renderHook/act: this used to be an infinite loop (reveal station 1 → station count
    // clipped back to 0 → reveal again…), and act would keep flushing the loop until the worker ran
    // out of memory, never showing the actual failure. Real timers + a bare createRoot to count renders.
    vi.useRealTimers();
    const globalWithAct = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousAct = globalWithAct.IS_REACT_ACT_ENVIRONMENT;
    globalWithAct.IS_REACT_ACT_ENVIRONMENT = false;
    let renders = 0;
    let last: ReturnType<typeof useTypewriter> | undefined;
    function Probe({ names }: { names: string[] }) {
      renders += 1;
      last = useTypewriter(names);
      return null;
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      root.render(createElement(Probe, { names: [] }));
      await settle();
      expect(renders).toBeLessThanOrEqual(2);
      expect(last).toEqual({ idle: false, shown: [], visible: 0 });

      root.render(createElement(Probe, { names: ["plan"] }));
      await settle();
      expect(last).toMatchObject({ visible: 1 });

      const before = renders;
      root.render(createElement(Probe, { names: [] }));
      await settle();
      expect(renders).toBeLessThanOrEqual(before + 2);
      expect(last).toEqual({ idle: false, shown: [], visible: 0 });
    } finally {
      root.unmount();
      host.remove();
      globalWithAct.IS_REACT_ACT_ENVIRONMENT = previousAct;
    }
  });

  it("prefers-reduced-motion：整站立即写完是渲染时派生的，站名变长不再多一轮 setState", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes("reduce"),
        media: query,
      }) as MediaQueryList) as typeof window.matchMedia;
    try {
      let renders = 0;
      const view = renderHook(
        ({ names }: { names: string[] }) => {
          renders += 1;
          return useTypewriter(names);
        },
        { initialProps: { names: ["ver"] } },
      );
      // Revealing the first station is the only setState; the name was already written in full.
      expect(renders).toBe(2);
      expect(view.result.current).toMatchObject({ idle: true, shown: [3], visible: 1 });

      view.rerender({ names: ["verify"] });
      expect(renders).toBe(3);
      expect(view.result.current).toMatchObject({ idle: true, shown: [6], visible: 1 });

      // Still revealed station by station: the second station waits one beat before entering the
      // track, and comes in fully written.
      view.rerender({ names: ["verify", "publish"] });
      expect(view.result.current).toMatchObject({ idle: false, shown: [6], visible: 1 });
      tick(PEN_GAP_MS);
      expect(view.result.current).toMatchObject({ idle: true, shown: [6, 7], visible: 2 });
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});
