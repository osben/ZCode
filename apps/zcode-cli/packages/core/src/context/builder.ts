// ============================================================
// Context Builder - System prompt assembly
// ============================================================

import type { ModelInputMessage } from "@zcode/contracts";
import { incognitoExcludes } from "@zcode/shared";
import type {
  ContextMetaUserAttachment,
  ContextSection,
  ContextBuildResult,
  ContextBuilderConfig,
  EnvInfo,
} from "./types.js";
import type { ToolRegistry } from "../tool/registry.js";
import { estimateTokens } from "./utils.js";
import { buildCliPrefixSection } from "./sections/cli-prefix.js";
import { buildIdentitySection } from "./sections/identity.js";
import { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
import {
  buildEnvInfoSection,
  buildGitSystemContextSection,
  buildWorktreeOnlyEnvSection,
} from "./sections/env-info.js";
import { buildSkillsSection } from "./sections/skills.js";
import { buildRequestUserContextSection } from "./sections/request-user-context.js";
import { buildCurrentDateSection } from "./sections/current-date.js";
import { buildMemorySection } from "./sections/memory.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../memory/project-memory-retrieval-branch.js";
import { buildDesktopContextSection } from "./sections/desktop.js";
import {
  buildContextManagementSection,
  buildDynamicBehaviorSection,
  buildOutputStyleSection,
  buildSessionGuidanceSection,
} from "./dynamic-sections.js";

// -----------------------------------------------
// Context Builder
// -----------------------------------------------

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };
/** Registered name of the Skill tool (same literal as metadata.name in tool/handlers/skill.ts; contracts has no constant). */
const SKILL_TOOL_NAME = "Skill";

export class ContextBuilder {
  private config: ContextBuilderConfig;
  private customSections: ContextSection[] = [];

  constructor(config: ContextBuilderConfig) {
    this.config = config;
  }

  /**
   * Retained for compatibility. Tool descriptions are carried by the model request's tools field and are no longer mirrored into the system prompt.
   */
  setToolRegistry(_registry: ToolRegistry): this {
    return this;
  }

  setEnvInfo(envInfo: EnvInfo): this {
    this.config = {
      ...this.config,
      envInfo,
    };
    return this;
  }

  /**
   * Add a custom section (for later extension).
   */
  addSection(
    section: Omit<ContextSection, "chars" | "tokens" | "injectionTarget" | "cacheHint"> &
      Partial<Pick<ContextSection, "injectionTarget" | "cacheHint">>,
  ): this {
    this.customSections.push({
      ...section,
      injectionTarget: section.injectionTarget ?? "system",
      cacheHint: section.cacheHint ?? "dynamic",
      chars: section.content.length,
      tokens: estimateTokens(section.content),
    });
    return this;
  }

