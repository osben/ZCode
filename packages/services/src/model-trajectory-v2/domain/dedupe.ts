import type {
  TrajectoryCatalogId,
  TrajectorySystemBlockId,
  TrajectorySystemPromptId,
  TrajectoryToolDefId,
  ZCodeTrajectoryV2Budget,
  ZCodeTrajectoryV2SystemBlock,
  ZCodeTrajectoryV2SystemPrompt,
  ZCodeTrajectoryV2ToolCatalog,
  ZCodeTrajectoryV2ToolDef,
} from "../contract.js";
import { boundTextTo } from "./bound.js";
import { asArray, asObject, asString, canonicalJson, utf8Bytes } from "./values.js";

export interface TrajectoryInternBudgets {
  toolDescriptionBytes: number;
  toolSchemaBytes: number;
  toolDefTotalBytes: number;
  systemBlockBytes: number;
  systemTotalBytes: number;
}

/** specs/model-trajectory-v2.md, "Payload budget". */
export const DEFAULT_INTERN_BUDGETS: TrajectoryInternBudgets = {
  toolDescriptionBytes: 16 * 1024,
  toolSchemaBytes: 32 * 1024,
  toolDefTotalBytes: 1024 * 1024,
  systemBlockBytes: 64 * 1024,
  systemTotalBytes: 256 * 1024,
};

export interface TrajectoryInternSnapshot {
  toolDefs: Record<TrajectoryToolDefId, ZCodeTrajectoryV2ToolDef>;
  toolCatalogs: Record<TrajectoryCatalogId, ZCodeTrajectoryV2ToolCatalog>;
  systemBlocks: Record<TrajectorySystemBlockId, ZCodeTrajectoryV2SystemBlock>;
  systemPrompts: Record<TrajectorySystemPromptId, ZCodeTrajectoryV2SystemPrompt>;
  budget: ZCodeTrajectoryV2Budget;
}

export interface TrajectoryInterner {
  /** Intern a wire `tools` array; undefined when there are no tools. */
  internToolCatalog(tools: unknown): TrajectoryCatalogId | undefined;
  /** Intern a wire `system` value (string or text blocks); undefined when empty. */
  internSystemPrompt(system: unknown): TrajectorySystemPromptId | undefined;
  snapshot(): TrajectoryInternSnapshot;
}

/**
 * Intern tool definitions and system blocks across one trajectory response. Definitions are keyed by canonical JSON
 * without `cache_control` (breakpoints live on the record), so a catalog that changes by one tool adds one definition.
 * Ids are assigned in first-seen order, so the same input always yields the same ids.
 */
