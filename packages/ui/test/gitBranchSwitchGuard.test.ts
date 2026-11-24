import { describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/logger.js", () => ({ logger: { warn } }));

import { runAfterBranchSwitchGuard } from "../src/gitBranchSwitchGuard.js";

describe("runAfterBranchSwitchGuard", () => {
  it("runs the switch directly when there is no guard", async () => {
    const run = vi.fn(async () => undefined);
    await runAfterBranchSwitchGuard(undefined, "main", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs the switch only when the guard allows it", async () => {
    const run = vi.fn(async () => undefined);
    await runAfterBranchSwitchGuard(async () => false, "main", run);
    expect(run).not.toHaveBeenCalled();
    await runAfterBranchSwitchGuard(async () => true, "main", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not switch and does not reject when the guard rejects", async () => {
    warn.mockClear();
    const run = vi.fn(async () => undefined);
    await expect(
      runAfterBranchSwitchGuard(async () => Promise.reject(new Error("guard failed")), "main", run),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
