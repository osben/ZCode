import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  formatNestedInstructionMarker,
  readNestedInstructionHistory,
} from "../src/context/nested-instructions/history.js";

const ROOT = "/repo/packages/foo";
const FILE = `${ROOT}/AGENTS.md`;

function assistantCall(id: string, name: string, input: unknown): RuntimeMessageEntry {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name, input }],
    },
  };
}

function toolResult(toolCallId: string, content: string, isError = false): RuntimeMessageEntry {
  return {
    message: { role: "tool", toolCallId, content, isError } as ModelInputMessage,
  };
}

function reminderResult(toolCallId: string, paths: Array<[string, number]>): RuntimeMessageEntry {
  const body = paths
    .map(([path, bytes]) => `${formatNestedInstructionMarker(path, bytes)}\nInstructions from: x\nbody`)
    .join("\n");
  return toolResult(toolCallId, `file text\n\n<system-reminder>\n${body}\n</system-reminder>`);
}

describe("readNestedInstructionHistory", () => {
  it("reads delivered paths and injected byte totals from reminder markers", () => {
    const history = readNestedInstructionHistory(
      [
        reminderResult("c1", [
          [FILE, 120],
          [`${ROOT}/sub/AGENTS.md`, 40],
        ]),
      ],
      "linux",
    );

    expect([...history.delivered]).toEqual([FILE, `${ROOT}/sub/AGENTS.md`]);
    expect(history.bytesDelivered).toBe(160);
  });

  it("round-trips paths containing quotes and backslashes through the JSON-encoded marker", () => {
    const tricky = `/repo/weird "dir"/AGENTS.md`;
    const history = readNestedInstructionHistory(
      [reminderResult("c1", [[tricky, 7]])],
      "linux",
    );

    expect([...history.delivered]).toEqual([tricky]);
  });

  it("counts a successful full Read of the file as delivered", () => {
    const history = readNestedInstructionHistory(
      [
        assistantCall("r1", "Read", { file_path: FILE }),
        toolResult("r1", "1\tfoo rules"),
      ],
      "linux",
    );

    expect(history.delivered.has(FILE)).toBe(true);
    expect(history.bytesDelivered).toBe(0);
  });

  it("does not count a range Read or a failed Read as delivered", () => {
    const ranged = readNestedInstructionHistory(
      [
        assistantCall("r1", "Read", { file_path: FILE, offset: 10, limit: 5 }),
        toolResult("r1", "10\tpart"),
      ],
      "linux",
    );
    const failed = readNestedInstructionHistory(
      [
        assistantCall("r2", "Read", { file_path: FILE }),
        toolResult("r2", "error", true),
      ],
      "linux",
    );

    expect(ranged.delivered.size).toBe(0);
    expect(failed.delivered.size).toBe(0);
  });

  it("ignores attachments and entries without a tool call id", () => {
    const history = readNestedInstructionHistory(
      [
        {
          kind: "attachment",
          content: formatNestedInstructionMarker(FILE, 9),
          metadata: { source: "tool_result_warning" },
        },
        {
          message: { role: "user", content: formatNestedInstructionMarker(FILE, 9) },
        },
      ],
      "linux",
    );

    expect(history.delivered.size).toBe(0);
    expect(history.bytesDelivered).toBe(0);
  });

  it("keys delivered paths the same way discovery does on darwin", () => {
    const history = readNestedInstructionHistory(
      [reminderResult("c1", [["/Repo/Packages/Foo/AGENTS.md", 3]])],
      "darwin",
    );

    expect(history.delivered.has("/repo/packages/foo/agents.md")).toBe(true);
  });

  it("returns an empty view once the reminder-carrying result is no longer visible", () => {
    const visible = readNestedInstructionHistory([reminderResult("c1", [[FILE, 50]])], "linux");
    const afterMicrocompact = readNestedInstructionHistory(
      [toolResult("c1", "[tool result cleared]")],
      "linux",
    );

    expect(visible.bytesDelivered).toBe(50);
    expect(afterMicrocompact.delivered.size).toBe(0);
    expect(afterMicrocompact.bytesDelivered).toBe(0);
  });
});
