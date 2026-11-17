// Generates the provider contracts of the desktop off-peak tools zcode-rs serves under `node_desktop`
// (packages/rust-cli/crates/tools/assets/node_off_peak_tools.json) from Node's tool entries
// (apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts), so the descriptions, model instructions and input
// schemas stay Node's (specs/fork-rust-automations.md, slice 3). The description is Node's
// `toolDescriptionForProvider` (core/src/tool/registry.ts), as in automation-tools.mts.
//
//   pnpm rust-agent:off-peak-tools:update   # regenerate the asset
//   pnpm rust-agent:off-peak-tools:check    # fail when out of date (CI, pre-push)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  offPeakCreateToolEntry,
  offPeakListToolEntry,
} from "../../apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts";

// Node's registration order (core/src/tool/handlers/index.ts).
const ENTRIES = [offPeakCreateToolEntry, offPeakListToolEntry];

const assetPath = fileURLToPath(
  new URL("../../packages/rust-cli/crates/tools/assets/node_off_peak_tools.json", import.meta.url),
);

// Node `toolDescriptionForProvider`.
function providerDescription(metadata: {
  description?: string;
  modelInstructions?: readonly string[];
}): string {
  const description = metadata.description ?? "";
  const instructions = metadata.modelInstructions?.map((line) => line.trim()).filter(Boolean) ?? [];
  if (instructions.length === 0) return description;
  const usage = ["Usage:", ...instructions.map((instruction) => `- ${instruction}`)].join("\n");
  return description.length > 0 ? `${description}\n\n${usage}` : usage;
}

const data = ENTRIES.map((entry) => ({
  name: entry.metadata.name,
  description: providerDescription(entry.metadata),
  searchHint: entry.metadata.searchHint ?? null,
  readOnly: entry.metadata.readOnly,
  destructive: entry.metadata.destructive,
  concurrentSafe: entry.metadata.concurrentSafe,
  needsApproval: entry.metadata.needsApproval,
  shouldDefer: entry.metadata.shouldDefer,
  inputSchema: entry.inputSchema,
}));
const next = `${JSON.stringify(data, null, 2)}\n`;
const current = await readFile(assetPath, "utf8").catch(() => "");

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(`${assetPath} is out of date: run pnpm rust-agent:off-peak-tools:update`);
    process.exit(1);
  }
} else if (next !== current) {
  await writeFile(assetPath, next);
}
