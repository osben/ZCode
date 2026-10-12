// First-subscription hydration of a detached live child (dwf workflow actor / subagent child).
//
// Bug root cause (the reason this file exists): these child sessions have no bootstrap record of their own —
// events reach the sink routing of the parent record via ingestDetachedLiveSession. The old loadPersistedEvents
// used context.sessions.get(childSessionId) as a direct lookup and returned synthesized:false when it missed,
// so performHydration took the early-exit branch that "keeps the healthy live publisher" and the durable
// transcript three-source merge never ran: only this session's live events entered the projection, and any
// persisted body **not appearing as a live event** was lost entirely.
// amend-resume is exactly that shape — it copies the predecessor actor's transcript prefix straight into the
// session store
// to seed the new actor session (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md), leaving the
// sidebar with only this round's increment.
//
// Coverage:
//   1. Child with no record + a persisted parentID pointing at a live parent record → seeded prefix and live
//      increment both visible in the projection
//   2. Child with neither a record nor any record reachable via parentID → keeps the pre-fix behavior (empty,
//      non-synthesized)
//   3. A session with its own record still goes through the direct lookup, not overridden by the parentID
//      fallback
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import type {
  EventId,
  MessageId,
  MessagePart,
  ModelId,
  ModelProviderId,
  ProjectId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionEventStorePort,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

type TestSessionStore = ReturnType<typeof createSqliteSessionStore>;

const WORKSPACE_PATH = "/tmp/zcode-detached-child";
const PARENT_SESSION_ID = "sess_parent_chat" as SessionId;
const CHILD_SESSION_ID = "sess_actor_child" as SessionId;

class EventLog {
  private seq = 0;

  constructor(private readonly sessionId: string) {}

  push(type: SessionEventTypeUnion, payload: unknown, opts: { turnId?: string } = {}): SessionEvent {
    this.seq += 1;
    return {
      id: `${this.sessionId}-event-${this.seq}` as EventId,
      sessionId: this.sessionId as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-detached" as TraceId,
      sequenceNumber: this.seq,
      payload,
    } as SessionEvent;
  }
}

async function saveUserTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  text: string,
  created: number,
): Promise<void> {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created },
    agent: "zcode-agent",
    model: { providerID: "glm" as ModelProviderId, modelID: "glm-4-air" as ModelId },
    tools: {},
  });
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
}

async function saveAssistantTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  parentMessageId: MessageId,
  text: string,
  created: number,
): Promise<void> {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created, completed: created },
    parentID: parentMessageId,
    providerID: "glm" as ModelProviderId,
    modelID: "glm-4-air" as ModelId,
    mode: "build",
    agent: "zcode-agent",
    path: { cwd: WORKSPACE_PATH, root: WORKSPACE_PATH },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
}

/** The seeding shape of amend-resume: the predecessor's transcript prefix is copied straight into the new actor session's store. */
async function seedActorTranscriptPrefix(
  store: TestSessionStore,
  sessionId: SessionId,
  label: string,
): Promise<void> {
  await saveUserTextMessage(
    store,
    sessionId,
    `${sessionId}-seed-0` as MessageId,
    `${label} 播种提问`,
    1,
  );
  await saveAssistantTextMessage(
    store,
    sessionId,
    `${sessionId}-seed-1` as MessageId,
    `${sessionId}-seed-0` as MessageId,
    `${label} 播种回答`,
    2,
  );
}

/**
 * Only the fields loadPersistedEvents actually touches: the shared event store, the artifact reader,
 * the runtime model selection used for contextWindow resolution (getSessionModelSelection), and the workspace.
 * The rest can stay empty — when missing, the gateway's seed hook simply returns null for a child (a child has
 * no record anyway).
 */
function makeBackingRecord(eventStore: SessionEventStorePort): ZCodeProtocolSessionRecord {
  return {
    app: {
      readToolResultArtifact: async () => ({ content: "" }),
      runtime: {
        getSessionModelSelection: () => ({ providerId: "glm", modelId: "glm-4-air" }),
        // listSessionSubagents only reads the record when the session **itself** has one (the live supplement
        // of the subagent projection);
        // there are no subagents here, so an empty projection suffices.
        // readSessionContextUsage (since staging 6d4c3cc571, loadPersistedEvents reads the capacity seed
        // synchronously) needs projection.contextWindow / contextUsed; a minimal projection suffices — the
        // subagent projection is empty anyway.
        getProjection: async () => ({ contextUsed: 0, contextWindow: 200_000 }) as never,
      },
      sessionId: PARENT_SESSION_ID,
    },
    createdAt: 0,
    eventStore,
    persistence: "immediate",
    stateRevision: 1,
    updatedAt: 0,
    workspace: {
      workspaceKey: `local:${WORKSPACE_PATH}`,
      workspacePath: WORKSPACE_PATH,
    },
  } as unknown as ZCodeProtocolSessionRecord;
}

function makeContext(input: {
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  store: TestSessionStore;
}): ZCodeProtocolAgentServerContext {
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    },
    deps: { sessionStore: input.store },
    notify: () => {},
    requestClient: async () => {
      throw new Error("detached-child hydration test does not issue reverse requests");
    },
    sessions: input.sessions,
    v4Interactions: { resolve: () => false },
    workspaceModelCatalogs: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
  return context;
}

