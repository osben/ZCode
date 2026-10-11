// Read-only Skill catalog for Composer.
// Separate from the Skills Settings management API: sessionId determines authority here; this API
// does not start, stop, or delete skills.
import {
  zcodeSkillsReferenceCatalogParamsSchema,
  type ZCodeSkillReferenceCatalogEntry,
  type ZCodeSkillsReferenceCatalogResult,
} from "@zcode/shared";
import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import { listZCodeSkills } from "../skills.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export async function getSkillReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSkillsReferenceCatalogResult> {
  const params = parseParams(zcodeSkillsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const outcome = await record.app.getSkillCatalog();
    return toResult("session", outcome);
  }

  // The old UI cache scanned only when the workspace first mounted, so a new conversation still saw
  // a stale snapshot after a user added a Skill through the filesystem. Draft requests reuse the
  // CLI's normal discovery configuration on the Agent side; read the current workspace catalog each
  // time the reference panel opens.
  const outcome = await listZCodeSkills({
    env: context.deps.env,
    includeVisualize: true,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return toResult("workspace", outcome);
}

function toResult(
  authority: ZCodeSkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
): ZCodeSkillsReferenceCatalogResult {
  return {
    authority,
    // Bundled skills (bundled-skills.ts) do not appear in the reference panel: they are loaded by
    // the built-in `/workflow` command and are not user-managed or referenced objects. The protocol
    // scope is a closed enum validated strictly by older clients, so do not extend it for bundled skills.
    skills: outcome.skills
      .filter((skill) => skill.source !== "bundled")
      .map(toReferenceCatalogEntry),
  };
}

function toReferenceCatalogEntry(skill: SkillMetadata): ZCodeSkillReferenceCatalogEntry {
  const scope =
    skill.source === "plugin" ? "plugin" : skill.scope === "project" ? "workspace" : "user";
  return {
    // `glm:` is the existing UI provider filter contract; the path provides stable row identity for
    // same-named skills from different sources.
    id: `glm:${scope}:${skill.path}`,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope,
    enabled: true,
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  };
}
