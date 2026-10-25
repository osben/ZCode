// ============================================================
// Saved workflows - frontmatter codec
// ============================================================
//
// File format:
//
//     /* zcode-workflow
//     description: ...
//     args:
//       pr: { type: string, required: true }
//     */
//     <plain dwf script>
//
// Why use a **block comment** instead of Markdown-style `---` fences? Saved files use the `.dwf.ts` extension, and users open them in
// editors or may edit them directly. A block comment keeps the whole file valid TypeScript, so syntax highlighting, bracket matching,
// and formatting keep working; `---` would make the first line a syntax error.
//
// Use YAML rather than JSON for the body: `yaml` is already a direct @zcode/core dependency, and hand-editing YAML is more forgiving
// than editing JSON full of quotes and commas. This file is read by people.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SavedWorkflowMetaSchema, type SavedWorkflowMeta } from "@zcode/contracts";

/** Opening marker for frontmatter. Must be the first non-whitespace content in the file. */
export const SAVED_WORKFLOW_SENTINEL = "/* zcode-workflow";

/** Closing marker for frontmatter: a line containing only the block-comment terminator. */
const SAVED_WORKFLOW_TERMINATOR = "*/";

export type SavedWorkflowParseErrorReason =
  | "missing_frontmatter"
  | "unterminated_frontmatter"
  | "invalid_yaml"
  | "invalid_metadata";

export type SavedWorkflowParseResult =
  | {
      ok: true;
      meta: SavedWorkflowMeta;
      script: string;
      /**
       * Number of lines before the body (leading blanks + opening marker + YAML + closing line). Add this when reporting diagnostics
       * using **file lines**: `fileLine = bodyLine + bodyLineOffset`. Compilation sees only the text after the closing line, so the two
       * line-number systems always differ by this constant; counting it at every call site is a common source of mismatched diagnostics.
       */
      bodyLineOffset: number;
    }
  | { ok: false; reason: SavedWorkflowParseErrorReason; detail: string };

/**
 * Metadata + script → file body.
 *
 * Put the script **byte-for-byte** after the closing line: reading after saving must return exactly what the author wrote. Otherwise,
 * the run's script hash would differ from what the user sees in the editor (resume compares against the original script).
 */
export function serializeSavedWorkflow(meta: SavedWorkflowMeta, script: string): string {
  // Fix key order (description → whenToUse → args) rather than relying on object insertion order: two saves must produce byte-identical
  // files, or every SaveWorkflow call creates a meaningless git diff.
  const body: Record<string, unknown> = { description: meta.description };
  if (meta.whenToUse !== undefined) body.whenToUse = meta.whenToUse;
  if (meta.args !== undefined) body.args = meta.args;

  // stringify includes a trailing newline, so place the closing line directly after it.
  return `${SAVED_WORKFLOW_SENTINEL}\n${stringifyYaml(body)}${SAVED_WORKFLOW_TERMINATOR}\n${script}`;
}

/**
 * File body → metadata + script.
 *
 * Each of the four failures has its own name because they need different user guidance: missing frontmatter means “this is not a
 * saved workflow,” an unclosed block means “a line was deleted,” invalid YAML means “indentation is wrong,” and schema failure means
 * “a field name is wrong.” A generic “parse error” would help with none of these.
 */
export function parseSavedWorkflow(source: string): SavedWorkflowParseResult {
  const lines = source.split("\n");

  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  if (start >= lines.length || lines[start]!.trim() !== SAVED_WORKFLOW_SENTINEL) {
    return {
      ok: false,
      reason: "missing_frontmatter",
      detail: `file does not start with the \`${SAVED_WORKFLOW_SENTINEL}\` metadata block`,
    };
  }

  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() !== SAVED_WORKFLOW_TERMINATOR) end += 1;
  if (end >= lines.length) {
    return {
      ok: false,
      reason: "unterminated_frontmatter",
      detail: `metadata block is never closed with \`${SAVED_WORKFLOW_TERMINATOR}\``,
    };
  }

  const bodyText = lines.slice(start + 1, end).join("\n");
  // Everything after the closing line is script, preserved as-is (also works when the file has no trailing newline; slice returns an empty array).
  const script = lines.slice(end + 1).join("\n");

  let body: unknown;
  try {
    body = parseYaml(bodyText);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_yaml",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = SavedWorkflowMetaSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_metadata",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }

  // The body starts on the line after the closing line, so exactly `end + 1` lines precede it.
  return { ok: true, meta: parsed.data, script, bodyLineOffset: end + 1 };
}
