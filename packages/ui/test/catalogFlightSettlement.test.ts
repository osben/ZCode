import { describe, expect, it } from "vitest";
import { catalogFlightSettlement } from "@/v4/composer/useDraftConfigControl.js";

// ocr #623: a hydration read that started before a slash catalog invalidation settles without
// overwriting a newer read, and never leaves the workspace status stuck at "loading".
describe("catalog hydration flight settlement", () => {
  it("writes the result when the catalog revision did not move", () => {
    for (const outcome of ["success", "failure"] as const) {
      expect(
        catalogFlightSettlement({
          outcome,
          stale: false,
          newerFlightInProgress: false,
          status: "loading",
        }),
      ).toBe("write");
    }
  });

  it("leaves the status to a newer read of the same workspace", () => {
    for (const outcome of ["success", "failure"] as const) {
      for (const status of ["loading", "ready"] as const) {
        expect(
          catalogFlightSettlement({ outcome, stale: true, newerFlightInProgress: true, status }),
        ).toBe("drop");
      }
    }
  });

  it("a stale failure with no newer read still reports the error", () => {
    expect(
      catalogFlightSettlement({
        outcome: "failure",
        stale: true,
        newerFlightInProgress: false,
        status: "loading",
      }),
    ).toBe("write");
  });

  it("a stale failure after the newer read already finished keeps its ready status", () => {
    expect(
      catalogFlightSettlement({
        outcome: "failure",
        stale: true,
        newerFlightInProgress: false,
        status: "ready",
      }),
    ).toBe("drop");
  });

  it("a stale success with no newer read releases a stranded loading status without its stale catalog", () => {
    expect(
      catalogFlightSettlement({
        outcome: "success",
        stale: true,
        newerFlightInProgress: false,
        status: "loading",
      }),
    ).toBe("settle-ready");
    expect(
      catalogFlightSettlement({
        outcome: "success",
        stale: true,
        newerFlightInProgress: false,
        status: "ready",
      }),
    ).toBe("drop");
  });
});
