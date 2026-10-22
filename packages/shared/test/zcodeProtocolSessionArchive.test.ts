import { expect, it } from "vitest";
import { zcodeSessionInfoSchema } from "../src/zcode-protocol-legacy-types.js";
import { zcodeSessionListParamsSchema } from "../src/zcode-protocol/index.js";

// Upstream 3.16.1 removed the session archive wire fields; see specs/build-pipeline-entrypoints.md.
it("has no archive filter on session.list params", () => {
  expect(zcodeSessionListParamsSchema.parse({})).toEqual({});
  expect(zcodeSessionListParamsSchema.safeParse({ includeArchived: true }).success).toBe(false);
});

it("has no archived timestamp on session info", () => {
  const session = {
    sessionId: "session-1",
    workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
    sessionKind: "interactive",
    title: "Task",
    mode: "build",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
  };
  expect(zcodeSessionInfoSchema.parse(session)).not.toHaveProperty("archivedAt");
  expect(zcodeSessionInfoSchema.safeParse({ ...session, archivedAt: 3 }).success).toBe(false);
});
