// Golden generator for node-store import_history_tests.rs. Runs Node's own SqliteSessionStore with the exact call
// sequence of persistImportedSessionHistory (apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts,
// the non-sharedContext branch) for the fixed input below, then prints the stored rows.
//
// Rerun from the repository root (after `pnpm install` and a build of apps/zcode-cli/packages/contracts):
//   node_modules/.bin/tsx packages/rust-cli/crates/node-store/src/fixtures/gen-imported-history.mts \
//     > packages/rust-cli/crates/node-store/src/fixtures/imported_history_golden.json
// Columns that hold the wall clock of the run (session.time_updated, part.time_updated) are left out.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../../../../..", import.meta.url)));
const { SqliteSessionStore } = await import(
  pathToFileURL(join(REPO, "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts")).href
);

const sessionId = "sess_imp1";
const directory = "/w";
const model = { providerId: "p", modelId: "m" };
const mode = "build";
const history = {
  source: "claudeCode",
  title: "  Imported chat  ",
  createdAt: 1000,
  updatedAt: 2000,
  messages: [
    { role: "user", content: "hello", timestamp: 1000 },
    { role: "assistant", content: "hi", timestamp: 900 },
    { role: "user", content: "again" },
    { role: "assistant", content: "ok" },
    { role: "assistant", content: "second answer", timestamp: 5000 },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "imp-golden-"));
const dbPath = join(dir, "db.sqlite");
const store = await SqliteSessionStore.open({ dbPath });
const createdAt = history.createdAt ?? history.messages[0]?.timestamp ?? Date.now();
const updatedAt = history.updatedAt ?? history.messages.at(-1)?.timestamp ?? createdAt;
await store.createSession({
  id: sessionId,
  projectID: "proj_w",
  traceID: "trace1",
  slug: sessionId,
  directory,
  path: directory,
  title: history.title.trim() || "Imported session",
  titleSource: "custom",
  version: "0.1.0",
  permission: { mode },
  time: { created: createdAt, updated: Math.max(createdAt, updatedAt) },
});
let lastUserMessageId: string | undefined;
let lastTimestamp = createdAt - 1;
for (const [index, message] of history.messages.entries()) {
  const raw = message.timestamp ?? createdAt + index;
  const timestamp = raw > lastTimestamp ? raw : lastTimestamp + 1;
  lastTimestamp = timestamp;
  const messageId = `msg_${sessionId}_import_${index}`;
  if (message.role === "user") {
    lastUserMessageId = messageId;
    await store.saveMessage({
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: { created: timestamp },
      agent: "zcode-agent",
      modelSelection: model,
      metadata: { migrationSource: history.source },
    });
  } else {
    await store.saveMessage({
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: timestamp, completed: timestamp },
      parentID: lastUserMessageId ?? `msg_${sessionId}_import_parent_${index}`,
      modelId: model.modelId,
      providerId: model.providerId,
      mode,
      agent: "zcode-agent",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    });
  }
  await store.savePart({
    id: `part_${sessionId}_import_${index}_text`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text: message.content,
    time: { start: timestamp, end: timestamp },
    metadata: { migrationSource: history.source },
  });
}
store.close();

const db = new DatabaseSync(dbPath);
const session = db
  .prepare(
    "select title, title_source, slug, time_created, time_title_updated, permission from session where id = ?",
  )
  .get(sessionId);
const messages = db
  .prepare("select id, time_created, time_updated, data from message order by time_created, id")
  .all();
const parts = db
  .prepare("select id, message_id, time_created, data from part order by time_created, id")
  .all();
db.close();
console.log(JSON.stringify({ sessionId, directory, model, mode, history, session, messages, parts }, null, 2));
