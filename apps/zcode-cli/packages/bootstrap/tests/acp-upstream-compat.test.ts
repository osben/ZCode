import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createForkAcpSessionBindingStore,
  createSqliteSessionStore,
} from "@zcode/adapters/storage";
import { AgentRuntime } from "@zcode/core";
import {
  createExternalAgentModel,
  createInMemorySessionEventStore,
  createSessionId,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnRequest,
  type ModelSelection,
} from "@zcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeSessionTaskType,
  decodeSessionTitleSource,
  decodeStoredMessage,
  decodeStoredPart,
  decodeStoredSessionModelSelection,
  parseModelSelectionValue,
} from "./fixtures/upstream-0a1fc56d/upstream-codecs.js";
import { shouldHideInvalidToolCallFromProduct } from "./fixtures/upstream-0a1fc56d/upstream-tool-visibility.js";

// specs/acp-agent-runtime.md "Upstream compatibility of persisted chat events".
// The fork writes an ACP chat turn into a real SQLite session database. The rows are then decoded by
// verbatim copies of upstream 3.16.1 logic (fixtures/upstream-0a1fc56d). Each assertion states the
// outcome an upstream build reaches for that row.

const SELECTION: ModelSelection = {
  providerId: "acp:fake",
  modelId: "fake",
  options: { reasoningLevel: "auto" },
};

/** Marker model with the shape the bootstrap factory builds for an `acp-agent` provider. */
function markerModel(driver: ExternalAgentTurnDriver) {
  return createExternalAgentModel({
    driver,
    providerId: "acp:fake",
    modelId: "fake",
    properties: {
      contextWindow: 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    } as never,
    optionSpecs: {
      reasoningLevel: { values: ["auto"] },
      maxOutputTokens: { max: 32_000 },
    } as never,
    options: { reasoningLevel: "auto" },
  });
}

