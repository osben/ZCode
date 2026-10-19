import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** One editable system-prompt section (docs/system-prompt-overrides.md, specs/system-prompt-settings.md). */
export interface SystemPromptSection {
  key: string;
  /** Code constant; the effective text when no override file exists. */
  defaultContent: string;
  /** Override file body (trimmed), or null when the default is effective. */
  overrideContent: string | null;
  /** Override file path on this host (shown in the UI whether or not it exists yet). */
  filePath: string;
  isOverridden: boolean;
  /**
   * SHA-256 hex of the override file's raw bytes, or null when the file is missing. Older hosts
   * omit this field; the UI then skips conflict checking for the section.
   */
  revision: string | null;
}

/** Result of a conditional write or delete. A conflict means the file changed since `expectedRevision`. */
export type SystemPromptWriteResult =
  | { kind: "ok"; revision: string | null }
  | { kind: "conflict"; currentRevision: string | null };

export interface ISystemPromptService {
  /** List the editable sections with their effective state. */
  listSections(): Promise<{ sections: SystemPromptSection[] }>;

  /**
   * Write (create or replace) the override file for a whitelisted key. The stored text is trimmed,
   * and an empty result is rejected. `expectedRevision` omitted means no conflict check; `null`
   * means the file must still be missing.
   */
  writeOverride(params: {
    key: string;
    content: string;
    expectedRevision?: string | null;
  }): Promise<SystemPromptWriteResult>;

  /** Delete the override file for a key, restoring the code default. */
  deleteOverride(params: {
    key: string;
    expectedRevision?: string | null;
  }): Promise<SystemPromptWriteResult>;

  /** Override directory path; a pure lookup that never creates the directory. */
  getOverridesDirectory(): Promise<{ path: string }>;
}

export const ISystemPromptService = createServiceDescriptor<ISystemPromptService>(
  ServiceChannels.SystemPrompt,
);
