import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, SkillSummary, ZCodeCommand } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DefinitionCatalogPort } from "../app/ports.js";
import { createDefinitionPreviewService } from "./service.js";

let base: string;
let skills: SkillSummary[];
let agents: AgentSummary[];
let commands: ZCodeCommand[];

const workspace = { workspacePath: "/workspace", workspaceIdentity: "/workspace" };

function catalog(): DefinitionCatalogPort {
  return {
    listSkills: vi.fn(async () => skills),
    listAgents: vi.fn(async () => agents),
    listCommands: vi.fn(async () => commands),
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "definition-preview-service-"));
  const skillDir = join(base, "skills", "skill-creator");
  await mkdir(join(skillDir, "references"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# Skill creator\n");
  await writeFile(join(skillDir, "references", "schemas.md"), "# Schemas\n");
  await writeFile(join(base, "reviewer.md"), "---\nname: reviewer\n---\nReview.\n");
  await writeFile(join(base, "ship.md"), "Ship it.\n");
  skills = [
    {
      id: "s1",
      name: "skill-creator",
      description: "Create skills",
      body: "",
      path: join(skillDir, "SKILL.md"),
      scope: "user",
      enabled: true,
    },
  ];
  agents = [
    {
      id: "a1",
      name: "reviewer",
      description: "Reviews",
      systemPrompt: "",
      path: join(base, "reviewer.md"),
      scope: "user",
      source: "user",
      enabled: true,
    } as AgentSummary,
    {
      id: "a2",
      name: "Explore",
      description: "",
      systemPrompt: "",
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
    } as AgentSummary,
  ];
  commands = [
    {
      id: "c1",
      name: "ship",
      source: "user",
      scope: "global",
      filePath: join(base, "ship.md"),
      enabled: true,
    } as unknown as ZCodeCommand,
  ];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("definition preview service", () => {
  it("resolves a skill to its folder tree and reads files inside it", async () => {
    const service = createDefinitionPreviewService({ catalog: catalog() });
    const ref = { kind: "skill" as const, name: "skill-creator", ...workspace };
    const resolved = await service.resolve(ref);
    expect(resolved).toMatchObject({
      status: "found",
      definition: { kind: "skill", entryRelativePath: "SKILL.md", singleFile: false },
      truncated: false,
      shadowed: [],
    });
    expect(resolved.status === "found" && resolved.tree.map((e) => e.relativePath)).toEqual([
      "references",
      "references/schemas.md",
      "SKILL.md",
    ]);
    expect(await service.readFile({ ref, relativePath: "references/schemas.md" })).toMatchObject({
      status: "text",
      content: "# Schemas\n",
    });
  });

  it("rejects traversal before touching the filesystem", async () => {
    const port = catalog();
    const service = createDefinitionPreviewService({ catalog: port });
    const ref = { kind: "skill" as const, name: "skill-creator", ...workspace };
    expect(await service.readFile({ ref, relativePath: "../../reviewer.md" })).toEqual({
      status: "rejected",
    });
    expect(port.listSkills).not.toHaveBeenCalled();
  });

  it("resolves single-file subagents and commands, accepting only their own basename", async () => {
    const service = createDefinitionPreviewService({ catalog: catalog() });
    const agentRef = { kind: "subagent" as const, name: "reviewer", ...workspace };
    expect(await service.resolve(agentRef)).toMatchObject({
      status: "found",
      definition: { singleFile: true, entryRelativePath: "reviewer.md" },
      tree: [{ relativePath: "reviewer.md", kind: "file" }],
    });
    expect(await service.readFile({ ref: agentRef, relativePath: "reviewer.md" })).toMatchObject({
      status: "text",
    });
    expect(await service.readFile({ ref: agentRef, relativePath: "ship.md" })).toEqual({
      status: "rejected",
    });

    const commandRef = { kind: "command" as const, name: "ship", ...workspace };
    expect(await service.readFile({ ref: commandRef, relativePath: "ship.md" })).toMatchObject({
      status: "text",
      content: "Ship it.\n",
    });
  });

  it("returns not_found for unknown names, built-in agents, plugins and deleted files", async () => {
    const service = createDefinitionPreviewService({ catalog: catalog() });
    expect(await service.resolve({ kind: "skill", name: "nope", ...workspace })).toEqual({
      status: "not_found",
    });
    expect(await service.resolve({ kind: "subagent", name: "Explore", ...workspace })).toEqual({
      status: "not_found",
    });
    expect(await service.resolve({ kind: "plugin", name: "kit", ...workspace })).toEqual({
      status: "not_found",
    });
    await rm(join(base, "reviewer.md"));
    expect(await service.resolve({ kind: "subagent", name: "reviewer", ...workspace })).toEqual({
      status: "not_found",
    });
  });

  it("reports movedFrom when the mention path no longer matches", async () => {
    const service = createDefinitionPreviewService({ catalog: catalog() });
    const resolved = await service.resolve({
      kind: "skill",
      name: "skill-creator",
      hintPath: "/old/skill-creator/SKILL.md",
      ...workspace,
    });
    expect(resolved).toMatchObject({ status: "found", movedFrom: "/old/skill-creator/SKILL.md" });
  });

  it("rejects refs that carry a client-chosen root", async () => {
    const service = createDefinitionPreviewService({ catalog: catalog() });
    await expect(
      service.resolve({
        kind: "skill",
        name: "skill-creator",
        root: "/etc",
        ...workspace,
      } as never),
    ).rejects.toThrow();
  });
});
