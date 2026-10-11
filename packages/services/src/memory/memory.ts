import type { Memory, MemoryConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export interface ProjectMemoryFileSummary {
  name: string;
  /** Actual path validated by MemoryService and constrained to the local Project Memory root. */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
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
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
