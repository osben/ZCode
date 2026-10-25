import { describe, expect, it } from "vitest";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
import { createTestAgentRuntime } from "./helpers/test-agent-runtime.js";

// specs/incognito-session.md scenario 16: a prepared-worktree row is inserted before the session
// has a profile; first-send persistence of the incognito runtime must still land it.
describe("incognito profile on a prepared row", () => {
  it("lands on the first send of the incognito runtime", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("incognito-prepared-row");
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("incognito-prepared-row"),
        slug: "incognito-prepared-row",
        directory: "/workspace/project",
        title: "prepared",
        version: "test",
      });
      expect((await store.getSession(sessionId))?.incognito).toBeUndefined();

      const runtime = createTestAgentRuntime(
        sessionId,
        {
          workingDirectory: "/workspace/project",
          titleGeneration: { enabled: false },
          incognito: INCOGNITO_LOCKDOWN_PROFILE,
        },
        { eventStore: createInMemorySessionEventStore(), sessionStore: store },
      );
      await runtime.ensureSessionPersistedForExternalActivity("first input", {
        traceContext: { traceId: "trace-1" as never },
      });

      expect((await store.getSession(sessionId))?.incognito).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
    } finally {
      store.close?.();
    }
  });
});
