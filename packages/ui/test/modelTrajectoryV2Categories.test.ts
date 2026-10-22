import { describe, expect, it } from "vitest";
import type {
  ZCodeModelTrajectoryV2,
  ZCodeTrajectoryV2Record,
} from "../src/model-trajectory-v2/contract.js";
import {
  filterRowsByCategory,
  rowCategory,
  summarizeCategories,
} from "../src/model-trajectory-v2/domain/categorySummary.js";
import {
  classifyToolCall,
  collectMemoryRoots,
  findContextInjections,
  parseMcpToolName,
} from "../src/model-trajectory-v2/domain/eventCategories.js";
import { buildLedgerRows } from "../src/model-trajectory-v2/domain/ledger.js";

const ROOT = "/home/u/.zcode/cli/memories/projects/app-1a2b/memory";
const INDEX_TEXT = `<system-reminder>\nContents of ${ROOT}/MEMORY.md (user's auto-memory, persists across conversations):\n- [A](a.md)\n</system-reminder>`;
const RECALL_TEXT = `<system-reminder>\nRetrieved for possible relevance — use only if it actually applies to what the user asked.\n\nMemory: ${ROOT}/feedback_style.md:\n\nbody\n\nMemory: ${ROOT}/project_x.md:\n\nbody\n</system-reminder>`;

function record(
  requestId: string,
  second: number,
  extra: Partial<ZCodeTrajectoryV2Record> = {},
): ZCodeTrajectoryV2Record {
  return {
    requestId,
    attempt: 1,
    startedAt: `2026-10-22T10:00:${String(second).padStart(2, "0")}.000Z`,
    durationMs: 500,
    turnId: "turn-1",
    callSource: { kind: "main", querySource: "main_turn" },
    model: { providerId: "p", modelId: "m" },
    request: {
      messages: [],
      toolNames: [],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: false,
    },
    ...extra,
  };
}

function trajectory(records: ZCodeTrajectoryV2Record[]): ZCodeModelTrajectoryV2 {
  return {
    taskId: "t",
    available: true,
    truncated: false,
    sourceFiles: [],
    records,
    toolDefs: {},
    toolCatalogs: {},
    systemBlocks: {},
    systemPrompts: {},
    contextWindows: [],
    toolTiming: {
      source: "session-db",
      entries: [
        {
          toolCallId: "mcp-1",
          toolName: "x",
          status: "completed",
          scheduledAt: 1,
          execDurationMs: 300,
        },
        {
          toolCallId: "mcp-2",
          toolName: "x",
          status: "completed",
          scheduledAt: 1,
          execDurationMs: 200,
        },
      ],
    },
    budget: { toolDefBytes: 0, systemBytes: 0, omitted: false },
  };
}

const call = (id: string, toolName: string, input: unknown) => ({
  kind: "tool-call" as const,
  toolCallId: id,
  toolName,
  input,
});

function fixture() {
  const first = record("r1", 0, {
    request: {
      messages: [
        { role: "user", parts: [{ kind: "text", text: INDEX_TEXT }] },
        { role: "user", parts: [{ kind: "text", text: "/code-review this" }] },
      ],
      toolNames: [],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: false,
    },
    response: {
      toolCalls: [
        call("skill-1", "Skill", { skill: "code-review", args: "PR 283" }),
        call("mcp-1", "mcp__github__get_pull_request", { pr: 283 }),
        call("mcp-2", "mcp__plugin_image-search_image_search__search_image", { q: "x" }),
        call("mem-w", "Write", { file_path: `${ROOT}/feedback_style.md`, content: "x" }),
        call("bash-1", "Bash", { command: "ls" }),
      ],
    },
  });
  const second = record("r2", 5, {
    inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 2 },
    request: {
      messages: [
        { role: "assistant", parts: [{ kind: "text", text: "ok" }] },
        {
          role: "tool",
          parts: [
            {
              kind: "tool-result",
              toolCallId: "skill-1",
              toolName: "Skill",
              output: "Base directory…",
              truncated: { originalBytes: 6200, omittedBytes: 100 },
            },
          ],
        },
        { role: "user", parts: [{ kind: "text", text: RECALL_TEXT }] },
      ],
      toolNames: [],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: false,
    },
    response: { toolCalls: [call("mem-r", "Read", { file_path: `${ROOT}/project_x.md` })] },
  });
  const recall = record("r3", 6, {
    callSource: { kind: "sidecar", querySource: "project_memory_recall" },
  });
  const dream = record("r4", 9, {
    callSource: { kind: "sidecar", querySource: "dream" },
    response: {
      toolCalls: [
        call("d1", "Write", { file_path: "/x/.zcode/cli/memories/projects/other-9/memory/a.md" }),
        call("d2", "Edit", { file_path: `${ROOT}/b.md` }),
      ],
    },
  });
  return trajectory([first, second, recall, dream]);
}

