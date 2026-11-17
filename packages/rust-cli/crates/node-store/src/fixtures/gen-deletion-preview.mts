// Golden generator for the deletion preview revision (protocol-zcode fork/session_store_integration_tests.rs,
// GOLDEN_REVISION). Uses Node's SqliteSessionStore.inspectSessionDeletion and createNodeSessionDataFiles over
// session_deletion_golden.sql and the four files the Rust test lays out. The preview revision is the one-line hash
// of previewSessionDeletionWith (permanent-deletion.ts), restated here because that module does not load outside the
// CLI build (its workspace dependency chain).
//
// Rerun from the repository root (after `pnpm install`):
//   node_modules/.bin/tsx packages/rust-cli/crates/node-store/src/fixtures/gen-deletion-preview.mts \
//     packages/rust-cli/crates/node-store/src/fixtures/session_deletion_golden.sql
// Expected: the "revision" printed equals GOLDEN_REVISION in session_store_integration_tests.rs.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../../../../..", import.meta.url)));
const adapters = (path) => pathToFileURL(join(REPO, "apps/zcode-cli/packages/adapters/src", path)).href;
const { SqliteSessionStore } = await import(adapters("storage/session-store/sqlite-session-store.ts"));
const { createNodeSessionDataFiles } = await import(adapters("storage/session-data-files/index.ts"));

const fixture = process.argv[2];
if (!fixture) throw new Error("usage: gen-deletion-preview.mts <session_deletion_golden.sql>");
const storage = mkdtempSync(join(tmpdir(), "del-node-"));
const cli = join(storage, "cli");
const dbPath = join(cli, "db", "db.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
(await SqliteSessionStore.open({ dbPath })).close();
const db = new DatabaseSync(dbPath);
db.exec(readFileSync(fixture, "utf8"));
db.close();
for (const path of ["artifacts/root/own.txt", "artifacts/child/art1-ref.bin", "artifacts/child/other.txt", "exec/child/log.txt"]) {
  mkdirSync(dirname(join(cli, path)), { recursive: true });
  writeFileSync(join(cli, path), "0123");
}
const store = await SqliteSessionStore.open({ dbPath });
const files = createNodeSessionDataFiles({ cliStorageRoot: cli, memoryRoot: () => join(storage, "unused") });
const snapshot = await store.inspectSessionDeletion("root");
const listed = [];
for (const id of snapshot.sessionIds) for (const file of await files.listSessionFiles(id)) listed.push({ sessionId: id, ...file });
const retained = snapshot.references.flatMap((ref) => {
  const matched = listed.filter((f) => f.sessionId === ref.sessionId && f.kind === "artifact" && f.name.includes(ref.artifactId));
  return matched.length ? matched.map((f) => ({ ...ref, fileName: f.name })) : [{ ...ref, fileName: ref.artifactId }];
});
const deletedFiles = listed.filter((f) => !retained.some((r) => r.sessionId === f.sessionId && r.fileName === f.name && f.kind === "artifact")).length;
const revision = createHash("sha256")
  .update(JSON.stringify([snapshot.revision, listed.map((f) => [f.relativePath, f.bytes]), null]))
  .digest("hex");
console.log(JSON.stringify({ revision, sessionIds: snapshot.sessionIds, forks: snapshot.forks, retainedArtifacts: retained, deletedFiles, incomplete: snapshot.deleting, completed: snapshot.completed }, null, 2));
store.close();
