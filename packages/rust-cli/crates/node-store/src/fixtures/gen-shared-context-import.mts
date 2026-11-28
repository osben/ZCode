// Golden generator for node-store shared_context_tests.rs. Runs Node's own SqliteSessionStore.commitSharedContextImportBundle
// with the bundle persistImportedSessionHistory builds for a `sharedContext` import
// (apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts), then prints the stored rows.
//
// Rerun from the repository root (after `pnpm install` and a build of apps/zcode-cli/packages/contracts):
//   node_modules/.bin/tsx packages/rust-cli/crates/node-store/src/fixtures/gen-shared-context-import.mts \
//     > packages/rust-cli/crates/node-store/src/fixtures/shared_context_golden.json
// Columns that hold the wall clock of the run (session.time_updated) are left out.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../../../../..", import.meta.url)));
const { SqliteSessionStore } = await import(
  pathToFileURL(join(REPO, "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts")).href
);

const sessionId = "sess_ctx1";
const directory = "/w";
const model = { providerId: "p", modelId: "m" };
const mode = "build";
const sha = (c: string) => c.repeat(64);
// The raw inputs go through Node's own schema (`zcodeSessionImportHistorySchema`): it trims the strings and writes the
// keys in schema order, which is the shape the store gets.
const { zcodeSessionImportHistorySchema } = await import(
  pathToFileURL(join(REPO, "packages/shared/src/zcode-protocol/index.ts")).href
);
const rawFull = {
  source: "sharedContext",
  title: "Shared chat",
  createdAt: 1000,
  markdown: "# Shared\n\nsome context",
  provenance: {
    shareId: "share1",
    contextId: "ctx-1",
    shareUrl: "https://example.com/cn/share/abc",
    status: "pending",
    projectionSha256: sha("a"),
    artifactSetSha256: sha("b"),
    formatterVersion: 1,
    markdownSha256: sha("c"),
    installedArtifacts: [{ artifactId: "art1", workspaceRelativePath: "docs/a.md" }],
  },
};
// No contextId, status, shareUrl or createdAt; padded strings; the provenance keys in another order.
const rawMinimal = {
  source: "sharedContext",
  title: "  Padded title  ",
  markdown: " body \n",
  provenance: {
    installedArtifacts: [{ artifactId: " art2 ", workspaceRelativePath: " docs/b.md " }],
    markdownSha256: sha("f"),
    formatterVersion: 1,
    artifactSetSha256: sha("e"),
    projectionSha256: sha("d"),
    shareId: "  share2  ",
  },
};
const history = zcodeSessionImportHistorySchema.parse(rawFull);

const dir = mkdtempSync(join(tmpdir(), "ctx-golden-"));
const dbPath = join(dir, "db.sqlite");
const store = await SqliteSessionStore.open({ dbPath });
const importedAt = history.createdAt;
const messageId = `msg_${sessionId}_shared_context`;
await store.commitSharedContextImportBundle({
  session: {
    id: sessionId,
    projectID: "proj_w",
    traceID: "trace1",
    slug: sessionId,
    directory,
    path: directory,
    title: history.title,
    titleSource: "custom",
    version: "0.1.0",
    permission: { mode },
    time: { created: importedAt, updated: importedAt },
  },
  contextMessage: {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: { created: importedAt },
      agent: "zcode-agent",
      modelSelection: model,
      synthetic: true,
      source: "shared_context",
      visibility: "model-only",
      semantics: {
        origin: "import",
        kind: "shared_context",
        source: "conversation_share",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      metadata: {
        shareId: history.provenance.shareId,
        contextId: history.provenance.contextId,
        sharedContextStatus: history.provenance.status,
      },
    },
    parts: [
      {
        id: `part_${sessionId}_shared_context_text`,
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text: history.markdown,
        time: { start: importedAt, end: importedAt },
        metadata: { sharedContext: true },
      },
    ],
  },
  provenance: {
    id: `v4_shared_context_import:${sessionId}:${history.provenance.shareId}`,
    sessionID: sessionId,
    type: "v4/shared_context_import",
    time: { created: importedAt, updated: importedAt },
    data: { ...history.provenance, contextId: history.provenance.contextId, status: history.provenance.status },
  },
});

// The rows as the import left them, before any transition.
const fresh = new DatabaseSync(dbPath);
const freshRows = {
  session: fresh.prepare("select title, title_source, slug, time_created, time_title_updated, permission from session where id = ?").get(sessionId),
  messages: fresh.prepare("select id, time_created, time_updated, data from message order by time_created, id").all(),
  parts: fresh.prepare("select id, message_id, time_created, data from part order by time_created, id").all(),
  entries: fresh.prepare("select id, session_id, type, time_created, time_updated, data from session_entry order by id").all(),
};
fresh.close();

