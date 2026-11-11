// Regenerates the fork-owned command entries of zcode-rs's inbound schema
// (packages/rust-cli/crates/protocol-zcode/schema/inbound.json) from the App's zod schemas, the same
// way the upstream generator writes every other entry (`z.toJSONSchema(schema, { io: "input" })`).
// Only the commands listed here are rewritten; the rest of the file is left as upstream generated it.
//
//   pnpm exec tsx scripts/fork-rust-agent/inbound-schema.mts          # rewrite
//   pnpm exec tsx scripts/fork-rust-agent/inbound-schema.mts --check  # fail when out of date
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { commandPayloadSchemas } from "../../packages/shared/src/zcode-protocol-v4/command.ts";

// The fork commands zcode-rs accepts (specs/fork-rust-agent-parity.md "Execution worktree").
const FORK_COMMANDS = ["createSession", "updateWorktreePreparation"] as const;

const schemaPath = fileURLToPath(
  new URL("../../packages/rust-cli/crates/protocol-zcode/schema/inbound.json", import.meta.url),
);
// zod from the package that owns the schemas, so the converter and the schemas are one instance.
const { z } = createRequire(
  fileURLToPath(new URL("../../packages/shared/package.json", import.meta.url)),
)("zod") as typeof import("zod");

const current = await readFile(schemaPath, "utf8");
const data = JSON.parse(current) as { commands: Record<string, unknown> };
for (const name of FORK_COMMANDS) {
  data.commands[name] = z.toJSONSchema(commandPayloadSchemas[name], {
    io: "input",
    unrepresentable: "any",
  });
}
data.commands = Object.fromEntries(
  Object.entries(data.commands).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
const next = `${JSON.stringify(data, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(`${schemaPath} is out of date: run scripts/fork-rust-agent/inbound-schema.mts`);
    process.exit(1);
  }
} else if (next !== current) {
  await writeFile(schemaPath, next);
}
