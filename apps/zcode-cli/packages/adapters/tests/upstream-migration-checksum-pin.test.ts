import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";

// Upstream (zai-org/ZCode) ledger checksums. The fork shares ~/.zcode/cli/db/db.sqlite with the
// upstream app, so any change to these migrations' SQL text, comments included, makes the other
// build reject the database. Never update these values; restore the upstream SQL instead.
const UPSTREAM_CHECKSUMS: Record<string, string> = {
  "0001_base_session_store": "60e2d6a38ab36f31417c4f92c02690c96c7dcaaa0b6abe1741117d62a55c6462",
  "0002_local_setting": "22a6ada9325c9ad55a00a1f0ecf72332c63c1e89fc3d91fec8d155bb0058b465",
  "0003_backfill_permission_local_setting":
    "bd880375ba7b948c8bcda847e7eb52bc568d065bcba48190f6c3bfb14d11b7dc",
  "0004_session_target": "df670752991c78e38e2f25b0a003abc0e9689bc8d4894351358f2f83335a3ae1",
  "0005_session_target_accounting":
    "6138ed4562dfdd5b571d39d3b62266c55dd9eb8f2f41948e046441a0e4a954cc",
  "0006_input_history_attachments":
    "a2eab98649d738e15bdae27de7c5c114713f7777c55aa4111b19e03ee5ced54f",
  "0007_workflow_script_runtime":
    "0068fc4bcaffe4de4669442a62eee227726e0e8e81b61c7458213a20ac596009",
  "0008_workflow_definition_scope":
    "f7ee304e4005c291fb8883cfc180005263e6c6b2f94077487443f2c17a71d3eb",
  "0009_session_title_metadata": "3855cf957177ae6319ae91866cdff59e946ca07a10b36b5b59689818bd13fe00",
  "0010_usage_observability": "36918b0a98f465fe844097aa60c65ef73ea9c62cc266f02742bf3fc2cedf860b",
  "0011_session_target_summary_title":
    "2b7723479426a4e7a1ed9901ed817495c1bbf63e9547eb1c63cd9e24bf9305f8",
  "0012_session_trace_id": "9dcef90998dd00c8ed1b22a2170e180eb15471b93947e65ebe101d41e96bdb60",
  "0013_session_target_active_run_accounting":
    "7ab185540ebb7d26c5403ca52a50de6cf161c79cb93ccd47ff1b43b87415fe1c",
  "0014_message_part_sequence": "66b45c45e4d3a1a60829f193f38d865dcdbd3de2eb78aa79ba954fe7ef1aab08",
  "0015_message_part_sequence_backfill_and_guard":
    "da3046bf061ebb5ba253bb772f0fc9e4d1f2856dac4cdbc4cc0a65aae00e8511",
  "0016_session_input_ledger": "18d51ae3f5e1425dc1e5c809282129fdc7430cacb6b1ce517b412ddbc34be790",
  "0017_session_input_start_now_delivery":
    "8c2da5985ecdf342438a2df713c9e18114276a0e85ce6f2e4f79bdf1596b52f8",
  "0018_session_input_failed_status":
    "a4d1a7b7c5d4af426b695769ed0f3a031efac8aa7af1f6412a85292c42b5d15b",
  "0019_dwf_journal": "1c8da5568d2357f25c392be486fae80e1f3ad3ebc830dab1bee941634573e8ba",
  "0020_provider_model_selection":
    "681180b4fcb497e13289b6970021678f24c975efdf3538777541105c5b2b444e",
  "0021_official_glm_selection": "433a8da454682406e962b043f2e0f412e9801bf7e4641ff25760aa16625ebafe",
  "0022_backfilled_session_reasoning":
    "aee472fe499e9c25d2e71df0fbc68d92e462b30d1d02919ca35d540bf133c99a",
};

describe("upstream session migration checksum pin", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("pins upstream ids only", () => {
    expect(Object.keys(UPSTREAM_CHECKSUMS).filter((id) => id.startsWith("9001_fork_"))).toEqual([]);
  });

  it("a fresh database writes exactly the upstream checksum for every upstream migration", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    runSqliteSessionMigrations(db, ":memory:");
    const ledger = Object.fromEntries(
      db
        .prepare("SELECT id, checksum FROM schema_migration")
        .all()
        .map((row) => [row.id, row.checksum]),
    );
    for (const [id, checksum] of Object.entries(UPSTREAM_CHECKSUMS)) {
      expect({ id, checksum: ledger[id] }).toEqual({ id, checksum });
    }
  });

  it("still accepts the fork-written translated 0020 checksum", () => {
    const migration = SQLITE_MIGRATIONS.find((m) => m.id === "0020_provider_model_selection");
    expect(migration?.acceptedHistoricalChecksums).toContain(
      "31fdaa50915e6ee967de3d8072a7f98bab64da0ac2864275589e4a2740eda788",
    );
  });
});
