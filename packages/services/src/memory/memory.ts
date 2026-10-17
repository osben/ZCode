import type { Memory, MemoryConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export const PROJECT_MEMORY_ITEM_TYPES = ["user", "feedback", "project", "reference"] as const;
export type ProjectMemoryItemType = (typeof PROJECT_MEMORY_ITEM_TYPES)[number];

export interface ProjectMemoryFileSummary {
  name: string;
  /** Actual path validated by MemoryService and constrained to the local Project Memory root. */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
  /** Optional frontmatter description; absent when the file has no parsable frontmatter. */
  description?: string;
  /** Optional frontmatter metadata.type; absent when missing or not a known Memory type. */
  type?: ProjectMemoryItemType;
  /**
   * Post-frontmatter line count of the index file, compared against the CLI injection limit
   * (MEMORY_INDEX_LINE_LIMIT in apps/zcode-cli index-content.ts) by the viewer budget chip.
   * Absent for fact files.
   */
  lineCount?: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
  /**
   * mtime of `<memoryRoot>/.consolidate-lock` — the last successful Dream consolidation time
   * (see DREAM_LOCK_FILE in apps/zcode-cli/packages/core/src/memory/dream.ts). Absent when the
   * workspace has never run a Dream. Display-only metadata; lock ownership stays with the runtime.
   */
  lastDreamConsolidatedAt?: number;
}

export interface IMemoryService {
  /**
   * Load the memory file of the specified agent
   * @param workspacePath workspace path
   * @param agentId agent ID (e.g. 'claude', 'gemini')
   */
  loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }>;

  /**
   * Save the memory configuration
   */
  saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void>;

  /**
   * Clear the memory content
   */
  clearMemory(params: { workspacePath: string; agentId: string }): Promise<void>;

  /**
   * Get the user-level memory directory path and ensure the directory exists
   */
  getUserMemoryDirectory(): Promise<{ path: string }>;

  /** List Project Memory files viewable in the current local profile. */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** Read a Project Memory Markdown file without modification. */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;

  /** Resolve the local Project Memory directory of a workspace; the path is validated and contained in the local profile. */
  getProjectMemoryDirectory(params: { workspaceId: string }): Promise<{ path: string }>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
