import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  mergeTaskMetaCandidates,
  mergeTaskWithOptimisticMeta,
  withOptimisticTitleRecency,
} from "@/lib/zcodeTaskMetaMerge.js";

function meta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "glm",
    taskId: "task-merge",
    title: "Task",
    traceId: "trace-merge",
    updatedAt: 100,
    workspacePath: "/repo/merge",
    ...overrides,
  };
}

describe("mergeTaskWithOptimisticMeta without titleUpdatedAt", () => {
  it("keeps the longer title on an updatedAt tie when neither side carries recency", () => {
    const host = meta({ title: "Short" });
    const optimistic = meta({ title: "A longer optimistic title" });

    expect(mergeTaskWithOptimisticMeta(host, optimistic).title).toBe("A longer optimistic title");
    expect(mergeTaskWithOptimisticMeta(optimistic, host).title).toBe("A longer optimistic title");
  });

  it("does not add a titleUpdatedAt key when neither side has one", () => {
    const merged = mergeTaskWithOptimisticMeta(meta({ title: "a" }), meta({ title: "bb" }));

    expect(merged.titleUpdatedAt).toBeUndefined();
  });

  it("lets a newer updatedAt decide the candidate regardless of title length", () => {
    const hostNewer = meta({ title: "Long host title", updatedAt: 200 });
    const optimisticOlder = meta({ title: "x", updatedAt: 100 });

    expect(mergeTaskWithOptimisticMeta(hostNewer, optimisticOlder).title).toBe("Long host title");
  });
});

describe("mergeTaskWithOptimisticMeta with titleUpdatedAt", () => {
  it("prefers the title with the larger titleUpdatedAt on an updatedAt tie", () => {
    const earlier = meta({
      title: "Longer earlier rename",
      titleUpdatedAt: 200,
      titleOverridden: true,
    });
    const later = meta({ title: "短", titleUpdatedAt: 300, titleOverridden: true });

    const merged = mergeTaskWithOptimisticMeta(earlier, later);

    expect(merged).toMatchObject({ title: "短", titleUpdatedAt: 300, updatedAt: 100 });
  });

  it("takes the title and its recency from the same candidate when updatedAt differs", () => {
    const hostNewerActivity = meta({
      title: "Host title from older rename",
      titleUpdatedAt: 150,
      titleOverridden: true,
      updatedAt: 200,
    });
    const optimisticOlderActivity = meta({
      title: "Local rename",
      titleUpdatedAt: 300,
      titleOverridden: true,
      updatedAt: 100,
    });

    const merged = mergeTaskWithOptimisticMeta(hostNewerActivity, optimisticOlderActivity);

    expect(merged.updatedAt).toBe(200);
    expect(merged.title).toBe("Local rename");
    expect(merged.titleUpdatedAt).toBe(300);
  });

  it("treats a candidate without titleUpdatedAt as older than one with it", () => {
    const withRecency = meta({ title: "ok", titleUpdatedAt: 10 });
    const withoutRecency = meta({ title: "much longer title without recency" });

    expect(mergeTaskWithOptimisticMeta(withoutRecency, withRecency)).toMatchObject({
      title: "ok",
      titleUpdatedAt: 10,
    });
    expect(mergeTaskWithOptimisticMeta(withRecency, withoutRecency)).toMatchObject({
      title: "ok",
      titleUpdatedAt: 10,
    });
  });

  it("never lets a non-manual title with newer recency replace a manual title", () => {
    const manual = meta({ title: "Manual", titleOverridden: true, titleUpdatedAt: 100 });
    const generated = meta({ title: "Generated later", titleUpdatedAt: 999 });

    expect(mergeTaskWithOptimisticMeta(manual, generated).title).toBe("Manual");
    expect(mergeTaskWithOptimisticMeta(generated, manual).title).toBe("Manual");
  });

  it("never lets a placeholder title replace a real title through recency", () => {
    const real = meta({ title: "Real title", titleUpdatedAt: 100 });
    const placeholder = meta({ title: "New session", titleUpdatedAt: 999 });

    expect(mergeTaskWithOptimisticMeta(real, placeholder).title).toBe("Real title");
  });

  it("does not let titleUpdatedAt change the updatedAt-based status choice", () => {
    const runningOlderRecency = meta({ status: "running", updatedAt: 200, titleUpdatedAt: 1 });
    const completedNewerRecency = meta({
      status: "completed",
      updatedAt: 100,
      titleUpdatedAt: 999,
    });

    const merged = mergeTaskWithOptimisticMeta(runningOlderRecency, completedNewerRecency);

    expect(merged.status).toBe("running");
    expect(merged.updatedAt).toBe(200);
  });
});

describe("withOptimisticTitleRecency", () => {
  it("stamps only the overlay copy with the supplied renderer clock", () => {
    const base = meta({ title: "Renamed" });

    const stamped = withOptimisticTitleRecency(base, 4242);

    expect(stamped.titleUpdatedAt).toBe(4242);
    expect(base.titleUpdatedAt).toBeUndefined();
    expect(mergeTaskMetaCandidates(stamped, meta({ title: "Host" }))?.titleUpdatedAt).toBe(4242);
  });
});