// Transitions (Node `transitionSharedContextImport`, `promoteSessionInput`): the entry's and the context message's
// `data` after each step. `time_updated` of the entry is the wall clock, so it is left out.
const ENTRY_ID = `v4_shared_context_import:${sessionId}:${history.provenance.shareId}`;
const snapshot = async (db: DatabaseSync) => ({
  entry: db.prepare("select data from session_entry where id = ?").get(ENTRY_ID).data,
  message: db.prepare("select data from message where id = ?").get(messageId).data,
});
const peek = new DatabaseSync(dbPath);
const steps: Record<string, unknown> = {};
const transition = async (name: string, input: Record<string, unknown>) => {
  const ok = await store.transitionSharedContextImport({ sessionID: sessionId, contextId: "ctx-1", ...input });
  steps[name] = { ok, ...(await snapshot(peek)) };
};
await transition("reserve", { expectedStatus: "pending", status: "reserved", sourceId: "queue_q1" });
await transition("reserve_again", { expectedStatus: "pending", status: "reserved", sourceId: "queue_q2" });
await transition("revert", { expectedStatus: "reserved", status: "pending", sourceId: "queue_q1" });
await store.saveSessionInput({ id: "queue_q3", sessionID: sessionId, kind: "sendText", delivery: "startNow", payload: { text: "hi" } });
await store.promoteSessionInput({
  id: "queue_q3",
  sessionID: sessionId,
  message: {
    id: "msg_user1",
    sessionID: sessionId,
    role: "user",
    time: { created: 2000 },
    agent: "zcode-agent",
    metadata: { inputIntent: { sharedContextRefs: [{ kind: "shared_context_import", context_id: "ctx-1" }] } },
  },
  parts: [],
});
steps.attach = await snapshot(peek);
peek.close();
store.close();

// A second store for the discard path.
const dbPath2 = join(dir, "db2.sqlite");
const store2 = await SqliteSessionStore.open({ dbPath: dbPath2 });
const bundle = {
  session: { id: sessionId, projectID: "proj_w", traceID: "trace1", slug: sessionId, directory, path: directory, title: history.title, titleSource: "custom", version: "0.1.0", permission: { mode }, time: { created: importedAt, updated: importedAt } },
  contextMessage: { info: { id: messageId, sessionID: sessionId, role: "user", time: { created: importedAt }, agent: "zcode-agent", modelSelection: model, synthetic: true, source: "shared_context", visibility: "model-only", semantics: { origin: "import", kind: "shared_context", source: "conversation_share", uiVisibility: "hidden", providerVisibility: "visible", transcriptVisibility: "visible" }, metadata: { shareId: "share1", contextId: "ctx-1", sharedContextStatus: "pending" } }, parts: [] },
  provenance: { id: ENTRY_ID, sessionID: sessionId, type: "v4/shared_context_import", time: { created: importedAt, updated: importedAt }, data: { ...history.provenance } },
};
await store2.commitSharedContextImportBundle(bundle);
const peek2 = new DatabaseSync(dbPath2);
const discarded = await store2.transitionSharedContextImport({ sessionID: sessionId, contextId: "ctx-1", expectedStatus: "pending", status: "discarded" });
steps.discard = { ok: discarded, ...(await snapshot(peek2)) };
const again = await store2.transitionSharedContextImport({ sessionID: sessionId, contextId: "ctx-1", expectedStatus: "pending", status: "discarded" });
steps.discard_again = { ok: again };
// A second commit of the same bundle returns the existing session and writes nothing.
await store2.commitSharedContextImportBundle(bundle);
steps.recommit = await snapshot(peek2);
peek2.close();
store2.close();

// The minimal case, in its own database, through the same bundle construction as persistImportedSessionHistory.
const minimal = zcodeSessionImportHistorySchema.parse(rawMinimal);
const sessionId2 = "sess_ctx2";
const messageId2 = `msg_${sessionId2}_shared_context`;
const contextId2 = minimal.provenance.contextId ?? `legacy-shared-context-${sessionId2}`;
const status2 = minimal.provenance.status ?? "pending";
const importedAt2 = 5000;
const dbPath3 = join(dir, "db3.sqlite");
const store3 = await SqliteSessionStore.open({ dbPath: dbPath3 });
await store3.commitSharedContextImportBundle({
  session: { id: sessionId2, projectID: "proj_w", traceID: "trace1", slug: sessionId2, directory, path: directory, title: minimal.title, titleSource: "custom", version: "0.1.0", permission: { mode }, time: { created: importedAt2, updated: importedAt2 } },
  contextMessage: {
    info: { id: messageId2, sessionID: sessionId2, role: "user", time: { created: importedAt2 }, agent: "zcode-agent", synthetic: true, source: "shared_context", visibility: "model-only", semantics: { origin: "import", kind: "shared_context", source: "conversation_share", uiVisibility: "hidden", providerVisibility: "visible", transcriptVisibility: "visible" }, metadata: { shareId: minimal.provenance.shareId, contextId: contextId2, sharedContextStatus: status2 } },
    parts: [{ id: `part_${sessionId2}_shared_context_text`, sessionID: sessionId2, messageID: messageId2, type: "text", text: minimal.markdown, time: { start: importedAt2, end: importedAt2 }, metadata: { sharedContext: true } }],
  },
  provenance: { id: `v4_shared_context_import:${sessionId2}:${minimal.provenance.shareId}`, sessionID: sessionId2, type: "v4/shared_context_import", time: { created: importedAt2, updated: importedAt2 }, data: { ...minimal.provenance, contextId: contextId2, status: status2 } },
});
store3.close();
const db3 = new DatabaseSync(dbPath3);
const minimalRows = {
  sessionId: sessionId2,
  raw: rawMinimal,
  parsed: minimal,
  session: db3.prepare("select title, title_source, slug, time_created, time_title_updated, permission from session where id = ?").get(sessionId2),
  messages: db3.prepare("select id, time_created, time_updated, data from message order by time_created, id").all(),
  parts: db3.prepare("select id, message_id, time_created, data from part order by time_created, id").all(),
  entries: db3.prepare("select id, session_id, type, time_created, time_updated, data from session_entry order by id").all(),
};
db3.close();

console.log(JSON.stringify({ sessionId, directory, model, mode, raw: rawFull, history, ...freshRows, steps, minimal: minimalRows }, null, 2));
