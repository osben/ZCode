// Fork: the blocked-prompt hook row and chat error banner the Rust agent projects (specs/fork-rust-agent-parity.md,
// HK-UP-01). The Rust test `a_blocked_prompt_shows_its_input_its_hook_row_and_the_banner` asserts the same golden,
// so the App's strict schemas check the Rust shape without either side running the other.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hookInvocationRowSchema, sessionErrorInfoSchema } from "@zcode/shared/zcode-protocol-v4";

const GOLDEN = fileURLToPath(
  new URL(
    "../../../../../../packages/rust-cli/crates/protocol-zcode/tests/fixtures/hook-invocation-blocked.json",
    import.meta.url,
  ),
);

interface Golden {
  row: Record<string, unknown>;
  lastError: Record<string, unknown>;
}

async function golden(): Promise<Golden> {
  return JSON.parse(await readFile(GOLDEN, "utf8")) as Golden;
}

// The golden leaves out the fields that depend on the projection's position (the Rust test removes them too).
const POSITION = { rowId: 3, createdAt: 2003, createdAtSeq: 3 };

describe("Rust blocked-prompt hook projection", () => {
  it("parses under the App's hook invocation row schema", async () => {
    const { row } = await golden();
    const parsed = hookInvocationRowSchema.safeParse({ ...row, ...POSITION });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("keeps an execution to the strict schema's keys", async () => {
    const { row } = await golden();
    const executions = row.executions as Record<string, unknown>[];
    const extra = { ...row, ...POSITION, executions: [{ ...executions[0], stderrPreview: "x" }] };
    expect(hookInvocationRowSchema.safeParse(extra).success).toBe(false);
  });

  it("parses under the App's session error schema", async () => {
    const { lastError } = await golden();
    const parsed = sessionErrorInfoSchema.safeParse({ ...lastError, at: 2004 });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
