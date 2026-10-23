import { describe, expect, it } from "vitest";
import {
  DEFERRED_TOOL_CALL_NAME,
  LOCAL_TOOL_SEARCH_NAME,
  TOOL_SEARCH_NAME,
  isToolSearchName,
  toolSearchNameForMode,
  type ResolvedToolSearchMode,
} from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  buildToolExposure,
  buildToolSearchAnnouncement,
} from "../src/tool/search/exposure.js";
import { projectToolReferences } from "../src/tool/search/history.js";
import { LOCAL_TOOL_SEARCH_DESCRIPTION } from "../src/tool/search/description.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import {
  isToolNameDisallowed,
  normalizeToolNameAlias,
} from "../src/tool/tool-visibility.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

function fixture() {
  const registry = createToolRegistry();
  [toolSearchToolEntry, deferredToolCallEntry].forEach((tool) => registry.register(tool));
  registry.register({
    ...webFetchToolEntry,
    metadata: { ...webFetchToolEntry.metadata, shouldDefer: true },
  });
  const model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  return { registry, model, tools: registry.toContracts() };
}

function searchCall(name: string, id: string): RuntimeMessageEntry {
  return {
    message: {
      role: "assistant",
      content: [],
      toolCalls: [{ id, name, input: { query: "select:WebFetch" } }],
    },
  } as unknown as RuntimeMessageEntry;
}

function searchResult(toolName: string, id: string, content: unknown): RuntimeMessageEntry {
  return {
    message: { role: "tool", toolName, toolCallId: id, content },
  } as unknown as RuntimeMessageEntry;
}

function announcement(addedNames: string[]): RuntimeMessageEntry {
  return {
    kind: "attachment",
    content: "stored text that names ToolSearch",
    metadata: {
      source: "tool_search_announcement",
      toolSearchAnnouncement: { addedNames, removedNames: [], readdedNames: [] },
    },
  } as unknown as RuntimeMessageEntry;
}

const reference = { type: "tool_reference" as const, toolName: "WebFetch" };

describe("contract names", () => {
  it("maps the mode to the model-facing search name", () => {
    expect(LOCAL_TOOL_SEARCH_NAME).toBe("LocalToolSearch");
    expect(toolSearchNameForMode("local")).toBe("LocalToolSearch");
    expect(toolSearchNameForMode("native")).toBe("ToolSearch");
    expect(toolSearchNameForMode("off")).toBe("ToolSearch");
    expect(toolSearchNameForMode("auto")).toBe("ToolSearch");
  });

  it("treats either search name as a search tool name", () => {
    expect(isToolSearchName("ToolSearch")).toBe(true);
    expect(isToolSearchName("LocalToolSearch")).toBe(true);
    expect(isToolSearchName("WebFetch")).toBe(false);
  });
});

describe("registry resolution", () => {
  it("resolves LocalToolSearch to the single ToolSearch handler", () => {
    const registry = createToolRegistry();
    registry.register(toolSearchToolEntry);
    expect(registry.get(LOCAL_TOOL_SEARCH_NAME)).toBe(registry.get(TOOL_SEARCH_NAME));
    expect(registry.get(LOCAL_TOOL_SEARCH_NAME)?.metadata.name).toBe(TOOL_SEARCH_NAME);
  });
});

describe("tool exposure", () => {
  it("exposes the search definition as LocalToolSearch in local mode only", () => {
    const local = buildToolExposure({ ...fixture(), mode: "local", entries: [] });
    const localNames = local.tools.map((tool) => tool.name);
    expect(local.enabled).toBe(true);
    expect(localNames).toContain(LOCAL_TOOL_SEARCH_NAME);
    expect(localNames).not.toContain(TOOL_SEARCH_NAME);
    expect(localNames).toContain(DEFERRED_TOOL_CALL_NAME);
    const localSearch = local.tools.find((tool) => tool.name === LOCAL_TOOL_SEARCH_NAME);
    expect(localSearch?.description).toBe(LOCAL_TOOL_SEARCH_DESCRIPTION);

    const native = buildToolExposure({ ...fixture(), mode: "auto", entries: [] });
    const nativeNames = native.tools.map((tool) => tool.name);
    expect(nativeNames).toContain(TOOL_SEARCH_NAME);
    expect(nativeNames).not.toContain(LOCAL_TOOL_SEARCH_NAME);
  });

  it("keeps the canonical name in the deferred catalog", () => {
    const local = buildToolExposure({ ...fixture(), mode: "local", entries: [] });
    expect(local.context.catalog.map((tool) => tool.name)).not.toContain(LOCAL_TOOL_SEARCH_NAME);
    expect(local.context.catalog.map((tool) => tool.name)).toContain(TOOL_SEARCH_NAME);
    expect(local.context.catalog.filter((tool) => tool.deferred).map((tool) => tool.name)).toEqual([
      "WebFetch",
    ]);
  });

  it("names the local search tool in the DeferredToolCall description", () => {
    expect(deferredToolCallEntry.metadata.description).toContain("Use LocalToolSearch");
  });
});

