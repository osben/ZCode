import { describe, expect, it } from "vitest";
import { zcodeTaskMetaSchema } from "../src/validation.js";
import {
  sessionSummarySchema,
  sessionsIndexReconcileResultSchema,
} from "../src/zcode-protocol-v4/sessions-index.js";

const validMeta = {
  taskId: "task-title-recency",
  traceId: "trace-title-recency",
  title: "Renamed",
  workspacePath: "/tmp/workspace",
  createdAt: 1,
  updatedAt: 2,
  mode: "default",
};

describe("titleUpdatedAt schema", () => {
  it("accepts an optional non-negative integer on task meta and keeps it", () => {
    const parsed = zcodeTaskMetaSchema.parse({ ...validMeta, titleUpdatedAt: 1700000000000 });

    expect(parsed.titleUpdatedAt).toBe(1700000000000);
    expect(zcodeTaskMetaSchema.parse(validMeta).titleUpdatedAt).toBeUndefined();
  });

  it("rejects a non-number, a fraction, or a negative titleUpdatedAt on task meta", () => {
    expect(zcodeTaskMetaSchema.safeParse({ ...validMeta, titleUpdatedAt: "1" }).success).toBe(
      false,
    );
    expect(zcodeTaskMetaSchema.safeParse({ ...validMeta, titleUpdatedAt: 1.5 }).success).toBe(
      false,
    );
    expect(zcodeTaskMetaSchema.safeParse({ ...validMeta, titleUpdatedAt: -1 }).success).toBe(false);
  });

  it("accepts and rejects titleUpdatedAt on the sessions-index summary", () => {
    expect(sessionSummarySchema.shape.titleUpdatedAt.safeParse(42).success).toBe(true);
    expect(sessionSummarySchema.shape.titleUpdatedAt.safeParse(undefined).success).toBe(true);
    expect(sessionSummarySchema.shape.titleUpdatedAt.safeParse("42").success).toBe(false);
  });

  it("carries titleUpdatedAt through the reconcile result and rejects a non-number", () => {
    const base = {
      sessionId: "session-1",
      exists: true,
      deleted: false,
      title: "Renamed",
      titleSource: "custom",
      createdAt: 1,
      updatedAt: 2,
    };

    const accepted = sessionsIndexReconcileResultSchema.parse({
      sessions: [{ ...base, titleUpdatedAt: 99 }],
    });
    expect(accepted.sessions[0]).toMatchObject({ titleUpdatedAt: 99 });

    expect(
      sessionsIndexReconcileResultSchema.safeParse({
        sessions: [{ ...base, titleUpdatedAt: "99" }],
      }).success,
    ).toBe(false);
  });
});
