// ============================================================
// LSP Tool - code intelligence via language servers
// ============================================================
// Spec: apps/zcode-cli/docs/design/v2/tool/19-lsp.md §7

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LSP_TOOL_NAME = "LSP";
export const LSP_MAX_RESULTS = 200;
export const LSP_PREVIEW_MAX_CHARS = 200;

export const LSP_OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "diagnostics",
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

export const LSP_POSITIONAL_OPERATIONS: ReadonlySet<LspOperation> = new Set([
  "goToDefinition",
  "findReferences",
  "hover",
  "goToImplementation",
]);

export const LspInputSchema = z.object({
  operation: z
    .enum(LSP_OPERATIONS)
    .describe(
      "goToDefinition/findReferences/hover/goToImplementation need line plus symbol (preferred) or character; documentSymbol and diagnostics need only filePath; workspaceSymbol needs query.",
    ),
  filePath: z
    .string()
    .describe(
      "File to query, absolute or relative to the working directory. For workspaceSymbol, any file of the target language (selects the server).",
    ),
  line: z.number().optional().describe("1-based line number, as shown by Read."),
  character: z
    .number()
    .optional()
    .describe("1-based column on the line. Prefer symbol instead; give exactly one of them."),
  symbol: z
    .string()
    .optional()
    .describe("Identifier on the given line; its first whole-word occurrence is used."),
  query: z.string().optional().describe("Symbol name to search for (workspaceSymbol)."),
  includeDeclaration: z
    .boolean()
    .optional()
    .describe("findReferences: also return the declaration. Defaults to false."),
});

export type LspInput = z.infer<typeof LspInputSchema>;
export const LspInputJsonSchema = toToolJsonSchema(LspInputSchema);

const locationSchema = z.object({
  path: z.string(),
  line: z.number(),
  character: z.number(),
  endLine: z.number(),
  endCharacter: z.number(),
  preview: z.string(),
});

const symbolSchema = z.object({
  name: z.string(),
  kind: z.string(),
  path: z.string(),
  line: z.number(),
  containerName: z.string().optional(),
});

const diagnosticSchema = z.object({
  path: z.string(),
  line: z.number(),
  character: z.number(),
  severity: z.enum(["error", "warning", "info", "hint"]),
  message: z.string(),
  code: z.string().optional(),
  source: z.string().optional(),
});

export const LspOutputSchema = z.object({
  operation: z.enum(LSP_OPERATIONS),
  server: z.string(),
  status: z.enum(["ok", "pending"]),
  locations: z.array(locationSchema).optional(),
  symbols: z.array(symbolSchema).optional(),
  hover: z.object({ contents: z.string() }).optional(),
  diagnostics: z.array(diagnosticSchema).optional(),
  truncated: z.boolean(),
  total: z.number().optional(),
});

export type LspOutput = z.infer<typeof LspOutputSchema>;
export const LspOutputJsonSchema = toToolJsonSchema(LspOutputSchema);
