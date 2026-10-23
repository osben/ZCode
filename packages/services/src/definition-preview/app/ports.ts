import type { AgentSummary, SkillSummary, ZCodeCommand } from "@zcode/shared";
import type {
  DefinitionPreviewReadResult,
  DefinitionPreviewTreeEntry,
} from "@zcode/shared/definition-preview";

export interface DefinitionCatalogTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** Read-only view of the discovery catalogs; wired from existing services by the composition root. */
export interface DefinitionCatalogPort {
  listSkills(target: DefinitionCatalogTarget): Promise<readonly SkillSummary[]>;
  listAgents(target: DefinitionCatalogTarget): Promise<readonly AgentSummary[]>;
  listCommands(target: DefinitionCatalogTarget): Promise<readonly ZCodeCommand[]>;
}

export interface DefinitionTreeListing {
  tree: DefinitionPreviewTreeEntry[];
  truncated: boolean;
}

/** Confined filesystem access. Every call takes a Host-derived root, never a client path. */
export interface DefinitionFilesPort {
  /** Lists a directory root without following symlinks; null when the root is not a directory. */
  listTree(rootPath: string): Promise<DefinitionTreeListing | null>;
  /** Reads one file below `rootPath`, rejecting symlinks on every segment. */
  readFile(rootPath: string, segments: readonly string[]): Promise<DefinitionPreviewReadResult>;
  /** Reads a single-file root; the root itself must be a regular, non-symlink file. */
  readSingleFile(filePath: string): Promise<DefinitionPreviewReadResult>;
  /** True when the single-file root exists as a regular non-symlink file. */
  isRegularFile(filePath: string): Promise<boolean>;
}
