import { describe, expect, it, vi } from "vitest";
import { RefreshSingleflight } from "../src/node/refreshSingleflight.js";

describe("refresh singleflight", () => {
  it("upgrades overlapping cached reads to exactly one forced refresh", async () => {
    const flights = new RefreshSingleflight<string>();
    const refresh = vi.fn(async (mark: () => void) => {
      mark();
      return "new";
    });
    const normal = flights.resolve("a", false, async () => "old");
    const first = flights.resolve("a", true, refresh);
    const second = flights.resolve("a", true, refresh);
    expect(await normal).toBe("old");
    expect(await Promise.all([first, second])).toEqual(["new", "new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("joins an actual proactive refresh and isolates a cancelled waiter", async () => {
    const flights = new RefreshSingleflight<string>();
    let release!: (value: string) => void;
    const run = vi.fn(async (mark: () => void) => {
      mark();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const first = flights.resolve("a", false, run, controller.signal);
    const cancelled = expect(first).rejects.toThrow("cancelled");
    const second = flights.resolve("a", true, run);
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    release("new");
    await cancelled;
    expect(await second).toBe("new");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
