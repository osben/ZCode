// specs/incognito-session.md scenario 21 (storage half): the CLI resume resolution must surface
// the persisted profile next to the session id, so createZCodeApp can compose capabilities under
// it before core resume runs.
import { describe, expect, it } from "vitest";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
import { readPersistedIncognitoProfile, resolveLatestSession } from "../src/sessions.js";

const DIRECTORY = "/workspace/incognito-resume";
const PROFILE = { ...INCOGNITO_LOCKDOWN_PROFILE, memory: true };

describe("incognito profile on the CLI resume resolution", () => {
  it("readPersistedIncognitoProfile returns the row profile, undefined for a normal row or a missing session", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const incognitoId = createSessionId("resume-incognito");
    const normalId = createSessionId("resume-normal");
    try {
      await store.createSession({
        id: incognitoId,
        projectID: createProjectId("resume-incognito"),
        slug: "resume-incognito",
        directory: DIRECTORY,
        title: "incognito",
        version: "test",
        incognito: PROFILE,
      });
      await store.createSession({
        id: normalId,
        projectID: createProjectId("resume-normal"),
        slug: "resume-normal",
        directory: DIRECTORY,
        title: "normal",
        version: "test",
      });

      await expect(
        readPersistedIncognitoProfile({ sessionId: incognitoId, sessionStore: store }),
      ).resolves.toEqual(PROFILE);
      await expect(
        readPersistedIncognitoProfile({ sessionId: normalId, sessionStore: store }),
      ).resolves.toBeUndefined();
      await expect(
        readPersistedIncognitoProfile({
          sessionId: createSessionId("resume-missing"),
          sessionStore: store,
        }),
      ).resolves.toBeUndefined();
    } finally {
      store.close?.();
    }
  });

  it("resolveLatestSession exposes the latest session's profile for --continue", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      await store.createSession({
        id: createSessionId("continue-incognito"),
        projectID: createProjectId("continue-incognito"),
        slug: "continue-incognito",
        directory: DIRECTORY,
        title: "latest",
        version: "test",
        incognito: PROFILE,
      });

      const latest = await resolveLatestSession({ directory: DIRECTORY, sessionStore: store });
      expect(latest?.incognito).toEqual(PROFILE);
    } finally {
      store.close?.();
    }
  });
});
