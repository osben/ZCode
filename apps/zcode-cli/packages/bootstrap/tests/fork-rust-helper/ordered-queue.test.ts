// Fork: the helper sends its app-tool replaces one at a time (specs/fork-rust-node-helper.md F3b(b)). Rust serves each
// request in its own task, so two replaces in flight could be applied out of order; the helper keeps one in flight per
// session, so the later set always lands last.
import { describe, expect, it } from "vitest";
import { createOrderedQueue } from "../../src/fork-rust-helper/ordered-queue.js";

describe("createOrderedQueue", () => {
  it("starts each task only after the previous one settled", async () => {
    const queue = createOrderedQueue();
    const started: string[] = [];
    let release!: () => void;
    const first = queue(() => {
      started.push("first");
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const second = queue(async () => {
      started.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(started).toEqual(["first", "second"]);
  });

  it("keeps running the queue after a task rejects, and reports that task's failure", async () => {
    const queue = createOrderedQueue();
    const failed = queue(async () => {
      throw new Error("replace failed");
    });
    const after = queue(async () => "next");
    await expect(failed).rejects.toThrow("replace failed");
    await expect(after).resolves.toBe("next");
  });
});
