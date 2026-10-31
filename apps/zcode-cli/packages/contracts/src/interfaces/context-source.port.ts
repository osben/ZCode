// ============================================================
// Context Source Port - host/workspace context boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export interface EnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  nodeVersion: string;
  // The model used for execution is not an environment fact; only the current model step's
  // Model may provide it while rendering the prompt.
  isGitRepository?: boolean;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatus?: "clean" | "dirty" | "not_repo";
  gitStatusLines?: string[];
  recentCommits?: string[];
}

/**
 * Git facts for session context; excludes host environment such as cwd and shell.
 * isGitRepository is derived by walking up from the directory's real path (resolving links, matching git)
 * looking for `.git`; it is always a definitive answer and never spawns a git process.
 */
export type GitContext = Pick<
  EnvInfo,
  | "isGitRepository"
  | "gitBranch"
  | "gitMainBranch"
  | "gitUser"
  | "gitStatus"
  | "gitStatusLines"
  | "recentCommits"
>;

export interface UserInstructionsOptions {
  workingDirectory: string;
  projectRoot?: string;
  priorityFiles?: string[];
  maxBytes?: number;
}

export type UserInstructionSourceScope = "user" | "workspace";

export interface ResolvedUserInstructionSource {
  scope: UserInstructionSourceScope;
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface ResolvedUserInstructions {
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  sources?: ResolvedUserInstructionSource[];
}

export type ProjectType = "node" | "python" | "rust" | "go" | "java" | "unknown";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export interface ProjectContext {
  type: ProjectType;
  packageManager?: PackageManager;
  scripts?: Record<string, string>;
  buildFiles?: string[];
}

export interface ContextSourceRequest {
  workingDirectory: string;
  currentDate?: string;
  effectiveShellDisplayName?: string;
  envInfo?: EnvInfo;
  userInstructions?: UserInstructionsOptions;
  projectContext?: ProjectContext;
  trace?: TraceContext;
}

export interface ContextSourceDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface ContextSourceSnapshot {
  workingDirectory: string;
  envInfo: EnvInfo;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  diagnostics: ContextSourceDiagnostic[];
}

export interface ContextSourceResolveOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface ContextSourcePort {
  // Reads only the current host environment; does not reload instructions, Skills, or session-start Git details.
  resolveEnvironment(
    request: Pick<ContextSourceRequest, "workingDirectory" | "effectiveShellDisplayName" | "trace">,
    options?: ContextSourceResolveOptions,
  ): Promise<EnvInfo>;
  // Reads only the current directory's Git session context. Decided once per context window: called when
  // the pre-request history has neither session_context nor date, or when compaction's kept tail lacks session_context.
  resolveGitContext(
    request: Pick<ContextSourceRequest, "workingDirectory" | "trace">,
    options?: ContextSourceResolveOptions,
  ): Promise<GitContext>;
  resolveContextSources(
    request: ContextSourceRequest,
    options?: ContextSourceResolveOptions,
  ): Promise<ContextSourceSnapshot>;
}