/** One scripted ACP turn that exercises every fork-only persisted shape. */
function scriptedDriver(): ExternalAgentTurnDriver {
  return {
    agentId: "fake",
    runTurn: async (request: ExternalAgentTurnRequest) => {
      request.onEvent({ type: "session_title", title: "ACP Title" });
      request.onEvent({ type: "config_options", options: [] });
      request.onEvent({ type: "message_delta", text: "Reading " });
      request.onEvent({
        type: "tool_call",
        update: {
          toolCallId: "t1",
          title: "Read a.ts",
          kind: "read",
          status: "in_progress",
          input: { path: "a.ts" },
          output: null,
        },
      });
      request.onEvent({
        type: "tool_call_update",
        update: {
          toolCallId: "t1",
          title: null,
          kind: null,
          status: "completed",
          input: undefined,
          output: "file body",
        },
      });
      request.onEvent({
        type: "tool_call",
        update: {
          toolCallId: "t2",
          title: "Run tests",
          kind: "execute",
          status: "failed",
          input: { command: "pnpm test" },
          output: "exit 1",
        },
      });
      request.onEvent({
        type: "plan",
        entries: [{ content: "read the file", priority: "high", status: "completed" }],
      });
      request.onEvent({ type: "context_reset" });
      request.onEvent({ type: "message_delta", text: "done" });
      return {
        agentId: "fake",
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  } as ExternalAgentTurnDriver;
}

interface Row {
  readonly data: string;
}

describe("ACP chat rows written by the fork, read by upstream 0a1fc56d", () => {
  let root: string;
  let dbPath: string;
  let sessionId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-acp-upstream-compat-"));
    dbPath = join(root, "sessions.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const driver = scriptedDriver();
    const runtime = new AgentRuntime(
      createSessionId("acp-upstream-compat"),
      { mode: "build", modelSelection: SELECTION, workingDirectory: root },
      {
        eventStore: createInMemorySessionEventStore({ retention: "unbounded" }),
        modelFactory: () => markerModel(driver),
        sessionStore: store,
      },
    );
    sessionId = runtime.sessionId;
    try {
      await runtime.executeTurn("read a.ts and run the tests");
    } finally {
      runtime.beginShutdown();
      await store.close?.();
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function open(): DatabaseSync {
    return new DatabaseSync(dbPath, { readOnly: true });
  }

  function rows(table: "message" | "part", db: DatabaseSync): Row[] {
    return db
      .prepare(`select data from ${table} where session_id = ? order by sequence`)
      .all(sessionId) as unknown as Row[];
  }

  it("user and assistant message rows decode with the ACP selection kept (SAFE for decoding)", () => {
    const db = open();
    try {
      const messages = rows("message", db).map(
        (row) => JSON.parse(row.data) as Record<string, unknown>,
      );
      const user = messages.find((message) => message.role === "user");
      const assistant = messages.find((message) => message.role === "assistant");
      expect(user).toBeDefined();
      expect(assistant).toBeDefined();

      // Upstream decodeStoredMessage keeps a valid user selection: modelSelectionSchema accepts any
      // non-empty providerId, so `acp:fake` is not stripped.
      expect(parseModelSelectionValue(user!.modelSelection)).toEqual(SELECTION);
      const decodedUser = decodeStoredMessage(user);
      expect(decodedUser.modelSelection).toEqual(SELECTION);

      // The legacy `model` object the fork also writes for user rows is dropped on upstream read.
      expect(decodedUser).not.toHaveProperty("model");

      // Assistant rows keep providerId/modelId (lowercase Id). Upstream cold hydration reads those
      // fields (transcript-hydration.ts:1128-1134) to synthesise a ModelSelected for the ACP provider.
      const decodedAssistant = decodeStoredMessage(assistant);
      expect(decodedAssistant).toMatchObject({ providerId: "acp:fake", modelId: "fake" });
    } finally {
      db.close();
    }
  });

  it("tool parts keep the acp:<kind> name and metadata.externalAgent and are not hidden (SAFE)", () => {
    const db = open();
    try {
      const parts = rows("part", db).map((row) => JSON.parse(row.data) as Record<string, unknown>);
      const toolParts = parts.filter((part) => part.type === "tool");
      expect(toolParts.map((part) => part.tool).sort()).toEqual(
        expect.arrayContaining(["acp:read", "acp:execute", "TodoWrite"]),
      );
      for (const part of toolParts) {
        // Upstream passes the part through unchanged (decodeStoredPart has no tool branch).
        expect(decodeStoredPart(part)).toEqual(part);
        // The product visibility filter hides only empty names and the placeholder with metadata
        // (tool-call-product-visibility.ts:9-24). `acp:*` names are shown.
        expect(
          shouldHideInvalidToolCallFromProduct(part.tool, part.metadata as Record<string, unknown>),
        ).toBe(false);
      }
      const read = toolParts.find((part) => part.tool === "acp:read")!;
      expect(read.metadata).toEqual({ externalAgent: true });
    } finally {
      db.close();
    }
  });

  it("session row title and task type decode to upstream enum values (SAFE)", () => {
    const db = open();
    try {
      const session = db
        .prepare("select title, title_source, task_type from session where id = ?")
        .get(sessionId) as { title: string; title_source: string; task_type: string };
      expect(session.title).toBe("ACP Title");
      // The fork writes titleSource `generated`, which is in upstream SESSION_TITLE_SOURCES.
      expect(decodeSessionTitleSource(session.title_source)).toBe("generated");
      expect(decodeSessionTaskType(session.task_type)).toBe("interactive");
    } finally {
      db.close();
    }
  });

  it("the model-selection session entry decodes back to the ACP selection (SAFE)", () => {
    const db = open();
    try {
      const entries = db
        .prepare("select type, data from session_entry where session_id = ?")
        .all(sessionId) as Array<{ type: string; data: string }>;
      const selection = entries.find((entry) => entry.type === "runtime/model_selection");
      expect(selection).toBeDefined();
      expect(decodeStoredSessionModelSelection(JSON.parse(selection!.data))).toEqual(SELECTION);
    } finally {
      db.close();
    }
  });

  it("ACP session facts that are events only never reach a durable table (SAFE: upstream never sees them)", () => {
    const db = open();
    try {
      const tables = (
        db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      const durableText = tables
        .map((table) => JSON.stringify(db.prepare(`select * from "${table}"`).all()))
        .join("\n");
      // ExternalAgentConfigUpdated, ExternalAgentStatus and the SystemMessage reset are appended to the in-memory
      // event store only (events.ts persistDurableSessionEvent has no branch for them; external-agent-turn.ts
      // appends them through appendEvent). Their type names must not appear in any row.
      for (const eventOnly of [
        "external_agent_config_updated",
        "external_agent_status",
        "external_agent_context_reset",
      ]) {
        expect(durableText).not.toContain(eventOnly);
      }
    } finally {
      db.close();
    }
  });

  it("usage and tool-usage rows carry no source column and keep the acp:<kind> tool name (SAFE)", () => {
    const db = open();
    try {
      const turnColumns = (
        db.prepare("pragma table_info(turn_usage)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      const modelColumns = (
        db.prepare("pragma table_info(model_usage)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      // `ModelUsageSummary.source: "external-agent"` never reaches a durable column in either table.
      expect(turnColumns).not.toContain("source");
      expect(modelColumns).not.toContain("source");

      const toolNames = (
        db
          .prepare("select distinct tool_name from tool_usage where session_id = ?")
          .all(sessionId) as Array<{
          tool_name: string;
        }>
      ).map((row) => row.tool_name);
      // Upstream usage stats group tool_name as free text (usage.ts:461), so this name is listed as is.
      expect(toolNames).toEqual(expect.arrayContaining(["acp:read", "acp:execute"]));
    } finally {
      db.close();
    }
  });

  it("fork_acp_session_binding is a fork table without a foreign key, so an upstream session delete is not blocked (SAFE)", async () => {
    // The fork's binding store writes the row through its own connection. Upstream never opens this table.
    const binding = createForkAcpSessionBindingStore(dbPath);
    await binding.write(sessionId, {
      agentId: "fake",
      acpSessionId: "acp-session-1",
      cwd: root,
      launchKey: "digest-only",
    });
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("pragma foreign_key_list(fork_acp_session_binding)").all()).toEqual([]);
      // Upstream opens the session database with foreign keys on (migration-runner.ts pragma foreign_keys = on)
      // and deletes sessions through the session table only, so the fork table cannot block that delete.
      db.exec("pragma foreign_keys = on");
      expect(() => db.prepare("delete from session where id = ?").run(sessionId)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
