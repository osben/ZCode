import type {
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeTrajectoryV2Record,
} from "../contract.js";

/**
 * Skill, memory and MCP classification (specs/model-trajectory-v2.md, "Event categories"). Depends on runtime names and
 * text markers: the `Skill` tool, the `mcp__<server>__<tool>` naming, the request-user-context MEMORY.md header, the
 * recall attachment text, and the project memory root layout. Keep these in sync with the runtime.
 */
export type EventCategory = "skill" | "memory" | "mcp";
export type MemoryOperation = "read" | "write";

export interface ToolCategoryInfo {
  category: EventCategory;
  skill?: { name: string; args?: string; loadedBytes?: number };
  mcp?: { server: string; tool: string };
  memory?: { op: MemoryOperation; path: string; fileName: string };
}

export type ContextInjectionSource = "memory-index" | "memory-recall";

export interface ContextInjection {
  source: ContextInjectionSource;
  files: string[];
  text: string;
}

export type MemorySidecar = "recall-selection" | "dream";

const SKILL_TOOL = "Skill";
const MCP_PREFIX = "mcp__";
const MEMORY_READ_TOOLS = new Set(["Read"]);
const MEMORY_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const MEMORY_INDEX_PATTERN = /Contents of (.+?)([\\/])MEMORY\.md \(user's auto-memory/g;
const RECALL_MARKER = "Retrieved for possible relevance";
const RECALL_FILE_PATTERN = /^Memory: (.+):\s*$/gm;
const PROJECT_MEMORY_PATH = /\/memories\/projects\/[^/]+\/memory\//;

export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined;
  const rest = name.slice(MCP_PREFIX.length);
  const split = rest.indexOf("__");
  if (split <= 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function textOf(parts: readonly ZCodeModelTrajectoryContentPart[]): string {
  return parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n");
}

/** Memory roots and files named by injections anywhere in the window. */
export function collectMemoryRoots(records: readonly ZCodeTrajectoryV2Record[]): string[] {
  const roots = new Set<string>();
  for (const record of records) {
    for (const message of record.request.messages) {
      if (message.role === "assistant" || message.role === "tool") continue;
      for (const match of textOf(message.parts).matchAll(MEMORY_INDEX_PATTERN)) {
        if (match[1]) roots.add(match[1]);
      }
    }
  }
  return [...roots];
}

/** Windows tool inputs and memory headers use `\\`; compare with one separator. */
function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isMemoryPath(path: string, roots: readonly string[]): boolean {
  const normalized = toSlashes(path);
  return (
    PROJECT_MEMORY_PATH.test(normalized) ||
    roots.some((root) => normalized.startsWith(`${toSlashes(root)}/`))
  );
}

function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as { file_path?: unknown; path?: unknown; filePath?: unknown };
  const path = value.file_path ?? value.path ?? value.filePath;
  return typeof path === "string" ? path : undefined;
}

function resultBytes(output: unknown, truncatedBytes: number | undefined): number | undefined {
  if (truncatedBytes !== undefined) return truncatedBytes;
  if (output === undefined) return undefined;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text ? new TextEncoder().encode(text).length : undefined;
}

export function classifyToolCall(input: {
  toolName: string;
  args: unknown;
  memoryRoots: readonly string[];
  result?: { output: unknown; truncatedBytes?: number };
}): ToolCategoryInfo | undefined {
  const { toolName, args } = input;
  if (toolName === SKILL_TOOL) {
    const value = (args ?? {}) as { skill?: unknown; args?: unknown };
    const loadedBytes = resultBytes(input.result?.output, input.result?.truncatedBytes);
    return {
      category: "skill",
      skill: {
        name: typeof value.skill === "string" ? value.skill : "skill",
        ...(typeof value.args === "string" && value.args ? { args: value.args } : {}),
        ...(loadedBytes !== undefined ? { loadedBytes } : {}),
      },
    };
  }
  const mcp = parseMcpToolName(toolName);
  if (mcp) return { category: "mcp", mcp };
  const isRead = MEMORY_READ_TOOLS.has(toolName);
  if (isRead || MEMORY_WRITE_TOOLS.has(toolName)) {
    const path = inputPath(args);
    if (path && isMemoryPath(path, input.memoryRoots)) {
      return {
        category: "memory",
        memory: { op: isRead ? "read" : "write", path, fileName: baseName(path) },
      };
    }
  }
  return undefined;
}

/** Memory index and recall injections in a list of new input messages. */
export function findContextInjections(
  messages: readonly ZCodeModelTrajectoryMessage[],
): ContextInjection[] {
  const injections: ContextInjection[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "system") continue;
    const text = textOf(message.parts);
    const roots = [...text.matchAll(MEMORY_INDEX_PATTERN)].map(
      (match) => `${match[1]}${match[2]}MEMORY.md`,
    );
    if (roots.length > 0) injections.push({ source: "memory-index", files: roots, text });
    if (text.includes(RECALL_MARKER)) {
      const files = [...text.matchAll(RECALL_FILE_PATTERN)].map((match) => match[1] ?? "");
      injections.push({ source: "memory-recall", files: files.filter(Boolean), text });
    }
  }
  return injections;
}

export function memorySidecarOf(record: ZCodeTrajectoryV2Record): MemorySidecar | undefined {
  const source = record.callSource?.querySource;
  if (source === "project_memory_recall") return "recall-selection";
  if (source === "dream") return "dream";
  return undefined;
}

export function fileNameOf(path: string): string {
  return baseName(path);
}
