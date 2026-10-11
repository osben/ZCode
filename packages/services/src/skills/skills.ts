import type { ZCodeProvider, SkillsPromptContext, SkillsListResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<SkillsListResult>;
  setEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    scope?: "workspace" | "user" | "plugin";
    skillId: string;
    enabled: boolean;
  }): Promise<void>;
  buildPromptContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    prompt: string;
  }): Promise<SkillsPromptContext>;
  /** Copy the specified skill to the shared directory (.zcode/skills) and return its new path on success. */
  copyToCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<{ newPath: string }>;
  /** Remove the specified skill from the shared directory (only when it is under .zcode/skills). */
  removeFromCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /**
   * Delete a local skill (workspace/user scope only; plugin scope is rejected).
   * Deletes the skill's directory; only paths under .zcode/skills or .agents/skills are allowed, and paths outside these roots are rejected.
   */
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
}

export const ISkillsService = createServiceDescriptor<ISkillsService>(ServiceChannels.Skills);
