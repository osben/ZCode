import { z } from "zod";

/** Matches Code Viewer's FILE_VIEWER_MAX_TEXT_BYTES so previews and the viewer agree on "too large". */
export const DEFINITION_PREVIEW_MAX_TEXT_BYTES = 256 * 1024;
/** Upper bound on tree entries returned for one definition root; larger roots report truncated. */
export const DEFINITION_PREVIEW_MAX_TREE_ENTRIES = 2_000;

export const DEFINITION_PREVIEW_KINDS = ["skill", "command", "subagent", "plugin"] as const;
export type DefinitionPreviewKind = (typeof DEFINITION_PREVIEW_KINDS)[number];

const boundedPath = z.string().min(1).max(4096);

/**
 * Wire-format reference to a definition. It identifies what to look up; it never grants file
 * access. The executing Host derives every root from its own discovery results.
 */
export const definitionPreviewRefSchema = z
  .object({
    kind: z.enum(DEFINITION_PREVIEW_KINDS),
    name: z.string().trim().min(1).max(256),
    pluginId: z.string().min(1).max(256).optional(),
    /** Path carried by the mention. Only selects among discovered candidates. */
    hintPath: boundedPath.optional(),
    workspacePath: boundedPath,
    workspaceIdentity: z.string().max(4096).optional(),
    remoteSessionId: z.string().max(256).optional(),
  })
  .strict();
export type DefinitionPreviewRef = z.infer<typeof definitionPreviewRefSchema>;

export const definitionPreviewReadParamsSchema = z
  .object({
    ref: definitionPreviewRefSchema,
    /** Path relative to the definition root; validated and confined by the Host. */
    relativePath: boundedPath,
  })
  .strict();
export type DefinitionPreviewReadParams = z.infer<typeof definitionPreviewReadParamsSchema>;

export type DefinitionPreviewScope = "workspace" | "user" | "plugin";

export interface DefinitionPreviewCandidate {
  kind: DefinitionPreviewKind;
  name: string;
  scope: DefinitionPreviewScope;
  enabled: boolean;
  /** Absolute path of the entry file (SKILL.md or the single definition file). */
  entryPath: string;
  pluginName?: string;
}

export interface DefinitionPreviewDefinition extends DefinitionPreviewCandidate {
  description?: string;
  /** Absolute path of the root shown in the header: the skill folder or the single file. */
  rootPath: string;
  /** Entry file relative to the root, selected by default. */
  entryRelativePath: string;
  /** True for subagents and commands: the root is one file and the tree is hidden. */
  singleFile: boolean;
  /** User- or workspace-owned and writable; the UI still hides editor actions for remote hosts. */
  userOwned: boolean;
}

export type DefinitionPreviewTreeEntryKind = "file" | "directory" | "link";

export interface DefinitionPreviewTreeEntry {
  /** POSIX-style path relative to the root. */
  relativePath: string;
  kind: DefinitionPreviewTreeEntryKind;
  size?: number;
}

export type DefinitionPreviewResolveResult =
  | { status: "not_found" }
  | {
      status: "found";
      definition: DefinitionPreviewDefinition;
      tree: DefinitionPreviewTreeEntry[];
      truncated: boolean;
      shadowed: DefinitionPreviewCandidate[];
      /** Set when the mention carried a path that no longer matches any candidate. */
      movedFrom?: string;
    };

export type DefinitionPreviewReadResult =
  | { status: "text"; relativePath: string; content: string; size: number }
  | { status: "binary"; relativePath: string; size: number }
  | { status: "too_large"; relativePath: string; size: number; limit: number }
  | { status: "not_found" }
  | { status: "rejected" };
