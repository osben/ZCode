// specs/incognito-session.md scenario 22: session/create with importedHistory and incognito.
// The app.resume() that follows the import marks the runtime persisted, so first-send persistence
// never writes fork_incognito — the import write itself must carry the profile, for both sources.
import { describe, expect, it, vi } from "vitest";
import type { CreateSessionInput, SessionStorePort } from "@zcode/contracts";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createSessionRecordForV4, closeSession } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const PROFILE = { ...INCOGNITO_LOCKDOWN_PROFILE, memory: true };

function makeServer(sessionStore: SessionStorePort) {
  const resume = vi.fn(async () => undefined);
  const server = new ZCodeProtocolAgentServer({
    // Stub stores answer "no existing session" for the create-time id check; tests override the rest.
    sessionStore: { getSession: async () => undefined, ...sessionStore } as SessionStorePort,
    createZCodeApp: (options) => createFakeApp(options, { getModel: () => "", resume }),
  });
  const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
  return { context, resume };
}

function sharedContextPayload(sessionId: string) {
  return {
    sessionId,
    workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    incognito: PROFILE,
    importedHistory: {
      source: "sharedContext",
      title: "Shared context import",
      markdown: "imported markdown",
      provenance: {
        shareId: "share-incognito",
        projectionSha256: "a".repeat(64),
        artifactSetSha256: "b".repeat(64),
        markdownSha256: "c".repeat(64),
        formatterVersion: 1,
        installedArtifacts: [],
      },
    },
  };
}

function claudeCodePayload(sessionId: string) {
  return {
    sessionId,
    workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    incognito: PROFILE,
    importedHistory: {
      source: "claudeCode",
      title: "Imported chat",
      createdAt: 1_000,
      updatedAt: 2_000,
      messages: [
        { role: "user", content: "hello", timestamp: 1_000 },
        { role: "assistant", content: "hi", timestamp: 2_000 },
      ],
    },
  };
}

describe("incognito profile on imported sessions", () => {
  it("sharedContext import carries the profile in the commit bundle's session input", async () => {
    const commitSharedContextImportBundle = vi.fn<
      NonNullable<SessionStorePort["commitSharedContextImportBundle"]>
    >(async () => ({}) as never);
    const { context, resume } = makeServer({
      commitSharedContextImportBundle,
    } as unknown as SessionStorePort);
    const sessionId = "incognito-shared-context-import";

    await createSessionRecordForV4(context, sharedContextPayload(sessionId));

    const bundle = commitSharedContextImportBundle.mock.calls[0]![0];
    expect(bundle.session.incognito).toEqual(PROFILE);
    expect(resume).toHaveBeenCalledTimes(1);
    await closeSession(context, { sessionId });
  });

  it("claudeCode import carries the profile in the createSession input", async () => {
    const createSession = vi.fn<SessionStorePort["createSession"]>(async () => ({}) as never);
    const saveMessage = vi.fn<SessionStorePort["saveMessage"]>(async () => ({}) as never);
    const { context, resume } = makeServer({
      createSession,
      messages: async () => [],
      saveMessage,
      savePart: async () => ({}) as never,
    } as unknown as SessionStorePort);
    const sessionId = "incognito-claude-import";

    await createSessionRecordForV4(context, claudeCodePayload(sessionId));

    const input = createSession.mock.calls[0]![0] as CreateSessionInput;
    expect(input.id).toBe(sessionId);
    expect(input.incognito).toEqual(PROFILE);
    expect(resume).toHaveBeenCalledTimes(1);
    await closeSession(context, { sessionId });
  });

  it("imports without incognito keep the session input profile-free", async () => {
    const createSession = vi.fn<SessionStorePort["createSession"]>(async () => ({}) as never);
    const { context } = makeServer({
      createSession,
      messages: async () => [],
      saveMessage: async () => ({}) as never,
      savePart: async () => ({}) as never,
    } as unknown as SessionStorePort);
    const sessionId = "normal-claude-import";
    const { incognito: _incognito, ...withoutProfile } = claudeCodePayload(sessionId);

    await createSessionRecordForV4(context, withoutProfile);

    expect((createSession.mock.calls[0]![0] as CreateSessionInput).incognito).toBeUndefined();
    await closeSession(context, { sessionId });
  });
});
