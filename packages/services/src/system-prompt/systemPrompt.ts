import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** One editable system-prompt section (docs/system-prompt-overrides.md). */
export interface SystemPromptSection {
  key: string;
  /** Code constant; the effective text when no override file exists. */
  defaultContent: string;
  /** Override file body, or null when the default is effective. */
  overrideContent: string | null;
  /** Override file path on this host (shown in the UI whether or not it exists yet). */
  filePath: string;
  isOverridden: boolean;
}

export interface ISystemPromptService {
  /** List the editable sections with their effective state. */
  listSections(): Promise<{ sections: SystemPromptSection[] }>;

  /** Write (create or replace) the override file for a whitelisted key. */
  writeOverride(params: { key: string; content: string }): Promise<void>;

  /** Delete the override file for a key, restoring the code default. */
  deleteOverride(params: { key: string }): Promise<void>;

  /** Override directory path; a pure lookup that never creates the directory. */
  getOverridesDirectory(): Promise<{ path: string }>;
}

export const ISystemPromptService = createServiceDescriptor<ISystemPromptService>(
  ServiceChannels.SystemPrompt,
);
