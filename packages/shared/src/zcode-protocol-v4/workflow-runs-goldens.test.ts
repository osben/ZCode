// Drift guard for the Rust workflowRuns goldens (rust-cli node-store, W3).
// The fixture is produced by scripts/rust-cli/workflow-runs-goldens.ts from this package's reducer and
// delta. If either changes without regenerating the fixture, the Rust tests would keep checking the old
// bytes; this test fails instead, and the fix is to rerun the generator.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildGoldens,
  serializeGoldens,
} from "../../../../scripts/rust-cli/workflow-runs-goldens.ts";

const FIXTURE = fileURLToPath(
  new URL(
    "../../../../packages/rust-cli/crates/node-store/fixtures/workflow-runs/goldens.json",
    import.meta.url,
  ),
);

describe("workflowRuns Rust goldens", () => {
  it("the committed fixture is what the Node reducer produces today", () => {
    const committed = readFileSync(FIXTURE, "utf8");
    expect(committed).toBe(serializeGoldens(buildGoldens()));
  });
});
