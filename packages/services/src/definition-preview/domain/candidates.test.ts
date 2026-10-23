import type { AgentSummary, SkillSummary, ZCodeCommand } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  agentCandidates,
  commandCandidates,
  selectCandidate,
  skillCandidates,
} from "./candidates.js";

function skill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: overrides.path ?? "id",
    name: "skill-creator",
    description: "Create skills",
    body: "",
    path: "/home/u/.zcode/skills/skill-creator/SKILL.md",
    scope: "user",
    enabled: true,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: "agent",
    name: "reviewer",
    description: "Reviews code",
    systemPrompt: "",
    path: "/home/u/.zcode/agents/reviewer.md",
    scope: "user",
    source: "user",
    enabled: true,
    ...overrides,
  } as AgentSummary;
}

describe("skillCandidates", () => {
  it("roots a skill at its directory and selects SKILL.md", () => {
    const [candidate] = skillCandidates([skill({})], "skill-creator");
    expect(candidate).toMatchObject({
      kind: "skill",
      rootPath: "/home/u/.zcode/skills/skill-creator",
      entryRelativePath: "SKILL.md",
      singleFile: false,
      userOwned: true,
    });
  });

  it("matches names exactly and marks plugin skills as not user-owned", () => {
    const skills = [skill({ name: "other" }), skill({ scope: "plugin", pluginName: "kit" })];
    const candidates = skillCandidates(skills, "skill-creator");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ scope: "plugin", pluginName: "kit", userOwned: false });
  });
});

describe("agentCandidates", () => {
  it("skips built-in agents, whose path is not a file", () => {
    const agents = [agent({ name: "Explore", source: "built-in", path: "built-in:Explore" })];
    expect(agentCandidates(agents, "Explore")).toEqual([]);
  });

  it("maps workspace, user and plugin agents to single-file candidates", () => {
    const candidates = agentCandidates(
      [
        agent({ scope: "workspace", path: "/w/.zcode/agents/reviewer.md" }),
        agent({ source: "plugin", path: "/cache/kit/agents/reviewer.md" }),
        agent({ readOnly: true, path: "/home/u/.zcode/agents/reviewer.md" }),
      ],
      "reviewer",
    );
    expect(
      candidates.map((c) => [c.scope, c.singleFile, c.userOwned, c.entryRelativePath]),
    ).toEqual([
      ["workspace", true, true, "reviewer.md"],
      ["plugin", true, false, "reviewer.md"],
      ["user", true, false, "reviewer.md"],
    ]);
  });
});

describe("commandCandidates", () => {
  it("maps project, global and plugin commands", () => {
    const commands = [
      {
        name: "ship",
        source: "user",
        scope: "project",
        filePath: "/w/.zcode/commands/ship.md",
        enabled: true,
      },
      {
        name: "ship",
        source: "user",
        scope: "global",
        filePath: "/home/u/.zcode/commands/ship.md",
        enabled: true,
      },
      {
        name: "ship",
        source: "plugin",
        scope: "global",
        filePath: "/cache/kit/commands/ship.md",
        enabled: true,
        pluginName: "kit",
      },
    ] as unknown as ZCodeCommand[];
    expect(commandCandidates(commands, "ship").map((c) => [c.scope, c.pluginName])).toEqual([
      ["workspace", undefined],
      ["user", undefined],
      ["plugin", "kit"],
    ]);
  });
});

describe("selectCandidate", () => {
  const workspace = skill({ scope: "workspace", path: "/w/.zcode/skills/skill-creator/SKILL.md" });
  const user = skill({
    scope: "user",
    path: "/real/skill-creator/SKILL.md",
    sourcePath: "/home/u/.zcode/skills/skill-creator/SKILL.md",
  });
  const plugin = skill({ scope: "plugin", path: "/cache/kit/skills/skill-creator/SKILL.md" });

  it("returns null when nothing matches", () => {
    expect(selectCandidate([])).toBeNull();
  });

  it("orders workspace > user > plugin and lists the rest as shadowed", () => {
    const selection = selectCandidate(skillCandidates([plugin, user, workspace], "skill-creator"));
    expect(selection?.winner.scope).toBe("workspace");
    expect(selection?.shadowed.map((c) => c.scope)).toEqual(["user", "plugin"]);
    expect(selection?.movedFrom).toBeUndefined();
  });

  it("prefers enabled over a higher scope", () => {
    const disabledWorkspace = { ...workspace, enabled: false };
    const selection = selectCandidate(skillCandidates([disabledWorkspace, user], "skill-creator"));
    expect(selection?.winner.scope).toBe("user");
  });

  it("lets the mention path pick a candidate, matching the symlink source path too", () => {
    const candidates = skillCandidates([workspace, user, plugin], "skill-creator");
    const bySource = selectCandidate(candidates, "/home/u/.zcode/skills/skill-creator/SKILL.md");
    expect(bySource?.winner.scope).toBe("user");
    expect(bySource?.movedFrom).toBeUndefined();
    const byWindowsPath = selectCandidate(
      candidates,
      "\\cache\\kit\\skills\\skill-creator\\SKILL.md",
    );
    expect(byWindowsPath?.winner.scope).toBe("plugin");
  });

  it("reports movedFrom when the mention path matches no candidate", () => {
    const selection = selectCandidate(
      skillCandidates([workspace], "skill-creator"),
      "/old/place/skill-creator/SKILL.md",
    );
    expect(selection?.winner.scope).toBe("workspace");
    expect(selection?.movedFrom).toBe("/old/place/skill-creator/SKILL.md");
  });
});
