import { describe, expect, it, vi } from "vitest";
import { runWithErrorReport } from "../src/external-sessions/panelErrors.js";

// specs/external-sessions.md "Continue in ZCode": every failure in the flow reaches one error path.

describe("external sessions panel error reporting", () => {
  it("a rejected continue (dialog path) is reported once and never escapes as an unhandled rejection", async () => {
    const report = vi.fn();
    const failure = new Error("saveProject failed");
    const createDraft = vi.fn();

    await expect(
      runWithErrorReport(async () => {
        await Promise.reject(failure);
        createDraft();
      }, report),
    ).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("a successful run reports nothing", async () => {
    const report = vi.fn();
    await runWithErrorReport(async () => undefined, report);
    expect(report).not.toHaveBeenCalled();
  });

  it("a failure inside a nested call is reported once, not again by the outer caller (row menu path)", async () => {
    const report = vi.fn();
    const inner = () =>
      runWithErrorReport(async () => Promise.reject(new Error("resolve")), report);

    await runWithErrorReport(async () => {
      await inner();
    }, report);

    expect(report).toHaveBeenCalledTimes(1);
  });
});
