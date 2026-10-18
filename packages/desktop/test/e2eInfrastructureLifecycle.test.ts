import { describe, expect, it, vi } from "vitest";

import { createE2ERunnerFinalizationGuard } from "./e2e/helpers/e2e-runner-finalization-guard.js";
import { runMeasuredE2ELifecyclePhase } from "./e2e/helpers/e2e-lifecycle-measurement.js";

describe("desktop E2E infrastructure lifecycle", () => {
  it("records a failed lifecycle phase before rethrowing the original error", async () => {
    const record = vi.fn();
    const failure = new Error("beforeSession setup failed");

    await expect(
      runMeasuredE2ELifecyclePhase(
        "before-session",
        { cid: "0-52", specs: ["./test/e2e/example.test.ts"] },
        record,
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        cid: "0-52",
        error: "beforeSession setup failed",
        phase: "before-session",
        status: "failed",
      }),
    );
  });

  it("records falsy thrown values as failures", async () => {
    const record = vi.fn();

    await expect(
      runMeasuredE2ELifecyclePhase("prepare", { specs: [] }, record, async () => {
        throw "";
      }),
    ).rejects.toBe("");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ error: "", status: "failed" }));
  });

  it("keeps a referenced finalization timer until it is disarmed", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const guard = createE2ERunnerFinalizationGuard({ onTimeout, timeoutMs: 5_000 });

      guard.arm();
      expect(guard.isArmed()).toBe(true);
      guard.disarm();
      vi.advanceTimersByTime(5_000);

      expect(onTimeout).not.toHaveBeenCalled();
      expect(guard.isArmed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
