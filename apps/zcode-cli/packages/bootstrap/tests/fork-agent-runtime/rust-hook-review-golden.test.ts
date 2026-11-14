// Fork: the workspace hook review interaction the Rust agent publishes (specs/fork-rust-agent-parity.md,
// "Workspace hook review flow"). The Rust test `a_request_publishes_nodes_review_interaction` asserts the
// same golden, so the App's strict schema checks the Rust shape without either side running the other.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pendingInteractionSchema } from "@zcode/shared/zcode-protocol-v4";

const GOLDEN = fileURLToPath(
  new URL(
    "../../../../../../packages/rust-cli/crates/protocol-zcode/tests/fixtures/hook-review-interaction.json",
    import.meta.url,
  ),
);

async function golden(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(GOLDEN, "utf8")) as Record<string, unknown>;
}

describe("Rust workspace hook review interaction", () => {
  it("parses under the App's pending interaction schema", async () => {
    const parsed = pendingInteractionSchema.safeParse(await golden());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("is rejected when its summary disagrees with its items", async () => {
    const interaction = await golden();
    const payload = interaction.payload as { summary: { pendingCount: number } };
    payload.summary.pendingCount += 1;
    expect(pendingInteractionSchema.safeParse(interaction).success).toBe(false);
  });
});
