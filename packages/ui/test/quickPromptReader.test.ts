import { describe, expect, it } from "vitest";
import type { QuickPromptProjectRef, QuickPromptSnapshot } from "@zcode/services";
import {
  createQuickPromptReader,
  quickPromptProjectKey,
  type QuickPromptReadResult,
} from "@/quick-prompts/reader.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const empty = { project: null, globals: [], projectPrompts: [] } as QuickPromptSnapshot;

describe("quick prompt reader", () => {
  it("drops a response that an newer load superseded (scenario 9: stale response ignored)", async () => {
    const pending: Array<ReturnType<typeof deferred<QuickPromptSnapshot>>> = [];
    const published: QuickPromptReadResult[] = [];
    const reader = createQuickPromptReader({
      read: () => {
        const next = deferred<QuickPromptSnapshot>();
        pending.push(next);
        return next.promise;
      },
      publish: (result) => published.push(result),
    });
    const first = reader.load(null);
    const second = reader.load(null);
    pending[1]?.resolve({ ...empty, globals: [] });
    await second;
    pending[0]?.resolve({ ...empty });
    await first;
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ projectKey: "" });
  });

  it("publishes errors from the latest request only", async () => {
    const published: QuickPromptReadResult[] = [];
    const reader = createQuickPromptReader({
      read: () => Promise.reject(new Error("offline")),
      publish: (result) => published.push(result),
    });
    await reader.load(null);
    expect(published).toHaveLength(1);
    expect(published[0]).toHaveProperty("error");
  });

  it("drops every in-flight response after invalidate (unmount or service change)", async () => {
    const gate = deferred<QuickPromptSnapshot>();
    const published: QuickPromptReadResult[] = [];
    const reader = createQuickPromptReader({
      read: () => gate.promise,
      publish: (result) => published.push(result),
    });
    const load = reader.load(null);
    reader.invalidate();
    gate.resolve(empty);
    await load;
    expect(published).toEqual([]);
  });

  it("keys results by the project pair so ids containing ':' cannot collide", () => {
    const left: QuickPromptProjectRef = { hostId: "a:b", projectId: "c" };
    const right: QuickPromptProjectRef = { hostId: "a", projectId: "b:c" };
    expect(quickPromptProjectKey(left)).not.toBe(quickPromptProjectKey(right));
    expect(quickPromptProjectKey(null)).toBe("");
  });
});
