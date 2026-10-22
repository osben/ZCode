import { describe, expect, it } from "vitest";
import {
  PendingReservationGate,
  reservedCreateSessionId,
  trackReservedCreate,
} from "../src/v4/pendingReservationGate.js";

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

describe("trackReservedCreate", () => {
  it("marks a reserved create synchronously, before the dispatch awaits anything", async () => {
    const gate = new PendingReservationGate();
    let release!: () => void;
    const dispatch = async (type: string, sessionId: string | null) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { type, sessionId };
    };
    const tracked = trackReservedCreate(gate, dispatch, (args) =>
      args[0] === "createSession" ? args[1] : null,
    );
    const pending = tracked("createSession", "s-early");
    // The mark is set on entry, so a lease effect that runs now sees the create in flight.
    expect(gate.isPending("s-early")).toBe(true);
    release();
    await expect(pending).resolves.toEqual({ type: "createSession", sessionId: "s-early" });
    expect(gate.isPending("s-early")).toBe(false);
  });

  it("settles on a rejected dispatch and never marks other command types", async () => {
    const gate = new PendingReservationGate();
    const dispatch = async (type: string, _sessionId: string | null): Promise<string> => {
      throw new Error(`refused ${type}`);
    };
    const tracked = trackReservedCreate(gate, dispatch, (args) =>
      args[0] === "createSession" ? args[1] : null,
    );
    await expect(tracked("createSession", "s-fail")).rejects.toThrow("refused createSession");
    expect(gate.isPending("s-fail")).toBe(false);

    const other = tracked("sendText", "s-other");
    expect(gate.isPending("s-other")).toBe(false);
    await expect(other).rejects.toThrow("refused sendText");
  });
});

describe("reservedCreateSessionId (real reservation shape)", () => {
  it("reads the reserved id from the payload when the dispatch target is null", async () => {
    // SessionPane dispatches a reservation as createSession with the id in the payload and a null target.
    const gate = new PendingReservationGate();
    let release!: () => void;
    const dispatch = async (...args: readonly unknown[]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return args[0];
    };
    const tracked = trackReservedCreate(gate, dispatch, reservedCreateSessionId);
    const pending = tracked(
      "createSession",
      {
        workspaceId: "w-1",
        sessionId: "s-reserved",
        submissionPreparation: { submissionId: "sub-1" },
      },
      null,
    );
    expect(gate.isPending("s-reserved")).toBe(true);
    release();
    await pending;
    expect(gate.isPending("s-reserved")).toBe(false);
  });

  it("returns null for other commands and for a createSession without a reserved id", () => {
    expect(reservedCreateSessionId(["sendText", { text: "hi" }, "s-1"])).toBeNull();
    expect(reservedCreateSessionId(["createSession", { workspaceId: "w-1" }, null])).toBeNull();
  });
});
