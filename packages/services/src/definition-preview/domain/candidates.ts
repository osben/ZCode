import type { AgentSummary, SkillSummary, ZCodeCommand } from "@zcode/shared";
import { SKILL_FILE_NAME } from "@zcode/shared";
import type {
  DefinitionPreviewCandidate,
  DefinitionPreviewScope,
} from "@zcode/shared/definition-preview";

/** Host-side candidate: the wire candidate plus the paths needed to locate and confine it. */
export interface DefinitionCandidate extends DefinitionPreviewCandidate {
  /** Original discovery path before realpath (symlinked skills); matched against hints. */
  sourcePath?: string;
  /** Root to confine reads to: the skill directory or the single definition file. */
  rootPath: string;
  entryRelativePath: string;
  singleFile: boolean;
  description?: string;
  userOwned: boolean;
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

export function skillCandidates(
  skills: readonly SkillSummary[],
  name: string,
): DefinitionCandidate[] {
  return skills
    .filter((skill) => skill.name === name)
    .map((skill) => ({
      kind: "skill" as const,
      name: skill.name,
      scope: skill.scope,
      enabled: skill.enabled,
      entryPath: skill.path,
      ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
      ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
      rootPath: dirnameOf(skill.path),
      entryRelativePath: SKILL_FILE_NAME,
      singleFile: false,
      ...(skill.description ? { description: skill.description } : {}),
      userOwned: skill.scope !== "plugin",
    }));
}

function agentScope(agent: AgentSummary): DefinitionPreviewScope {
  if (agent.source === "plugin") return "plugin";
  return agent.scope === "workspace" ? "workspace" : "user";
}

export function agentCandidates(
  agents: readonly AgentSummary[],
  name: string,
): DefinitionCandidate[] {
  return (
    agents
      // Built-in agents carry a pseudo-path such as `built-in:Explore`; there is no file to show.
      .filter((agent) => agent.name === name && agent.source !== "built-in")
      .map((agent) => {
        const scope = agentScope(agent);
        return {
          kind: "subagent" as const,
          name: agent.name,
          scope,
          enabled: agent.enabled,
          entryPath: agent.path,
          rootPath: agent.path,
          entryRelativePath: basenameOf(agent.path),
          singleFile: true,
          ...(agent.description ? { description: agent.description } : {}),
          userOwned: scope !== "plugin" && agent.readOnly !== true,
        };
      })
  );
}

export function commandCandidates(
  commands: readonly ZCodeCommand[],
  name: string,
): DefinitionCandidate[] {
  return commands
    .filter((command) => command.name === name)
    .map((command) => {
      const scope: DefinitionPreviewScope =
        command.source === "plugin" ? "plugin" : command.scope === "project" ? "workspace" : "user";
      return {
        kind: "command" as const,
        name: command.name,
        scope,
        enabled: command.enabled,
        entryPath: command.filePath,
        ...(command.source === "plugin" ? { pluginName: command.pluginName } : {}),
        rootPath: command.filePath,
        entryRelativePath: basenameOf(command.filePath),
        singleFile: true,
        ...(command.description ? { description: command.description } : {}),
        userOwned: scope !== "plugin",
      };
    });
}

const SCOPE_RANK: Record<DefinitionPreviewScope, number> = { workspace: 0, user: 1, plugin: 2 };

function normalizeComparablePath(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

function matchesHint(candidate: DefinitionCandidate, hint: string): boolean {
  const normalizedHint = normalizeComparablePath(hint);
  return [candidate.entryPath, candidate.sourcePath, candidate.rootPath].some(
    (path) => path !== undefined && normalizeComparablePath(path) === normalizedHint,
  );
}

export interface CandidateSelection {
  winner: DefinitionCandidate;
  shadowed: DefinitionCandidate[];
  movedFrom?: string;
}

/**
 * Display order only; the runtime has no single winner for colliding names. Order: the
 * candidate matching the mention's path, then enabled, then workspace > user > plugin, then path.
 */
export function selectCandidate(
  candidates: readonly DefinitionCandidate[],
  hintPath?: string,
): CandidateSelection | null {
  if (candidates.length === 0) return null;
  const hintMatches = (candidate: DefinitionCandidate) =>
    hintPath !== undefined && matchesHint(candidate, hintPath);
  const ordered = [...candidates].sort((left, right) => {
    const byHint = Number(hintMatches(right)) - Number(hintMatches(left));
    if (byHint !== 0) return byHint;
    const byEnabled = Number(right.enabled) - Number(left.enabled);
    if (byEnabled !== 0) return byEnabled;
    const byScope = SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope];
    if (byScope !== 0) return byScope;
    return left.entryPath.localeCompare(right.entryPath);
  });
  const [winner, ...shadowed] = ordered;
  if (!winner) return null;
  const moved = hintPath !== undefined && !hintMatches(winner);
  return { winner, shadowed, ...(moved ? { movedFrom: hintPath } : {}) };
}

export function toWireCandidate(candidate: DefinitionCandidate): DefinitionPreviewCandidate {
  return {
    kind: candidate.kind,
    name: candidate.name,
    scope: candidate.scope,
    enabled: candidate.enabled,
    entryPath: candidate.entryPath,
    ...(candidate.pluginName ? { pluginName: candidate.pluginName } : {}),
  };
}
