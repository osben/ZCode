import { describe, expect, it } from "vitest";
import {
  zcodeTaskEraseResultSchema,
  zcodeSessionEraseTreeResultSchema,
} from "../src/zcode-protocol/index.js";

const result = {
  erasedTaskIds: ["task"],
  skippedTaskIds: [],
  blockedRunningTaskIds: [],
  failedTaskIds: [],
  fileFailureCount: 0,
  filesRetainedCount: 0,
  worktreeCleanup: {
    removed: ["/repo/worktree"],
    retained: [],
    failed: [],
    removedCount: 1,
    retainedCount: 0,
    failedCount: 0,
  },
};

describe("Host-owned permanent deletion result", () => {
  it("validates content and worktree outcomes separately", () => {
    expect(zcodeTaskEraseResultSchema.parse(result)).toEqual(result);
  });
  it("rejects unknown fields, negative counts and inconsistent worktree counts", () => {
    expect(zcodeTaskEraseResultSchema.safeParse({ ...result, extra: true }).success).toBe(false);
    expect(zcodeTaskEraseResultSchema.safeParse({ ...result, fileFailureCount: -1 }).success).toBe(
      false,
    );
    expect(
      zcodeTaskEraseResultSchema.safeParse({
        ...result,
        worktreeCleanup: { ...result.worktreeCleanup, removedCount: 0 },
      }).success,
    ).toBe(false);
  });
  it("does not assign Host Git outcomes to the CLI-owned erase response", () => {
    const cli = {
      erasedSessionIds: ["session"],
      blockedRunningSessionIds: [],
      fileFailureCount: 0,
      filesRetainedCount: 0,
    };
    expect(zcodeSessionEraseTreeResultSchema.safeParse(cli).success).toBe(true);
    expect(
      zcodeSessionEraseTreeResultSchema.safeParse({
        ...cli,
        worktreeCleanup: result.worktreeCleanup,
      }).success,
    ).toBe(false);
  });
});
