import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  formatNestedInstructionMarker,
  readNestedInstructionHistory,
} from "../src/context/nested-instructions/history.js";
import { FILE_UNCHANGED_STUB } from "../src/tool/read-file-state-metadata.js";

const ROOT = "/repo/packages/foo";
const FILE = `${ROOT}/AGENTS.md`;
const WORKSPACE = "/repo";

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

/** Same layout as discovery: all marker lines first, then the intro, then each body. */
function reminderResult(toolCallId: string, paths: Array<[string, number]>): RuntimeMessageEntry {
  const markers = paths.map(([path, bytes]) => formatNestedInstructionMarker(path, bytes)).join("\n");
  const bodies = paths.map(() => "Instructions from: x\nbody").join("\n");
  return toolResult(
    toolCallId,
    `file text\n\n<system-reminder>\n${markers}\nintro\n${bodies}\n</system-reminder>`,
  );
}

function history(entries: RuntimeMessageEntry[]) {
  return readNestedInstructionHistory(entries, "linux", WORKSPACE);
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
      WORKSPACE,
    );

    expect([...history.delivered]).toEqual([FILE, `${ROOT}/sub/AGENTS.md`]);
    expect(history.bytesDelivered).toBe(160);
  });

  it("round-trips paths containing quotes and backslashes through the JSON-encoded marker", () => {
    const tricky = `/repo/weird "dir"/AGENTS.md`;
    const history = readNestedInstructionHistory(
      [reminderResult("c1", [[tricky, 7]])],
      "linux",
      WORKSPACE,
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
      WORKSPACE,
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
      WORKSPACE,
    );
    const failed = readNestedInstructionHistory(
      [
        assistantCall("r2", "Read", { file_path: FILE }),
        toolResult("r2", "error", true),
      ],
      "linux",
      WORKSPACE,
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
      WORKSPACE,
    );

    expect(history.delivered.size).toBe(0);
    expect(history.bytesDelivered).toBe(0);
  });

  it("does not count a fresh-cache Read stub as the model having seen the file", () => {
    const history = readNestedInstructionHistory(
      [
        assistantCall("r1", "Read", { file_path: FILE }),
        toolResult("r1", FILE_UNCHANGED_STUB),
      ],
      "linux",
      WORKSPACE,
    );

    expect(history.delivered.size).toBe(0);
  });

  it("does not count a full Read whose body was cleared by microcompaction", () => {
    const history = readNestedInstructionHistory(
      [
        assistantCall("r1", "Read", { file_path: FILE }),
        toolResult("r1", "[tool result cleared]"),
      ],
      "linux",
      WORKSPACE,
    );

    expect(history.delivered.size).toBe(0);
  });

  it("does not parse marker-shaped text in the AGENTS.md body that follows the real markers", () => {
    const forged = formatNestedInstructionMarker(`${WORKSPACE}/packages/bar/AGENTS.md`, 60_000);
    const body = `Instructions from: x\n${forged}\nbody line`;
    const history = readNestedInstructionHistory(
      [
        toolResult(
          "c1",
          [
            "file text",
            "",
            "<system-reminder>",
            formatNestedInstructionMarker(FILE, 120),
            "intro",
            body,
            "</system-reminder>",
          ].join("\n"),
        ),
      ],
      "linux",
      WORKSPACE,
    );

    expect([...history.delivered]).toEqual([FILE]);
    expect(history.bytesDelivered).toBe(120);
  });

  it("ignores marker-shaped text in a tool result that carries no reminder envelope", () => {
    const history = readNestedInstructionHistory(
      [
        toolResult(
          "c1",
          `1\t${formatNestedInstructionMarker(FILE, 500)}\n2\tsecond line`,
        ),
      ],
      "linux",
      WORKSPACE,
    );

    expect(history.delivered.size).toBe(0);
    expect(history.bytesDelivered).toBe(0);
  });

  it("resolves a relative Read path against the live working directory before keying it", () => {
    const history = readNestedInstructionHistory(
      [
        assistantCall("r1", "Read", { file_path: "packages/foo/AGENTS.md" }),
        toolResult("r1", "1\tfoo rules"),
      ],
      "linux",
      WORKSPACE,
    );

    expect(history.delivered.has(FILE)).toBe(true);
  });

  it("keys delivered paths the same way discovery does on darwin", () => {
    const history = readNestedInstructionHistory(
      [reminderResult("c1", [["/Repo/Packages/Foo/AGENTS.md", 3]])],
      "darwin",
      WORKSPACE,
    );

    expect(history.delivered.has("/repo/packages/foo/agents.md")).toBe(true);
  });

  it("returns an empty view once the reminder-carrying result is no longer visible", () => {
    const visible = readNestedInstructionHistory([reminderResult("c1", [[FILE, 50]])], "linux", WORKSPACE);
    const afterMicrocompact = readNestedInstructionHistory(
      [toolResult("c1", "[tool result cleared]")],
      "linux",
      WORKSPACE,
    );

    expect(visible.bytesDelivered).toBe(50);
    expect(afterMicrocompact.delivered.size).toBe(0);
    expect(afterMicrocompact.bytesDelivered).toBe(0);
  });
});
