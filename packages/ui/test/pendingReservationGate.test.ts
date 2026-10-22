import { describe, expect, it } from "vitest";
import { PendingReservationGate } from "../src/v4/pendingReservationGate.js";

describe("PendingReservationGate", () => {
  it("keeps a reserved session pending until its create is acknowledged", async () => {
    const gate = new PendingReservationGate();
    const settle = gate.begin("s-reserved");
    expect(gate.isPending("s-reserved")).toBe(true);

    let opened = false;
    const lease = gate.whenSettled("s-reserved").then(() => {
      opened = true;
    });
    await Promise.resolve();
    expect(opened).toBe(false);

    settle();
    await lease;
    expect(opened).toBe(true);
    expect(gate.isPending("s-reserved")).toBe(false);
  });

  it("does not delay a session without a create in flight", async () => {
    const gate = new PendingReservationGate();
    await expect(gate.whenSettled("s-plain")).resolves.toBeUndefined();
    const settle = gate.begin("s-other");
    await expect(gate.whenSettled("s-plain")).resolves.toBeUndefined();
    settle();
  });

  it("waits for every create of the same id and ignores a repeated settle", async () => {
    const gate = new PendingReservationGate();
    const first = gate.begin("s-1");
    const second = gate.begin("s-1");
    let opened = false;
    const lease = gate.whenSettled("s-1").then(() => {
      opened = true;
    });
    first();
    first();
    await Promise.resolve();
    expect(opened).toBe(false);
    expect(gate.isPending("s-1")).toBe(true);
    second();
    await lease;
    expect(opened).toBe(true);
  });
});