describe("event categories", () => {
  it("parses MCP names at the first double underscore", () => {
    expect(parseMcpToolName("mcp__github__get_pull_request")).toEqual({
      server: "github",
      tool: "get_pull_request",
    });
    expect(parseMcpToolName("mcp__plugin_image-search_image_search__search_image")).toEqual({
      server: "plugin_image-search_image_search",
      tool: "search_image",
    });
    expect(parseMcpToolName("Bash")).toBeUndefined();
  });

  it("classifies skill, MCP and memory tool calls and leaves others alone", () => {
    const roots = [ROOT];
    expect(
      classifyToolCall({
        toolName: "Skill",
        args: { skill: "pdf" },
        memoryRoots: roots,
        result: { output: "x", truncatedBytes: 9000 },
      }),
    ).toEqual({ category: "skill", skill: { name: "pdf", loadedBytes: 9000 } });
    expect(
      classifyToolCall({
        toolName: "Read",
        args: { file_path: `${ROOT}/a.md` },
        memoryRoots: roots,
      })?.memory?.op,
    ).toBe("read");
    expect(
      classifyToolCall({
        toolName: "Edit",
        args: { file_path: `${ROOT}/a.md` },
        memoryRoots: roots,
      })?.memory?.op,
    ).toBe("write");
    expect(
      classifyToolCall({
        toolName: "Read",
        args: { file_path: "/repo/src/a.ts" },
        memoryRoots: roots,
      }),
    ).toBeUndefined();
    expect(classifyToolCall({ toolName: "Bash", args: {}, memoryRoots: roots })).toBeUndefined();
  });

  it("learns memory roots from the index header and finds index and recall injections", () => {
    const data = fixture();
    expect(collectMemoryRoots(data.records)).toEqual([ROOT]);
    const injections = findContextInjections(data.records[1]!.request.messages);
    expect(injections).toEqual([
      {
        source: "memory-recall",
        files: [`${ROOT}/feedback_style.md`, `${ROOT}/project_x.md`],
        text: RECALL_TEXT,
      },
    ]);
  });
});

describe("ledger categories", () => {
  it("tags tool rows, adds context rows from new input only, and shows memory sidecars with sidecars hidden", () => {
    const rows = buildLedgerRows(fixture());
    const tool = (id: string) => rows.find((row) => row.kind === "tool" && row.toolCallId === id);
    expect(tool("skill-1")).toMatchObject({
      category: {
        category: "skill",
        skill: { name: "code-review", args: "PR 283", loadedBytes: 6200 },
      },
    });
    expect(tool("mcp-1")).toMatchObject({ category: { mcp: { server: "github" } } });
    expect(tool("mem-w")).toMatchObject({
      category: { memory: { op: "write", fileName: "feedback_style.md" } },
    });
    expect(tool("bash-1")).not.toHaveProperty("category");
    const contexts = rows.filter((row) => row.kind === "context");
    expect(contexts.map((row) => row.kind === "context" && row.source)).toEqual([
      "memory-index",
      "memory-recall",
    ]);
    const markers = rows
      .filter((row) => row.kind === "marker")
      .map((row) => row.kind === "marker" && [row.marker, row.memoryWrites]);
    expect(markers).toEqual([
      ["memory-recall-selection", undefined],
      ["memory-dream", 2],
    ]);
    expect(rows.some((row) => row.kind === "request" && row.source === "sidecar")).toBe(false);
  });

  it("filters to one category, keeps turn headers and drops request separators", () => {
    const rows = buildLedgerRows(fixture());
    const mcp = filterRowsByCategory(rows, "mcp");
    expect(mcp.map((row) => row.kind)).toEqual(["turn", "tool", "tool"]);
    expect(
      filterRowsByCategory(rows, "memory").every(
        (row) => row.kind === "turn" || rowCategory(row) === "memory",
      ),
    ).toBe(true);
    expect(filterRowsByCategory(rows, null)).toHaveLength(rows.length);
  });

  it("summarizes over the whole window including hidden sidecar records", () => {
    const data = fixture();
    const summary = summarizeCategories(data, buildLedgerRows(data));
    expect(summary.skills).toEqual([{ name: "code-review", calls: 1 }]);
    expect(summary.mcpCalls).toBe(2);
    expect(summary.mcpServers).toEqual([
      { server: "github", calls: 1, execMs: 300 },
      { server: "plugin_image-search_image_search", calls: 1, execMs: 200 },
    ]);
    // Writes: the main Write plus both dream writes. Reads: the Read plus the index and recall injections.
    expect(summary.memoryWrites).toBe(3);
    expect(summary.memoryReads).toBe(3);
    expect(summary.memorySidecars).toBe(2);
  });
});