export function createTrajectoryInterner(
  budgets: TrajectoryInternBudgets = DEFAULT_INTERN_BUDGETS,
): TrajectoryInterner {
  const toolDefs: Record<TrajectoryToolDefId, ZCodeTrajectoryV2ToolDef> = {};
  const toolCatalogs: Record<TrajectoryCatalogId, ZCodeTrajectoryV2ToolCatalog> = {};
  const systemBlocks: Record<TrajectorySystemBlockId, ZCodeTrajectoryV2SystemBlock> = {};
  const systemPrompts: Record<TrajectorySystemPromptId, ZCodeTrajectoryV2SystemPrompt> = {};
  const defByKey = new Map<string, TrajectoryToolDefId>();
  const catalogByKey = new Map<string, TrajectoryCatalogId>();
  const blockByKey = new Map<string, TrajectorySystemBlockId>();
  const promptByKey = new Map<string, TrajectorySystemPromptId>();
  const budget: ZCodeTrajectoryV2Budget = { toolDefBytes: 0, systemBytes: 0, omitted: false };

  function internToolDef(raw: unknown): TrajectoryToolDefId {
    const normalized = normalizeToolDef(raw);
    const key = canonicalJson(normalized);
    const existing = defByKey.get(key);
    if (existing) return existing;
    const id = `td:${defByKey.size}`;
    defByKey.set(key, id);
    const bytes = utf8Bytes(key);
    const def = boundToolDef(normalized, bytes, budgets);
    const storedBytes = utf8Bytes(JSON.stringify(def));
    if (budget.toolDefBytes + storedBytes > budgets.toolDefTotalBytes) {
      toolDefs[id] = { name: normalized.name, bytes, omitted: true };
      budget.omitted = true;
    } else {
      toolDefs[id] = def;
      budget.toolDefBytes += storedBytes;
    }
    return id;
  }

  function internToolCatalog(tools: unknown): TrajectoryCatalogId | undefined {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    // A whole-array key first: consecutive calls almost always repeat the catalog, so the per-definition work runs once.
    const catalogKey = JSON.stringify(tools);
    const existing = catalogByKey.get(catalogKey);
    if (existing) return existing;
    const toolDefIds = tools.map(internToolDef);
    const id = `tc:${catalogByKey.size}`;
    catalogByKey.set(catalogKey, id);
    toolCatalogs[id] = {
      toolDefIds,
      bytes: toolDefIds.reduce((sum, defId) => sum + (toolDefs[defId]?.bytes ?? 0), 0),
    };
    return id;
  }

  function internSystemBlock(text: string): TrajectorySystemBlockId {
    const existing = blockByKey.get(text);
    if (existing) return existing;
    const id = `sb:${blockByKey.size}`;
    blockByKey.set(text, id);
    const bytes = utf8Bytes(text);
    const bounded = boundTextTo(text, budgets.systemBlockBytes);
    const storedBytes = utf8Bytes(bounded.text);
    if (budget.systemBytes + storedBytes > budgets.systemTotalBytes) {
      systemBlocks[id] = { text: "", bytes, omitted: true };
      budget.omitted = true;
    } else {
      systemBlocks[id] = bounded.truncated
        ? { text: bounded.text, bytes, truncated: bounded.truncated }
        : { text: bounded.text, bytes };
      budget.systemBytes += storedBytes;
    }
    return id;
  }

  function internSystemPrompt(system: unknown): TrajectorySystemPromptId | undefined {
    const texts = systemTexts(system);
    if (texts.length === 0) return undefined;
    const blockIds = texts.map(internSystemBlock);
    const key = blockIds.join(",");
    const existing = promptByKey.get(key);
    if (existing) return existing;
    const id = `sp:${promptByKey.size}`;
    promptByKey.set(key, id);
    systemPrompts[id] = {
      blockIds,
      bytes: blockIds.reduce((sum, blockId) => sum + (systemBlocks[blockId]?.bytes ?? 0), 0),
    };
    return id;
  }

  return {
    internToolCatalog,
    internSystemPrompt,
    snapshot: () => ({
      toolDefs,
      toolCatalogs,
      systemBlocks,
      systemPrompts,
      budget: { ...budget },
    }),
  };
}

interface NormalizedToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Anthropic `{name, description, input_schema}` or OpenAI `{type:"function", function:{name, description, parameters}}`. */
function normalizeToolDef(raw: unknown): NormalizedToolDef {
  const tool = asObject(raw) ?? {};
  const fn = asObject(tool.function);
  const source = fn ?? tool;
  const normalized: NormalizedToolDef = { name: asString(source.name) ?? "tool" };
  const description = asString(source.description);
  if (description !== undefined) normalized.description = description;
  const inputSchema = source.input_schema ?? source.parameters ?? source.inputSchema;
  if (inputSchema !== undefined) normalized.inputSchema = inputSchema;
  return normalized;
}

function boundToolDef(
  tool: NormalizedToolDef,
  bytes: number,
  budgets: TrajectoryInternBudgets,
): ZCodeTrajectoryV2ToolDef {
  const def: ZCodeTrajectoryV2ToolDef = { name: tool.name, bytes };
  let originalBytes = 0;
  let omittedBytes = 0;
  if (tool.description !== undefined) {
    const bounded = boundTextTo(tool.description, budgets.toolDescriptionBytes);
    def.description = bounded.text;
    if (bounded.truncated) {
      originalBytes += bounded.truncated.originalBytes;
      omittedBytes += bounded.truncated.omittedBytes;
    }
  }
  if (tool.inputSchema !== undefined) {
    const json = JSON.stringify(tool.inputSchema) ?? "";
    const bounded = boundTextTo(json, budgets.toolSchemaBytes);
    def.inputSchema = bounded.truncated ? bounded.text : tool.inputSchema;
    if (bounded.truncated) {
      originalBytes += bounded.truncated.originalBytes;
      omittedBytes += bounded.truncated.omittedBytes;
    }
  }
  if (omittedBytes > 0) def.truncated = { originalBytes, omittedBytes };
  return def;
}

function systemTexts(system: unknown): string[] {
  if (typeof system === "string") return system ? [system] : [];
  return asArray(system)
    .map((block) => asString(asObject(block)?.text) ?? asString(block))
    .filter((text): text is string => typeof text === "string" && text.length > 0);
}