/** The child's live in-flight turn: TurnStarted with no terminal event → the cold merge treats it as the in-memory authoritative turn. */
async function ingestLiveTurn(
  gateway: ReturnType<typeof createConversationV4Gateway>,
  eventStore: SessionEventStorePort,
  sessionId: string,
  liveText: string,
): Promise<void> {
  const log = new EventLog(sessionId);
  const events = [
    log.push(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200_000 }),
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: `${liveText} 提问` },
      { turnId: `${sessionId}-turn-live` },
    ),
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: `${liveText} 增量`, done: false },
      { turnId: `${sessionId}-turn-live` },
    ),
  ];
  for (const event of events) {
    // Production shape: the child runtime shares the event store with the parent runtime (archived under the
    // child sessionId),
    // and the same event is additionally routed to the gateway's detached live channel via the parent record's
    // external sink.
    await eventStore.append(event);
    gateway.ingestDetachedLiveSession(sessionId, event);
  }
}

async function snapshotRowTexts(
  gateway: ReturnType<typeof createConversationV4Gateway>,
  sessionId: string,
): Promise<string[]> {
  const result = await gateway.subscribe({
    topic: conversationTopic(sessionId),
    connectionId: `conn-${sessionId}`,
    clientMode: "desktop-continuous",
  });
  const payload = result.initialFrame?.payload;
  if (payload?.kind !== "snapshot") throw new Error("Expected snapshot initial frame");
  return payload.snapshot.rows.window.flatMap((row) =>
    "text" in row && typeof row.text === "string" && row.text.length > 0 ? [row.text] : [],
  );
}

describe("v4 detached live child 的首次订阅 hydration", () => {
  let tempRoot: string;
  let store: TestSessionStore;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-detached-child-"));
    store = createSqliteSessionStore({ dbPath: join(tempRoot, "sessions.db") });
  });

  afterEach(async () => {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  });

  async function createSessionRow(sessionId: SessionId, parentId?: SessionId): Promise<void> {
    await store.createSession({
      id: sessionId,
      ...(parentId ? { parentID: parentId } : {}),
      projectID: "project_detached_child" as ProjectId,
      slug: `slug-${sessionId}`,
      directory: WORKSPACE_PATH,
      path: WORKSPACE_PATH,
      title: `session ${sessionId}`,
      version: "test-version",
      time: { created: 1, updated: 4 },
    });
  }

  it("child 无 record：经持久 parentID 落到父 record，播种前缀与 live 增量同时可见", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    await createSessionRow(CHILD_SESSION_ID, PARENT_SESSION_ID);
    await seedActorTranscriptPrefix(store, CHILD_SESSION_ID, "actor");

    const eventStore = createInMemorySessionEventStore();
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([
      [PARENT_SESSION_ID, makeBackingRecord(eventStore)],
    ]);
    const context = makeContext({ sessions, store });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    await ingestLiveTurn(gateway, eventStore, CHILD_SESSION_ID, "live");
    const texts = await snapshotRowTexts(gateway, CHILD_SESSION_ID);

    // Before the fix there were only the two live rows here: the seeded prefix never entered the projection.
    expect(texts).toContain("actor 播种提问");
    expect(texts).toContain("actor 播种回答");
    expect(texts).toContain("live 提问");
    expect(texts).toContain("live 增量");
    // The order must also be "seeded prefix first, live turn after".
    expect(texts.indexOf("actor 播种回答")).toBeLessThan(texts.indexOf("live 增量"));
  });

  it("child 既无 record、parentID 也落不到任何 record：维持修复前的空非合成 hydration", async () => {
    const orphanParentId = "sess_parent_not_resident" as SessionId;
    await createSessionRow(orphanParentId);
    await createSessionRow(CHILD_SESSION_ID, orphanParentId);
    await seedActorTranscriptPrefix(store, CHILD_SESSION_ID, "orphan");

    const eventStore = createInMemorySessionEventStore();
    // The registry contains only a session unrelated to this child: the parentID finds no resident record.
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([
      [PARENT_SESSION_ID, makeBackingRecord(eventStore)],
    ]);
    const context = makeContext({ sessions, store });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    await ingestLiveTurn(gateway, eventStore, CHILD_SESSION_ID, "live");
    const texts = await snapshotRowTexts(gateway, CHILD_SESSION_ID);

    expect(texts).toEqual(["live 提问", "live 增量"]);
  });

  it("自身有 record 的会话仍直取自己的 record，不被 parentID 回退改写", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    // The session has both its own record and a persisted parentID; the direct lookup must win.
    await createSessionRow(CHILD_SESSION_ID, PARENT_SESSION_ID);
    await seedActorTranscriptPrefix(store, CHILD_SESSION_ID, "self");

    const ownEventStore = createInMemorySessionEventStore();
    const parentEventStore = createInMemorySessionEventStore();
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([
      [PARENT_SESSION_ID, makeBackingRecord(parentEventStore)],
      [CHILD_SESSION_ID, makeBackingRecord(ownEventStore)],
    ]);
    const context = makeContext({ sessions, store });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    // Discriminator: put a fabricated event in the parent record's store that is **only readable via the
    // parentID fallback**.
    // When the direct lookup is in effect, it must not appear in the projection.
    await ingestLiveTurn(gateway, ownEventStore, CHILD_SESSION_ID, "live");
    const decoy = new EventLog(`${CHILD_SESSION_ID}-decoy`);
    await parentEventStore.append({
      ...decoy.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "父 record 污染", done: false },
        { turnId: `${CHILD_SESSION_ID}-turn-live` },
      ),
      sessionId: CHILD_SESSION_ID,
    });

    const texts = await snapshotRowTexts(gateway, CHILD_SESSION_ID);
    expect(texts).toContain("self 播种提问");
    expect(texts).toContain("live 增量");
    expect(texts.join("")).not.toContain("父 record 污染");
  });
});