  /**
   * Build context and return a structured result.
   */
  build(): ContextBuildResult {
    const sections: ContextSection[] = [];
    const activeOutputStyle = this.config.outputStyle?.prompt.trim()
      ? this.config.outputStyle
      : undefined;
    const customSystemPrompt = this.config.customSystemPrompt?.trim();
    const hasCustomSystemPrompt = Boolean(customSystemPrompt);
    // Workflow subagent identity: the third path. Mutually exclusive with
    // customSystemPrompt—if both are present, wiring is wrong (the persona should arrive through workflowActor,
    // not systemPrompt). Fail loudly instead of silently choosing one.
    const workflowActor = this.config.workflowActor;
    if (workflowActor !== undefined && hasCustomSystemPrompt) {
      throw new Error(
        "ContextBuilder: workflowActor and customSystemPrompt are mutually exclusive",
      );
    }
    const isWorkflowActor = workflowActor !== undefined;
    const promptOverrides = isWorkflowActor ? undefined : this.config.systemPromptOverrides;
    // Incognito toggles for prompt text (specs/incognito-session.md, "Prompt toggles (v2)"). Absent profile = all included.
    const incognito = this.config.incognito;
    const identityOff = incognitoExcludes(incognito, "identity");
    const harnessOff = incognitoExcludes(incognito, "harness");
    const environmentOff = incognitoExcludes(incognito, "environment");

    // 1. CLI / product prefix. Keep this as the short leading identity block.
    // "You are ZCode, an interactive coding agent" is the wrong identity for a subagent that speaks only to a script
    // and may not even have file-reading tools, and it would appear before the correct identity section.
    if (!isWorkflowActor && !identityOff) {
      sections.push(buildCliPrefixSection(promptOverrides?.["cli-prefix"]));
    }

    // 2. Stable agent behavior or custom prompt body
    if (hasCustomSystemPrompt) {
      sections.push(
        createSection({
          name: "Custom System Prompt",
          source: "custom_system_prompt",
          injectionTarget: "system",
          cacheHint: "stable",
          content: customSystemPrompt ? `\n${customSystemPrompt}` : "",
        }),
      );
    } else if (workflowActor !== undefined) {
      sections.push(buildWorkflowActorIdentitySection(workflowActor, { includeHarness: !harnessOff }));
    } else {
      sections.push(
        buildIdentitySection(
          activeOutputStyle,
          {
            "identity-intro": promptOverrides?.["identity-intro"],
            harness: promptOverrides?.harness,
          },
          { includeIntro: !identityOff, includeHarness: !harnessOff },
        ),
      );
    }

    // 3. Dynamic system context
    // A custom prompt does not replace only the stable body; it skips the default system prompt structure and systemContext.
    // Otherwise, dynamic system sections such as Session Guidance/output style would still be included after the user provides a custom prompt.
    // Workflow subagents skip the three sections aimed at "talking with the user" (desktop, Dynamic Behavior, and session
    // guidance—the contract already carries Report outcomes faithfully), while retaining memory and subsequent sections.
    if (!hasCustomSystemPrompt) {
      if (!isWorkflowActor && !harnessOff && this.config.presentationSurface === "zcode_desktop") {
        sections.push(buildDesktopContextSection(this.config.genUiOutputDirectory));
      }

      // behaviour part right after stable sp...
      if (!isWorkflowActor && !harnessOff) {
        sections.push(buildDynamicBehaviorSection(promptOverrides?.communication));
      }

      // Session-specific guidance
      const sessionGuidanceSection =
        isWorkflowActor || harnessOff
          ? null
        : buildSessionGuidanceSection(
            this.config.guidanceToolNames ?? [],
            (this.config.skills?.skills.length ?? 0) > 0,
          );
      if (sessionGuidanceSection) {
        sections.push(sessionGuidanceSection);
      }

      // Memory
      if (this.config.memoryRoot) {
        const memorySection = buildMemorySection(
          this.config.memoryRoot,
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
          promptOverrides?.["memory-guidance"],
        );
        if (memorySection) {
          sections.push(memorySection);
        }
      }
      if (environmentOff) {
        // The worktree bullet is isolation context, not environment text (specs/incognito-session.md).
        const worktreeSection = buildWorktreeOnlyEnvSection(this.config.executionWorktree);
        if (worktreeSection) sections.push(worktreeSection);
      } else {
        sections.push(
          buildEnvInfoSection(this.config.envInfo, this.config.model, this.config.executionWorktree),
        );
      }

      // Output Style
      const outputStyleSection = buildOutputStyleSection(activeOutputStyle);
      if (outputStyleSection) {
        sections.push(outputStyleSection);
      }

      // Context Management
      sections.push(buildContextManagementSection(promptOverrides?.["context-management"]));

      const gitSystemContextSection = environmentOff
        ? null
        : buildGitSystemContextSection(this.config.envInfo);
      if (gitSystemContextSection) {
        sections.push(gitSystemContextSection);
      }
    }

    // 4. Skills appear as a meta user system-reminder, matching provider block layout.
    // guidanceToolNames is the runtime's current tool list. Telling a workflow subagent without a registered Skill tool that
    // "the following skills can be used through the Skill tool" would make it believe it has a tool it does not have.
    // Preserve existing behavior when the list is absent (tests / older callers).
    if (this.config.skills && this.skillToolAvailable()) {
      const skillsSection = buildSkillsSection({
        outcome: this.config.skills,
        metadataBudget: this.config.skillMetadataBudget,
      });
      if (skillsSection) {
        sections.push(skillsSection);
      }
    }

    // 5. Meta user context: workspace instructions/project memory first, date second.
    const requestUserContextSection = buildRequestUserContextSection({
      userInstructions: this.config.userInstructions,
      memoryIndexContent: this.config.memoryIndexContent,
      memoryRoot: this.config.memoryRoot,
      memoryIndexAsContext: this.config.memoryIndexAsContext,
    });
    if (requestUserContextSection) {
      sections.push(requestUserContextSection);
    }

    const currentDateSection = buildCurrentDateSection(this.config.currentDate);
    if (currentDateSection) {
      sections.push(currentDateSection);
    }

    // 6. Custom sections
    sections.push(...this.customSections);

    const orderedSections = orderSectionsForInjection(sections);

    // Calculate totals.
    const totalChars = orderedSections.reduce((sum, s) => sum + s.chars, 0);
    const totalTokens = orderedSections.reduce((sum, s) => sum + s.tokens, 0);

    const systemMessages = this.assembleSystemMessages(orderedSections);
    const metaUserAttachments = this.assembleMetaUserAttachments(orderedSections);

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments,
    };
  }

  private skillToolAvailable(): boolean {
    const names = this.config.guidanceToolNames;
    return names === undefined || names.includes(SKILL_TOOL_NAME);
  }

  private assembleSystemMessages(sections: ContextSection[]): ModelInputMessage[] {
    const messages: ModelInputMessage[] = [];

    const cliPrefixContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.source === "cli_prefix",
      ),
    );
    if (cliPrefixContent) {
      messages.push({
        role: "system",
        content: cliPrefixContent,
      });
    }

    const stableBodyContent = buildSectionContent(
      sections.filter(
        (section) =>
          section.injectionTarget === "system" &&
          section.cacheHint === "stable" &&
          section.source !== "cli_prefix",
      ),
    );
    if (stableBodyContent) {
      messages.push({
        role: "system",
        content: stableBodyContent,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    const dynamicSystemContent = buildSectionContent(
      sections.filter(
        (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
      ),
    );
    if (dynamicSystemContent) {
      messages.push({
        role: "system",
        // ZCode by design: the Main Agent's dynamic system block includes its own left boundary, consistently across providers.
        content: `\n\n${dynamicSystemContent}`,
        cacheControl: EPHEMERAL_CACHE_CONTROL,
      });
    }

    return messages;
  }

  private assembleMetaUserAttachments(sections: ContextSection[]): ContextMetaUserAttachment[] {
    const attachments: ContextMetaUserAttachment[] = [];

    const skillsContent = buildSkillsMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source === "skills",
      ),
    );
    if (skillsContent) {
      attachments.push({
        source: "skills_listing",
        content: skillsContent,
      });
    }

    const contextContent = buildContextMetaUserBody(
      sections.filter(
        (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
      ),
    );
    if (contextContent) {
      attachments.push({
        source: "context_prefix",
        content: contextContent,
      });
    }

    return attachments;
  }
}

function orderSectionsForInjection(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "dynamic",
    ),
  ];
}

export function buildContextMetaUserBody(sections: ContextSection[]): string | null {
  if (sections.length === 0) return null;

  return [
    "As you answer the user's questions, you can use the following context:",
    buildSectionContent(sections),
    "",
    "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
  ].join("\n");
}

export function buildSkillsMetaUserBody(sections: ContextSection[]): string | null {
  const content = buildSectionContent(sections);
  if (!content) {
    return null;
  }

  return content;
}

function buildSectionContent(sections: ContextSection[]): string {
  return sections.map((section) => section.content).join("\n\n");
}

function createSection(input: {
  name: string;
  source: ContextSection["source"];
  injectionTarget: ContextSection["injectionTarget"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

// -----------------------------------------------
// Factory
// -----------------------------------------------

export function createContextBuilder(config: ContextBuilderConfig): ContextBuilder {
  return new ContextBuilder(config);
}
