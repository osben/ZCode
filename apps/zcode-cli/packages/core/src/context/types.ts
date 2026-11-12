// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@zcode/contracts";
import type { IncognitoProfile, SystemPromptOverrides } from "@zcode/shared";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { ExecutionWorktreeEnvFact } from "./sections/env-info.js";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

export type ContextSource =
  | "cli_prefix" // CLI/product identity prefix
  | "identity" // Agent base description
  | "env_info" // Environment information (cwd, platform, git repo boolean)
  | "session_context" // git snapshot context
  | "model" // Identity of the currently executing model
  | "execution_worktree" // Execution-worktree isolation notice (dynamic system section)
  | "skills" // Available skills
  | "tools" // Tool definitions
  | "request_user_context" // Combined provider-visible request-level user context
  | "memory" // Long-term memory read path
  | "current_date" // Current date
  | "custom_system_prompt" // Custom stable system body
  | "workflow_actor_identity" // Dynamic workflow subagent identity: contract plus persona
  | "subagent_agent_prompt" // Subagent-specific identity/task prompt
  | "subagent_notes" // General operating notes for subagents
  | "dynamic_behavior" // Dynamic behavior boundaries
  | "session_guidance" // Guidance for currently available built-in capabilities
  | "context_management" // Long-context management guidance
  | "total_tokens" // Fixed token budget line
  | "desktop_context"; // ZCode Desktop rendering and interaction protocol

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "zcode_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

export interface ContextSection {
  name: string; // Human-readable section name
  source: ContextSource; // Source identifier
  injectionTarget: ContextInjectionTarget; // Injection location
  cacheHint: ContextCacheHint; // Cache-stability hint
  chars: number; // Character count
  tokens: number; // Estimated token count
  content: string; // Full content
  preview: string; // Preview of the first 100 characters
  /** Per-file blocks of request_user_context; the instruction-change announcement compares by them. */
  instructionFiles?: InstructionFile[];
}

/** One file block of an instruction announcement: `Contents of <path> (<type>):`, a blank line, then the body (trimmed). */
export interface InstructionFile {
  path: string;
  type: string;
  body: string;
  /** sha256 of the body, computed once when the file is built (createInstructionFile); comparisons before a request use it directly. */
  hash: string;
}

export type InstructionRefreshReason = "session_start" | "compaction";

/**
 * Files already announced, recorded in runtime metadata (never sent to the provider).
 * No reason means a full announcement; with a reason it is a delta, and files holds only changed or added files.
 */
export interface InstructionAnnouncement {
  files: { path: string; type: string; hash: string }[];
  removed?: string[];
  reason?: InstructionRefreshReason;
}

export type ContextMetaUserAttachmentSource =
  | "skills_listing"
  | "context_prefix"
  | "session_context";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
  /** 只有 context_prefix 有：组成 content 的指令文件。 */
  files?: InstructionFile[];
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder assembles only system messages
  metaUserAttachments: ContextMetaUserAttachment[]; // Meta user bodies not wrapped in <system-reminder>
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

export interface ContextBuilderConfig {
  workingDirectory: string;
  additionalDirectories?: readonly string[];
  envInfo: EnvInfo;
  /** Execution object for the current step; excluded from Context Source and persisted environment snapshots. */
  model?: Model;
  /**
   * Execution-worktree fact rendered into the Environment section at build time (isolation notice);
   * like `model`, it is a render-time projection and is not persisted into envInfo snapshots.
   */
  executionWorktree?: ExecutionWorktreeEnvFact;
  /** Whether the execution model uses MCS; when false the Harness rewords the `<system-reminder>` channel. Defaults to MCS. */
  midConversationSystem?: boolean;
  presentationSurface?: PresentationSurface;
  genUiOutputDirectory?: string;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  memoryIndexAsContext?: boolean;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  customSystemPrompt?: string;
  /**
   * Identity input for a dynamic workflow subagent (workflow child). When present, use the builder's third path:
   * base sections (CLI prefix, safety lines, Harness, memory) + workflow subagent contract + persona,
   * rather than replacing the whole prompt as `customSystemPrompt` does. Mutually exclusive with `customSystemPrompt`.
   */
  workflowActor?: WorkflowActorContext;
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  /**
   * User overrides for the editable system-prompt sections (docs/system-prompt-overrides.md).
   * Each present key replaces that section's code default; absent keys keep the constant.
   */
  systemPromptOverrides?: SystemPromptOverrides;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
  /** Frozen incognito profile; absent for a normal session. Gates identity, harness and environment text. */
  incognito?: IncognitoProfile;
}

/**
 * Identity input for a workflow subagent: effective name (omitted when anonymous) and author-written persona system prompt (optional).
 * There are no tool tiers: every subagent has the full work toolset, and there is one contract text.
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
