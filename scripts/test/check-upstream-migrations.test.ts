// Real-code coverage for the upstream migration freeze gate (specs/upstream-migration-freeze.md).
// Run: pnpm --dir apps/zcode-cli exec tsx --test ../../scripts/test/check-upstream-migrations.test.ts
// (or pnpm exec tsx --test scripts/test/check-upstream-migrations.test.ts from the repository root).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkBaseline, parseBaseline, upstreamEntries } from "../upstream-migration-baseline.mjs";
import { collectLedgers, type MigrationOverrides } from "../check-upstream-migrations.ts";
import { SESSION_DATABASE_MIGRATIONS } from "../../apps/zcode-cli/packages/adapters/src/storage/session-store/fork-migrations.js";
import { CONTROLLER_REMOTE_SCHEMA_SQL } from "../../packages/services/src/session/tasksDatabase/controller-remote-schema-v4.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function loadBaseline() {
  return parseBaseline(
    await readFile(`${ROOT}/fork-upstream-migrations.json`, "utf8"),
    "fork-upstream-migrations.json",
  );
}

test("the ledgers the runners write on fresh databases equal the committed baseline", async () => {
  const [baseline, collected] = await Promise.all([loadBaseline(), collectLedgers()]);
  for (const [set, entries] of Object.entries(baseline.sets)) {
    assert.deepEqual(upstreamEntries(collected[set] ?? []), entries, set);
  }
});

test("an edited upstream SQL (cli 0014) fails the check naming the id", async () => {
  const [baseline, collected] = await Promise.all([
    loadBaseline(),
    collectLedgers({
      cli: SESSION_DATABASE_MIGRATIONS.map((migration) =>
        migration.id === "0014_message_part_sequence"
          ? { ...migration, sql: `${migration.sql}\n-- edited` }
          : migration,
      ) as MigrationOverrides["cli"],
    }),
  ]);
  const errors = checkBaseline({
    baseline,
    pin: baseline.upstreamCommit,
    collected,
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0]!,
    /Frozen upstream migration changed: cli 0014_message_part_sequence expected 66b45c45e4d3a1a60829f193f38d865dcdbd3de2eb78aa79ba954fe7ef1aab08 got [0-9a-f]{64}/,
  );
});

test("an edited tasks checksumInput (controller-remote) fails the check naming the id", async () => {
  const [baseline, collected] = await Promise.all([
    loadBaseline(),
    collectLedgers({
      "tasks_index:controller-remote": [
        {
          id: "0004_controller_remote_identity",
          appVersion: "3.12.0",
          // The real sql is JSON.stringify([CONTROLLER_REMOTE_SCHEMA_SQL]); editing the checksumInput
          // material goes through the same sha256(sql.trim()) ledger write as in production.
          sql: JSON.stringify([`${CONTROLLER_REMOTE_SCHEMA_SQL}\n-- edited`]),
          touchedTables: ["controller_remote_identity_migrations"],
          apply: (db) => db.exec(CONTROLLER_REMOTE_SCHEMA_SQL),
        },
      ],
    }),
  ]);
  const errors = checkBaseline({
    baseline,
    pin: baseline.upstreamCommit,
    collected,
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0]!,
    /Frozen upstream migration changed: tasks_index:controller-remote 0004_controller_remote_identity/,
  );
});

test("a trailing-whitespace-only edit passes (every checksum is computed over sql.trim())", async () => {
  const [baseline, collected] = await Promise.all([
    loadBaseline(),
    collectLedgers({
      cli: SESSION_DATABASE_MIGRATIONS.map((migration) =>
        migration.id === "0014_message_part_sequence"
          ? { ...migration, sql: `${migration.sql}\n   ` }
          : migration,
      ) as MigrationOverrides["cli"],
    }),
  ]);
  const errors = checkBaseline({
    baseline,
    pin: baseline.upstreamCommit,
    collected,
  });
  assert.deepEqual(errors, []);
});

test("a new 9006_fork_* id passes the check", async () => {
  const [baseline, collected] = await Promise.all([
    loadBaseline(),
    collectLedgers({
      cli: [
        ...(SESSION_DATABASE_MIGRATIONS as MigrationOverrides["cli"]),
        {
          id: "9006_fork_test_only",
          appVersion: "9.9.9",
          sql: "",
          touchedTables: ["session"],
        },
      ],
    }),
  ]);
  const errors = checkBaseline({
    baseline,
    pin: baseline.upstreamCommit,
    collected,
  });
  assert.deepEqual(errors, []);
});
