export type SkillScope = "workspace" | "user" | "plugin";

export interface SkillMetadata {
  slug?: string;
  version?: string;
  ownerId?: string;
  publishedAt?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  /**
   * Original SKILL.md path found during discovery (without realpath resolution).
   * For symlink-imported skills, `path` is the realpath target file, while `sourcePath` points to the symlink under `~/.zcode/skills/<name>`;
   * use it during deletion to remove only the symlink and leave the target intact. For ordinary skills, it matches `path`.
   */
  sourcePath?: string;
  scope: SkillScope;
  enabled: boolean;
  /** Source plugin name when the scope is plugin; empty for other scopes. */
  pluginName?: string;
  /** Full source plugin ID (name@marketplace) for plugin scope; may be omitted in legacy payloads. */
  pluginId?: string;
  metadata?: SkillMetadata;
}

export interface SkillsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export type SkillDiagnosticSeverity = "warning" | "error";

/** Kept in sync with zcode-cli `SkillDiagnosticCode`; update apps/zcode-cli/packages/contracts/src/skills/index.ts when it changes. */
export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillsListResult {
  skills: SkillSummary[];
  capability: SkillsCapability;
  diagnostics: SkillDiagnostic[];
}

export interface SkillsPromptContext {
  prompt: string;
  activatedSkillNames: string[];
}
