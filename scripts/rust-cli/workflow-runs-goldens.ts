#!/usr/bin/env -S pnpm exec tsx
/**
 * Writes the Node side of the workflowRuns reducer goldens (rust-cli node-store, W3).
 *
 * The generator lives in packages/shared/src/zcode-protocol-v4/workflow-runs-goldens.ts, next to the
 * reducer it records. Its drift guard, workflow-runs-goldens.test.ts, compares the committed fixture
 * with the generator's output, so rerun this script whenever the reducer or delta changes.
 *
 * Output: packages/rust-cli/crates/node-store/fixtures/workflow-runs/goldens.json (replaced in full),
 * read by `workflow_runs::tests` in Rust.
 *
 * Run from the repository root with:
 *   pnpm exec tsx scripts/rust-cli/workflow-runs-goldens.ts
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGoldens,
  serializeGoldens,
} from "../../packages/shared/src/zcode-protocol-v4/workflow-runs-goldens.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../packages/rust-cli/crates/node-store/fixtures/workflow-runs");

function main(): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "goldens.json"), serializeGoldens(buildGoldens()));
}

// Compare real paths so that a symlinked or relative invocation still runs main, while an import does not.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) main();
