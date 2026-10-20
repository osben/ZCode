import { expect, it } from "vitest";
import { zcodeSessionInfoSchema } from "../src/zcode-protocol-legacy-types.js";
import { zcodeSessionListParamsSchema } from "../src/zcode-protocol/index.js";

it("preserves the archive filter used by CLI session listing", () => {
  expect(zcodeSessionListParamsSchema.parse({})).toMatchObject({ includeArchived: false });
  expect(zcodeSessionListParamsSchema.parse({ includeArchived: true })).toMatchObject({
    includeArchived: true,
  });
  expect(zcodeSessionListParamsSchema.safeParse({ includeArchived: "true" }).success).toBe(false);
});

it("preserves the archived timestamp produced by the existing session mapper", () => {
  const session = {
    sessionId: "session-1",
    workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
    sessionKind: "interactive",
    title: "Archived task",
    mode: "build",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    archivedAt: 3,
  };
  expect(zcodeSessionInfoSchema.parse(session).archivedAt).toBe(3);
  expect(zcodeSessionInfoSchema.safeParse({ ...session, archivedAt: -1 }).success).toBe(false);
});
