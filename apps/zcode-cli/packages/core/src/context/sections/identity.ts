// ============================================================
// Identity Section Builder
// ============================================================

import { DEFAULT_HARNESS_PROMPT, DEFAULT_IDENTITY_INTRO_PROMPT } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";

const SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** Security IMPORTANT line shared verbatim by interactive and workflow-subagent identities. */
export function buildSecurityNotice(): string {
  return SECURITY_NOTICE;
}

/**
 * The `# Harness` block contains stable runtime constraints, not coding instructions replaceable by output style.
 * Workflow-subagent identity (`sections/workflow-actor.ts`) also reuses this block verbatim.
 * A `harness` override (docs/system-prompt-overrides.md) replaces the main agent's block;
 * the workflow-subagent identity keeps the default constant.
 */
export function buildHarnessBlock(override?: string): string {
  return override?.trim() ? override.trim() : DEFAULT_HARNESS_PROMPT;
}

function buildIdentityPrompt(
  outputStyle: OutputStylePromptConfig | undefined,
  introOverride: string | undefined,
  harnessOverride: string | undefined,
): string {
  // An explicit identity-intro override wins over the active Output Style intro; the style
  // still appends its own `# Output Style` section.
  const intro = introOverride?.trim()
    ? introOverride.trim()
    : outputStyle
      ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
      : DEFAULT_IDENTITY_INTRO_PROMPT;

  const identityLines = ["", intro, "", SECURITY_NOTICE].join("\n");

  return [identityLines, "", buildHarnessBlock(harnessOverride)].join("\n");
}

export function buildIdentitySection(
  outputStyle?: OutputStylePromptConfig,
  overrides?: { "identity-intro"?: string; harness?: string },
): ContextSection {
  const content = buildIdentityPrompt(
    outputStyle,
    overrides?.["identity-intro"],
    overrides?.harness,
  );

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
