import { describe, expect, it } from "vitest";
import {
  assertWorktreePreparationMutation,
  serializePreparedWorktreeMutation,
} from "../src/zcode-protocol/worktree-preparation-guard.js";

describe("durable preparation generation", () => {
  it("checks the expected attempt after the previous durable write completes", async () => {
    const owner = {};
    const current = { attemptId: "old", status: "preparing" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retry = serializePreparedWorktreeMutation(owner, "session", async () => {
      await gate;
      current.attemptId = "new";
    });
    const late = serializePreparedWorktreeMutation(owner, "session", async () =>
      assertWorktreePreparationMutation(current, { expectedAttemptId: "old", status: "failed" }),
    );
    const rejection = expect(late).rejects.toThrow("Stale");
    release();
    await retry;
    await rejection;
  });
  it("rejects late mutation after retry, cancellation and activation", () => {
    expect(() =>
      assertWorktreePreparationMutation(
        { attemptId: "new", status: "preparing" },
        { expectedAttemptId: "old", status: "failed" },
      ),
    ).toThrow("Stale");
    expect(() =>
      assertWorktreePreparationMutation(
        { attemptId: "a", status: "cancelled" },
        { expectedAttemptId: "a", status: "preparing" },
      ),
    ).toThrow("Cancelled");
    expect(() =>
      assertWorktreePreparationMutation(
        { attemptId: "a", status: "active" },
        { expectedAttemptId: "a", status: "failed" },
      ),
    ).toThrow("Stale");
  });
  it("allows an explicit retry with a new generation and reads legacy preparations", () => {
    expect(() =>
      assertWorktreePreparationMutation(
        { attemptId: "a", status: "cancelled" },
        { expectedAttemptId: "a", status: "preparing", worktreePreparation: { attemptId: "b" } },
      ),
    ).not.toThrow();
    expect(() =>
      assertWorktreePreparationMutation(
        { status: "failed" },
        { status: "preparing", worktreePreparation: { attemptId: "first" } },
      ),
    ).not.toThrow();
  });
  it("runs nested sections of the same owner/session inline while an outside waiter stays queued", async () => {
    const owner = {};
    const order: string[] = [];
    let releaseInner!: () => void;
    const innerGate = new Promise<void>((resolve) => {
      releaseInner = resolve;
    });
    const outer = serializePreparedWorktreeMutation(owner, "session", async () => {
      order.push("outer-begin");
      // A nested section (createSessionRecord / completion inside a whole-activation wrap) must
      // run inline instead of chaining onto the tail it currently holds.
      await serializePreparedWorktreeMutation(owner, "session", async () => {
        order.push("inner");
        await innerGate;
      });
      order.push("outer-end");
    });
    // An outside caller for the same session queues behind the whole wrapped activation.
    const outside = serializePreparedWorktreeMutation(owner, "session", async () => {
      order.push("outside");
    });
    // A different session never blocks on this lock.
    const otherSession = serializePreparedWorktreeMutation(owner, "other", async () => {
      order.push("other-session");
    });
    await otherSession;
    expect(order).toEqual(["outer-begin", "inner", "other-session"]);
    releaseInner();
    await outer;
    await outside;
    expect(order).toEqual(["outer-begin", "inner", "other-session", "outer-end", "outside"]);
  });
});
