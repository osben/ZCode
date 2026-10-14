import { open } from "node:fs/promises";
import { isMap, parseDocument } from "yaml";
import { PROJECT_MEMORY_ITEM_TYPES, type ProjectMemoryItemType } from "./memory.js";

// Match only a leading frontmatter block; a later "---" line is plain Markdown content.
const PROJECT_MEMORY_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// The catalog scan only needs the leading metadata block; the byte bound keeps a pathological file
// from stalling the read-only snapshot, and the line bound keeps the parse input small.
const FRONTMATTER_SCAN_MAX_BYTES = 2 * 1024;
const FRONTMATTER_SCAN_MAX_LINES = 30;

export interface ProjectMemoryFrontmatterMeta {
  description?: string;
  type?: ProjectMemoryItemType;
}

function isProjectMemoryItemType(value: unknown): value is ProjectMemoryItemType {
  return (
    typeof value === "string" && (PROJECT_MEMORY_ITEM_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Frontmatter reader for catalog display only. Unknown keys are ignored, non-string or unknown
 * types are dropped, and any broken YAML degrades to "no meta" for that file; the catalog must
 * never fail on file content.
 */
export function parseProjectMemoryFrontmatter(content: string): ProjectMemoryFrontmatterMeta {
  // A leading BOM would hide the "---" block from hand-edited files; the CLI recall parser strips it too.
  const normalized = content.replace(/^\uFEFF/u, "");
  const match = PROJECT_MEMORY_FRONTMATTER_PATTERN.exec(normalized);
  if (!match) {
    return {};
  }
  const document = parseDocument(match[1]!);
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return {};
  }
  const meta: ProjectMemoryFrontmatterMeta = {};
  const description = document.get("description");
  if (typeof description === "string" && description.trim().length > 0) {
    meta.description = description.trim();
  }
  const metadata = document.get("metadata", true);
  if (isMap(metadata)) {
    const type = metadata.get("type");
    if (isProjectMemoryItemType(type)) {
      meta.type = type;
    }
  }
  return meta;
}

/** Read the leading lines of a Memory file for frontmatter extraction. */
export async function readProjectMemoryFrontmatterHead(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(FRONTMATTER_SCAN_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer
      .toString("utf-8", 0, bytesRead)
      .split(/\r?\n/)
      .slice(0, FRONTMATTER_SCAN_MAX_LINES)
      .join("\n");
  } finally {
    await handle.close();
  }
}

/** Strip the leading frontmatter block so line counting mirrors the CLI injection pipeline. */
export function stripProjectMemoryFrontmatter(content: string): string {
  return content.replace(PROJECT_MEMORY_FRONTMATTER_PATTERN, "");
}
