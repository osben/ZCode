// ============================================================
// Skill Contracts - reusable local instruction packs
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type SkillScope = "project" | "user" | "system" | "admin";

export type SkillSource = "agents" | "zcode" | "bundled" | "plugin" | "remote";

export type SkillDiagnosticSeverity = "warning" | "error";

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

export interface SkillRoot {
  /** 附加目录能力的目录限定名；不是项目身份。 */
  namespace?: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  priority: number;
  /** Full id of the owning plugin; available only at the plugin root. */
  pluginId?: string;
}

export interface SkillPolicy {
  allowImplicitInvocation?: boolean;
}

export interface SkillMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  pluginName?: string;
  /** Full id of the owning plugin; omitted for skills that are not from a plugin. */
  pluginId?: string;
  qualifiedName?: string;
  path: string;
  /**
   * Physical identity of `path` (resolved real path, lower-cased on Windows), set by the adapter
   * at discovery. Symlinked copies of one SKILL.md share it. Consumers fall back to `path`.
   */
  identity?: string;
  directory: string;
  rootPath: string;
  scope: SkillScope;
  source: SkillSource;
  safeToAutoLoad: boolean;
  frontmatterKeys: string[];
  policy?: SkillPolicy;
}

/** Minimal metadata allowed to cross boundaries in a Skill tool result; excludes the body and description. */
export interface SkillTelemetryMetadata {
  /** 实际解析的技能原始名称；不限插件来源。 */
  name?: string;
  qualifiedName?: string;
  pluginId?: string;
  source?: SkillSource;
}

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillLoadOutcome {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
  totalDiscovered: number;
}

export interface SkillContent {
  metadata: SkillMetadata;
  content: string;
  baseDirectory: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillDiscoverRequest {
  workingDirectory: string;
  roots?: SkillRoot[];
  trace?: TraceContext;
}

export interface SkillLoadRequest {
  name: string;
  /**
   * Exact SKILL.md to load; when set, the skill is selected by physical identity and `name` is
   * used only for errors.
   */
  path?: string;
  workingDirectory: string;
  roots?: SkillRoot[];
  maxBytes?: number;
  trace?: TraceContext;
}

export interface SkillOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface SkillPort {
  discoverSkills(
    request: SkillDiscoverRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome>;
  loadSkill(request: SkillLoadRequest, options?: SkillOperationOptions): Promise<SkillContent>;
}

export interface SkillConfig {
  enabled: boolean;
  includeInstructions: boolean;
  metadataBudget: number;
  roots: string[];
}