describe("announcements", () => {
  it("names the search tool for the current mode", () => {
    const input = { ...fixture(), entries: [] };
    const local = buildToolSearchAnnouncement({ ...input, mode: "local" });
    expect(local?.content).toContain("available via LocalToolSearch");
    expect(local?.content).toContain("call them through DeferredToolCall");
    const native = buildToolSearchAnnouncement({ ...input, mode: "auto" });
    expect(native?.content).toContain("are now available via ToolSearch");
  });
});

describe("history replay with both names", () => {
  const modes: ResolvedToolSearchMode[] = ["native", "local"];

  it("rewrites an old ToolSearch row to LocalToolSearch in local mode", () => {
    const input = fixture();
    const entries = [searchCall("ToolSearch", "s1"), searchResult("ToolSearch", "s1", [reference])];
    const projected = projectToolReferences(entries, "local", [...input.tools], new Set(["WebFetch"]));
    expect(projected.entries[0]!.message.toolCalls).toEqual([
      { id: "s1", name: LOCAL_TOOL_SEARCH_NAME, input: { query: "select:WebFetch" } },
    ]);
    expect(projected.entries[1]!.message.toolName).toBe(LOCAL_TOOL_SEARCH_NAME);
  });

  it("rewrites a LocalToolSearch row to ToolSearch in native mode", () => {
    const input = fixture();
    const entries = [
      searchCall(LOCAL_TOOL_SEARCH_NAME, "s2"),
      searchResult(LOCAL_TOOL_SEARCH_NAME, "s2", [reference]),
    ];
    const projected = projectToolReferences(entries, "native", [...input.tools], new Set(["WebFetch"]));
    expect(projected.entries[0]!.message.toolCalls?.[0]?.name).toBe(TOOL_SEARCH_NAME);
    expect(projected.entries[1]!.message.toolName).toBe(TOOL_SEARCH_NAME);
    expect(projected.loadedToolCallIds.has("s2")).toBe(true);
  });

  it("leaves stored history unchanged", () => {
    const input = fixture();
    const entries = [searchCall("ToolSearch", "s3"), searchResult("ToolSearch", "s3", [reference])];
    const snapshot = JSON.stringify(entries);
    projectToolReferences(entries, "local", [...input.tools], new Set(["WebFetch"]));
    expect(JSON.stringify(entries)).toBe(snapshot);
  });

  it("does not rename anything in off mode", () => {
    const entries = [
      searchCall(LOCAL_TOOL_SEARCH_NAME, "s4"),
      searchResult(LOCAL_TOOL_SEARCH_NAME, "s4", "No matching deferred tools found"),
    ];
    const projected = projectToolReferences(entries, "off", fixture().tools, new Set());
    expect(projected.entries).toEqual(entries);
  });

  it("drops announcements in off mode and re-renders them for other modes", () => {
    const entries = [announcement(["WebFetch"])];
    expect(projectToolReferences(entries, "off", [], new Set()).entries).toEqual([]);
    const local = projectToolReferences(entries, "local", fixture().tools, new Set(["WebFetch"]));
    expect(local.entries[0]!.content).toContain("available via LocalToolSearch");
    const native = projectToolReferences(entries, "native", fixture().tools, new Set(["WebFetch"]));
    expect(native.entries[0]!.content).toContain("are now available via ToolSearch");
  });

  it("recognizes a successful native search under either name", () => {
    const entries = [
      searchResult(TOOL_SEARCH_NAME, "a", [reference]),
      searchResult(LOCAL_TOOL_SEARCH_NAME, "b", [reference]),
    ];
    const projected = projectToolReferences(entries, "native", fixture().tools, new Set(["WebFetch"]));
    expect(projected.loadedToolCallIds).toEqual(new Set(["a", "b"]));
  });

  it("recognizes a successful local search under either name", () => {
    const entries = [
      searchResult(TOOL_SEARCH_NAME, "a", [reference]),
      searchResult(LOCAL_TOOL_SEARCH_NAME, "b", [reference]),
    ];
    const projected = projectToolReferences(entries, "local", fixture().tools, new Set(["WebFetch"]));
    // Local keeps the loaded-hint in the result itself, so the native id set stays empty.
    expect(projected.loadedToolCallIds.size).toBe(0);
    const reminders = projected.entries.map((entry) => JSON.stringify(entry.message?.content));
    for (const reminder of reminders) expect(reminder).toContain("No additional LocalToolSearch is needed");
  });
});

describe("rule names", () => {
  it("maps LocalToolSearch to ToolSearch for rules and allowlists", () => {
    expect(normalizeToolNameAlias(LOCAL_TOOL_SEARCH_NAME)).toBe(TOOL_SEARCH_NAME);
    expect(isToolNameDisallowed(TOOL_SEARCH_NAME, [LOCAL_TOOL_SEARCH_NAME])).toBe(true);
    expect(isToolNameDisallowed(LOCAL_TOOL_SEARCH_NAME, ["ToolSearch"])).toBe(true);
    expect(isToolNameDisallowed("WebFetch", [LOCAL_TOOL_SEARCH_NAME])).toBe(false);
  });
});
