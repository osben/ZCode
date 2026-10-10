import { join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./bundled-skills.js";

/**
 * Filter companion skills in the App assembly layer according to the dynamic-workflow switch.
 * Tool-surface filtering is in core's registerBuiltInTools; `/` catalog and `/workflow` expansion
 * filtering are in zcode-protocol/slash-commands.ts and builtin-prompt-command.ts. Keep here only
 * skill filtering that requires path resolution in bootstrap.
 */

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * Absolute SKILL.md paths to exclude from skill discovery when dynamic workflows are disabled.
 *
 * Filter by path rather than root because NodeSkillAdapter exposes only one exclusion mechanism,
 * `disabledPaths` (also used for `skill.<path>.enable=false` in config.json). The input is the
 * bundled-skill package root (bundled-skills.ts); a nonexistent path is simply a Set member that
 * never matches and has no side effects. If unrelated skills are added to that package later, they
 * will not be affected by the dynamic-workflow switch.
 */
export function collectDynamicWorkflowDisabledSkillPaths(
  bundledSkillRoots: readonly SkillRoot[],
): string[] {
  return bundledSkillRoots.map((root) =>
    join(root.path, DYNAMIC_WORKFLOW_SKILL_NAME, SKILL_MANIFEST_FILE_NAME),
  );
}
