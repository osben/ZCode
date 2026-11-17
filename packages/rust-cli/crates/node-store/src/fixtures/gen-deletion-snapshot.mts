// Golden generator for the permanent-deletion store revision (node-store session_deletion_tests.rs,
// GOLDEN_REVISION). Runs Node's own SqliteSessionStore.inspectSessionDeletion over session_deletion_golden.sql.
//
// Rerun from the repository root (after `pnpm install`):
//   node_modules/.bin/tsx packages/rust-cli/crates/node-store/src/fixtures/gen-deletion-snapshot.mts \
//     packages/rust-cli/crates/node-store/src/fixtures/session_deletion_golden.sql
// Expected: the "revision" printed equals GOLDEN_REVISION in session_deletion_tests.rs.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

// Repository root: six levels above this fixtures directory.
const REPO = resolve(fileURLToPath(new URL("../../../../../..", import.meta.url)));
const { SqliteSessionStore } = await import(
  pathToFileURL(join(REPO, "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts")).href
);

const fixture = process.argv[2];
if (!fixture) throw new Error("usage: gen-deletion-snapshot.mts <session_deletion_golden.sql>");
const dir = mkdtempSync(join(tmpdir(), "del-golden-"));
const dbPath = join(dir, "db.sqlite");
const first = await SqliteSessionStore.open({ dbPath });
first.close();
const db = new DatabaseSync(dbPath);
db.exec(readFileSync(fixture, "utf8"));
db.close();
const store = await SqliteSessionStore.open({ dbPath });
const snapshot = await store.inspectSessionDeletion("root");
store.close();
console.log(JSON.stringify(snapshot, null, 2));
