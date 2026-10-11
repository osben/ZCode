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
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";

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
  | "system_context" // git snapshot context
  | "skills" // Available skills
  | "tools" // Tool definitions
  | "request_user_context" // Combined provider-visible request-level user context
  | "memory" // Long-term memory read path
  | "current_date" // Current date
  | "custom_system_prompt" // Custom stable system body
  | "workflow_actor_identity" // Dynamic workflow subagent identity: contract plus persona
  | "subagent_agent_prompt" // Subagent-specific identity/task prompt
  | "subagent_notes" // General operating notes for subagents
  | "subagent_environment" // Subagent environment and model context
  | "dynamic_behavior" // Dynamic behavior boundaries
  | "session_guidance" // Guidance for currently available built-in capabilities
  | "output_style" // Output style
  | "context_management" // Long-context management guidance
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
}

export type ContextMetaUserAttachmentSource = "skills_listing" | "context_prefix";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
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
  envInfo: EnvInfo;
  /** Execution object for the current step; excluded from Context Source and persisted environment snapshots. */
  model?: Model;
  presentationSurface?: PresentationSurface;
  genUiOutputDirectory?: string;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
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
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
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
