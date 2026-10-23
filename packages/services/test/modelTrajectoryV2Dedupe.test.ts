import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  createTrajectoryInterner,
  type TrajectoryInternBudgets,
} from "../src/model-trajectory-v2/domain/dedupe.js";

const anthropicTools = [
  { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
  { name: "Read", description: "Read a file", input_schema: { type: "object" } },
];

describe("createTrajectoryInterner", () => {
  it("interns identical catalogs once with stable ids", () => {
    const interner = createTrajectoryInterner();
    const first = interner.internToolCatalog(anthropicTools);
    const second = interner.internToolCatalog(structuredClone(anthropicTools));
    expect(first).toBe("tc:0");
    expect(second).toBe("tc:0");
    const snapshot = interner.snapshot();
    expect(Object.keys(snapshot.toolCatalogs)).toEqual(["tc:0"]);
    expect(Object.keys(snapshot.toolDefs)).toEqual(["td:0", "td:1"]);
    expect(snapshot.toolCatalogs["tc:0"]).toEqual({
      toolDefIds: ["td:0", "td:1"],
      bytes: expect.any(Number),
    });
    expect(snapshot.budget.omitted).toBe(false);
  });

  it("adds one definition for a catalog that differs by one tool", () => {
    const interner = createTrajectoryInterner();
    const base = interner.internToolCatalog(anthropicTools);
    const grown = interner.internToolCatalog([
      ...anthropicTools,
      { name: "Grep", description: "Search", input_schema: { type: "object" } },
    ]);
    expect(base).toBe("tc:0");
    expect(grown).toBe("tc:1");
    const snapshot = interner.snapshot();
    expect(Object.keys(snapshot.toolDefs)).toHaveLength(3);
    expect(snapshot.toolCatalogs["tc:1"]?.toolDefIds).toEqual(["td:0", "td:1", "td:2"]);
  });

  it("ignores cache_control differences when keying definitions", () => {
    const interner = createTrajectoryInterner();
    interner.internToolCatalog(anthropicTools);
    interner.internToolCatalog([
      { ...anthropicTools[0], cache_control: { type: "ephemeral" } },
      anthropicTools[1],
    ]);
    const snapshot = interner.snapshot();
    expect(Object.keys(snapshot.toolDefs)).toEqual(["td:0", "td:1"]);
  });

  it("normalizes OpenAI-shaped tools onto the same definition", () => {
    const interner = createTrajectoryInterner();
    const first = interner.internToolCatalog([
      {
        name: "search",
        description: "Search the docs",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    const second = interner.internToolCatalog([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the docs",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
    expect(first).toBe("tc:0");
    expect(second).toBe("tc:1");
    const snapshot = interner.snapshot();
    expect(Object.keys(snapshot.toolDefs)).toEqual(["td:0"]);
    expect(snapshot.toolDefs["td:0"]?.name).toBe("search");
  });

  it("interns the same system text once whether given as a string or as text blocks", () => {
    const interner = createTrajectoryInterner();
    const asString = interner.internSystemPrompt("You are a coding agent.");
    const asBlocks = interner.internSystemPrompt([
      { type: "text", text: "You are a coding agent." },
    ]);
    expect(asString).toBe("sp:0");
    expect(asBlocks).toBe("sp:0");
    const snapshot = interner.snapshot();
    expect(Object.keys(snapshot.systemBlocks)).toEqual(["sb:0"]);
    expect(Object.keys(snapshot.systemPrompts)).toEqual(["sp:0"]);
    expect(snapshot.systemPrompts["sp:0"]).toEqual({
      blockIds: ["sb:0"],
      bytes: "You are a coding agent.".length,
    });
  });

  it("returns undefined for empty tool catalogs and empty system prompts", () => {
    const interner = createTrajectoryInterner();
    expect(interner.internToolCatalog(undefined)).toBeUndefined();
    expect(interner.internToolCatalog([])).toBeUndefined();
    expect(interner.internSystemPrompt(undefined)).toBeUndefined();
    expect(interner.internSystemPrompt("")).toBeUndefined();
    expect(interner.internSystemPrompt([])).toBeUndefined();
  });

  it("truncates an oversized description but keeps the schema object", () => {
    const interner = createTrajectoryInterner(smallBudgets({ toolDescriptionBytes: 16 }));
    interner.internToolCatalog([
      { name: "Bash", description: "0123456789abcdefghij", input_schema: { type: "object" } },
    ]);
    const def = interner.snapshot().toolDefs["td:0"];
    expect(def?.description).toContain("…");
    expect(def?.description?.startsWith("0123456789ab")).toBe(true);
    expect(def?.truncated).toEqual({ originalBytes: 20, omittedBytes: 8 });
    expect(def?.inputSchema).toEqual({ type: "object" });
  });

  it("stringifies an oversized schema and marks it truncated", () => {
    const interner = createTrajectoryInterner(smallBudgets({ toolSchemaBytes: 10 }));
    interner.internToolCatalog([{ name: "Read", input_schema: { type: "object" } }]);
    const def = interner.snapshot().toolDefs["td:0"];
    expect(typeof def?.inputSchema).toBe("string");
    expect(def?.inputSchema).toContain("…");
    expect(def?.truncated).toEqual({ originalBytes: 17, omittedBytes: 10 });
    expect(def?.truncated?.omittedBytes).toBeGreaterThan(0);
  });

  it("omits definitions past the total budget, keeping only name and bytes", () => {
    const interner = createTrajectoryInterner(smallBudgets({ toolDefTotalBytes: 100 }));
    interner.internToolCatalog([
      { name: "Alpha", description: "short" },
      { name: "Beta", description: "a much longer description that blows the budget" },
    ]);
    const { toolDefs, budget } = interner.snapshot();
    expect(Object.keys(toolDefs["td:0"] ?? {}).sort()).toEqual(["bytes", "description", "name"]);
    expect(toolDefs["td:1"]).toMatchObject({ name: "Beta", omitted: true });
    expect(Object.keys(toolDefs["td:1"] ?? {}).sort()).toEqual(["bytes", "name", "omitted"]);
    expect(toolDefs["td:1"]?.bytes).toBeGreaterThan(0);
    expect(budget.omitted).toBe(true);
    expect(budget.toolDefBytes).toBe(Buffer.byteLength(JSON.stringify(toolDefs["td:0"]), "utf8"));
  });

  it("omits system blocks past the total system budget", () => {
    // 23 bytes fits the 30-byte total; adding the 24-byte second block does not.
    const interner = createTrajectoryInterner(smallBudgets({ systemTotalBytes: 30 }));
    interner.internSystemPrompt("first system block text");
    const promptId = interner.internSystemPrompt("second system block text");
    expect(promptId).toBe("sp:1");
    const { systemBlocks, systemPrompts, budget } = interner.snapshot();
    expect(systemBlocks["sb:0"]?.text).toBe("first system block text");
    expect(systemBlocks["sb:1"]).toMatchObject({ text: "", omitted: true });
    expect(systemBlocks["sb:1"]?.bytes).toBe("second system block text".length);
    expect(systemPrompts["sp:0"]).toEqual({ blockIds: ["sb:0"], bytes: 23 });
    expect(systemPrompts["sp:1"]).toEqual({ blockIds: ["sb:1"], bytes: 24 });
    expect(budget.omitted).toBe(true);
    expect(budget.systemBytes).toBe(23);
  });

  it("bounds multi-byte text to the budget bytes without splitting characters", () => {
    const cyrillicBudgets = smallBudgets({ systemBlockBytes: 31 });
    const interner = createTrajectoryInterner(cyrillicBudgets);
    interner.internSystemPrompt("Д".repeat(100));
    const cyrillic = interner.snapshot().systemBlocks["sb:0"];
    expect(cyrillic?.truncated).toEqual({ originalBytes: 200, omittedBytes: 176 });
    expect(cyrillic?.text).not.toContain("�");
    expect(Buffer.byteLength(cyrillic?.text ?? "", "utf8")).toBeLessThanOrEqual(
      cyrillicBudgets.systemBlockBytes,
    );

    const emojiBudgets = smallBudgets({ systemBlockBytes: 50 });
    const emojiInterner = createTrajectoryInterner(emojiBudgets);
    emojiInterner.internSystemPrompt("🚀😀✅".repeat(20));
    const emoji = emojiInterner.snapshot().systemBlocks["sb:0"];
    expect(emoji?.truncated?.originalBytes).toBe(220);
    expect(emoji?.text).not.toContain("�");
    expect(Buffer.byteLength(emoji?.text ?? "", "utf8")).toBeLessThanOrEqual(
      emojiBudgets.systemBlockBytes,
    );
    expect(emoji?.text).toContain("…");
  });
});

/** Full defaults except the overrides, so each case stays realistic. */
function smallBudgets(overrides: Partial<TrajectoryInternBudgets>): TrajectoryInternBudgets {
  return {
    toolDescriptionBytes: 16 * 1024,
    toolSchemaBytes: 32 * 1024,
    toolDefTotalBytes: 1024 * 1024,
    systemBlockBytes: 64 * 1024,
    systemTotalBytes: 256 * 1024,
    ...overrides,
  };
}
