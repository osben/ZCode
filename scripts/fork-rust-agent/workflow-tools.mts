// Generates the provider contracts of the dynamic-workflow tools (and ListModels) zcode-rs registers under the gate
// (packages/rust-cli/crates/tools/assets/node_workflow_tools.json) from Node's tool entries
// (apps/zcode-cli/packages/core/src/tool/handlers/*-workflow*.ts), so the descriptions, model instructions and input
// schemas stay Node's (specs/fork-rust-workflow-engine.md, W7-1). The description is Node's `toolDescriptionForProvider`
// (core/src/tool/registry.ts): the metadata description, then `Usage:` and one `- ` line per model instruction.
//
//   pnpm rust-agent:workflow-tools:update   # regenerate the asset
//   pnpm rust-agent:workflow-tools:check    # fail when out of date (CI, pre-push)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { amendWorkflowToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/amend-workflow.ts";
import { createWorkflowToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/create-workflow.ts";
import { evalWorkflowSnippetToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/eval-workflow-snippet.ts";
import { fillWorkflowHoleToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/fill-workflow-hole.ts";
import { getWorkflowRunToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run.ts";
import { listModelsToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/list-models.ts";
import { listSavedWorkflowsToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/list-saved-workflows.ts";
import { listWorkflowRunsToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/list-workflow-runs.ts";
import { resolveWorkflowQuestionToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/resolve-workflow-question.ts";
import { resumeWorkflowRunToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/resume-workflow-run.ts";
import { saveWorkflowToolEntry } from "../../apps/zcode-cli/packages/core/src/tool/handlers/save-workflow.ts";

// Node's registration order (core/src/tool/handlers/index.ts lists them in this order).
const ENTRIES = [
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  saveWorkflowToolEntry,
  evalWorkflowSnippetToolEntry,
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  resumeWorkflowRunToolEntry,
  resolveWorkflowQuestionToolEntry,
  fillWorkflowHoleToolEntry,
  listSavedWorkflowsToolEntry,
  // Not one of the ten gated tools by name, but registered right after them and behind the same gate in Rust.
  listModelsToolEntry,
];

const assetPath = fileURLToPath(
  new URL("../../packages/rust-cli/crates/tools/assets/node_workflow_tools.json", import.meta.url),
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
  shouldDefer: entry.metadata.shouldDefer ?? false,
  inputSchema: entry.inputSchema,
}));
const next = `${JSON.stringify(data, null, 2)}\n`;
const current = await readFile(assetPath, "utf8").catch(() => "");

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(`${assetPath} is out of date: run pnpm rust-agent:workflow-tools:update`);
    process.exit(1);
  }
} else if (next !== current) {
  await writeFile(assetPath, next);
}
