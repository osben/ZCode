import { describe, expect, it, vi } from "vitest";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import {
  dispatchQueueCommandWithStaleRetry,
  isQueueCommandSettledAck,
  shouldReportSteerFailure,
} from "@/v4/staleAuthorityRecovery.js";

function ack(partial: Partial<CommandAck>): CommandAck {
  return { commandId: "cmd", revisionAtDecision: 0, status: "accepted", ...partial };
}

describe("ISSUE-072 queue command stale revision retry", () => {
  it("re-sends once at revisionAtDecision after proto.staleRevision", async () => {
    const dispatch = vi
      .fn<(baseRevision: number) => Promise<CommandAck>>()
      .mockResolvedValueOnce(
        ack({ status: "stale", reasonCode: "proto.staleRevision", revisionAtDecision: 6 }),
      )
      .mockResolvedValueOnce(ack({ revisionAtDecision: 6 }));

    const result = await dispatchQueueCommandWithStaleRetry(dispatch, 5);

    expect(dispatch.mock.calls).toEqual([[5], [6]]);
    expect(result.status).toBe("accepted");
  });

  it("retries at most once and returns the second stale ACK", async () => {
    const stale = ack({
      status: "stale",
      reasonCode: "proto.staleRevision",
      revisionAtDecision: 7,
    });
    const dispatch = vi
      .fn<(baseRevision: number) => Promise<CommandAck>>()
      .mockResolvedValue(stale);

    const result = await dispatchQueueCommandWithStaleRetry(dispatch, 5);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("stale");
  });

  it.each(["proto.staleLogEpoch", "proto.staleTarget"])("does not retry %s", async (reasonCode) => {
    const dispatch = vi
      .fn<(baseRevision: number) => Promise<CommandAck>>()
      .mockResolvedValue(ack({ status: "stale", reasonCode, revisionAtDecision: 6 }));

    await dispatchQueueCommandWithStaleRetry(dispatch, 5);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not retry rejected or noop ACKs", async () => {
    for (const status of ["rejected", "noop", "failed"] as const) {
      const dispatch = vi
        .fn<(baseRevision: number) => Promise<CommandAck>>()
        .mockResolvedValue(ack({ status, revisionAtDecision: 6 }));
      await dispatchQueueCommandWithStaleRetry(dispatch, 5);
      expect(dispatch).toHaveBeenCalledTimes(1);
    }
  });

  it("treats accepted, duplicate and noop as settled", () => {
    expect(isQueueCommandSettledAck("accepted")).toBe(true);
    expect(isQueueCommandSettledAck("duplicate")).toBe(true);
    expect(isQueueCommandSettledAck("noop")).toBe(true);
    expect(isQueueCommandSettledAck("stale")).toBe(false);
    expect(isQueueCommandSettledAck("rejected")).toBe(false);
  });

  it("does not report a Steer that lost the race to the drain or the turn end", () => {
    for (const reasonCode of ["guard.queueItemReserved", "sendQueuedNowRequiresRunning"]) {
      expect(shouldReportSteerFailure(ack({ status: "failed", reasonCode }), true)).toBe(false);
    }
    expect(shouldReportSteerFailure(ack({ status: "failed" }), false)).toBe(false);
    expect(shouldReportSteerFailure(ack({ status: "noop" }), true)).toBe(false);
  });

  it("reports a Steer that left the item queued", () => {
    expect(
      shouldReportSteerFailure(ack({ status: "stale", reasonCode: "proto.staleRevision" }), true),
    ).toBe(true);
    expect(
      shouldReportSteerFailure(
        ack({ status: "failed", reasonCode: "guard.queuePromotionBusy" }),
        true,
      ),
    ).toBe(true);
  });
});
