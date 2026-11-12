import {
  type PluginMaterialReader,
  rethrowPluginMaterialInterrupt,
  PLUGIN_MATERIAL_READ_CONCURRENCY,
} from "./helpers.js";
import { readFile } from "node:fs/promises";

/** 分批读取避免一次启动所有文件 IO；数组顺序保留同名组件的既有优先级。 */
export async function readMarkdownFrontmatters(paths: string[], materials?: PluginMaterialReader) {
  const results = [];
  for (let offset = 0; offset < paths.length; offset += PLUGIN_MATERIAL_READ_CONCURRENCY) {
    results.push(
      ...(await Promise.all(
        paths
          .slice(offset, offset + PLUGIN_MATERIAL_READ_CONCURRENCY)
          .map((path) => readMarkdownFrontmatter(path, materials)),
      )),
    );
  }
  return results;
}

/**
 * Lightweight Markdown frontmatter extraction with YAML block scalars (`>` folded / `|` literal, including `+`/`-` chomping variants).
 *
 * Plugin marketplace details (plugins/describe) used a one-line regex to read `name`/`description`. For a block
 * scalar such as `description: >`, it treated the `>` indicator as the description, leaving every skill entry
 * with only `>` as its description. Reuse the block-scalar parsing rules from the skills adapter (see
 * skills/index.ts) to fold/join following indented lines into a complete description. If frontmatter or a key is
 * missing, omit it gracefully; never fabricate a value.
 *
 * Extract only the name/description scalar keys needed for skills/commands details; this is not a full YAML parser.
 */
export async function readMarkdownFrontmatter(
  filePath: string,
  materials?: PluginMaterialReader,
): Promise<{
  name?: string;
  description?: string;
}> {
  let content: string;
  try {
    if (materials) return await materials.parsed(filePath, "frontmatter", parseMarkdownFrontmatter);
    content = await readFile(filePath, "utf8");
  } catch (error) {
    rethrowPluginMaterialInterrupt(error);
    return {};
  }
  return parseMarkdownFrontmatter(content);
}

/** Pure-function version that parses frontmatter directly from Markdown text, making block-scalar branches easy to test. */
export function parseMarkdownFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) return {};
  const values = parseFlatYamlScalars(frontmatter);
  const result: { name?: string; description?: string } = {};
  const name = parseScalar(values.name);
  if (name) result.name = name;
  const description = parseScalar(values.description);
  if (description) result.description = description;
  return result;
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

/** Parse top-level `key: value` entries; block scalars (`>`/`|`) absorb following indented lines. Keep scalar string values only. */
function parseFlatYamlScalars(frontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    // Indented lines belong to the preceding block scalar, so skip them during the top-level scan.
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in values) continue;
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }
  return values;
}

function parseBlockScalarStyle(value: string): "folded" | "literal" | null {
  if (/^>[+-]?$/.test(value)) return "folded";
  if (/^\|[+-]?$/.test(value)) return "literal";
  return null;
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
  style: "folded" | "literal",
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    // A non-empty, non-indented line ends the block scalar (returning to a top-level key).
    if (line.trim().length > 0 && !/^\s/.test(line)) break;
    rawLines.push(line);
    index += 1;
  }
  const indent = rawLines.reduce<number | null>((current, line) => {
    if (line.trim().length === 0) return current;
    const lineIndent = leadingWhitespaceLength(line);
    return current === null ? lineIndent : Math.min(current, lineIndent);
  }, null);
  const contentLines = rawLines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(indent ?? 0),
  );
  return {
    value: style === "folded" ? foldBlockScalarLines(contentLines) : contentLines.join("\n").trim(),
    nextIndex: index,
  };
}

function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}

/** Folded style (`>`): convert line breaks within a paragraph to spaces and separate paragraphs at blank lines. */
function foldBlockScalarLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function applyCommandMetadataFrontmatter(
  markdown: string,
  metadata: Record<string, unknown>,
): string {
  const frontmatter = new Map<string, string>();
  if (typeof metadata.description === "string" && metadata.description.trim()) {
    frontmatter.set("description", metadata.description.trim());
  }
  if (typeof metadata.argumentHint === "string" && metadata.argumentHint.trim()) {
    frontmatter.set("argument-hint", metadata.argumentHint.trim());
  }
  if (typeof metadata.model === "string" && metadata.model.trim()) {
    frontmatter.set("model", metadata.model.trim());
  }
  if (Array.isArray(metadata.allowedTools)) {
    const allowedTools = metadata.allowedTools
      .filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
      .map((tool) => tool.trim());
    if (allowedTools.length > 0) frontmatter.set("allowed-tools", allowedTools.join(", "));
  }
  if (frontmatter.size === 0) return markdown;
  const body = stripMarkdownFrontmatter(markdown).trimStart();
  return `---\n${Array.from(frontmatter, ([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}`;
}

function stripMarkdownFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return markdown;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return markdown;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex > 0 ? lines.slice(endIndex + 1).join("\n") : markdown;
}
