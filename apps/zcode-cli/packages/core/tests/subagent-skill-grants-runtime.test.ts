import { describe, expect, it } from "vitest";
import {
  type SkillContent,
  type SkillLoadOutcome,
  type SkillLoadRequest,
  type SkillPort,
  createSessionId,
  modelMessageContentToText,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// Runtime scenarios for specs/subagent-skill-identity.md: grants are frozen at child start and the
// child loads the exact granted file.

type SkillMetadata = SkillLoadOutcome["skills"][number];

const USER_FOO = skill("foo", "/home/u/.zcode/skills/foo/SKILL.md", "user");
const PROJECT_FOO = skill("foo", "/workspace/project/.zcode/skills/foo/SKILL.md", "project");
const LATE_FOO = skill("foo", "/extra/skills/foo/SKILL.md", "project");

interface SkillAgentRun {
  loadRequests: SkillLoadRequest[];
  skillResultText: string;
}

async function runSkillAgent(options: {
  /** "start" until the child sends its first model request, "running" afterwards. */
  discover: (phase: "start" | "running") => SkillMetadata[];
  profileSkills?: readonly string[];
  skillCall: string;
}): Promise<SkillAgentRun> {
  const loadRequests: SkillLoadRequest[] = [];
  let phase: "start" | "running" = "start";
  const skillPort: SkillPort = {
    async discoverSkills(): Promise<SkillLoadOutcome> {
      const skills = options.discover(phase);
      return { diagnostics: [], skills, totalDiscovered: skills.length };
    },
    async loadSkill(request): Promise<SkillContent> {
      loadRequests.push(request);
      const metadata = [USER_FOO, PROJECT_FOO, LATE_FOO].find(
        (candidate) => candidate.path === request.path,
      );
      if (!metadata) throw new Error(`Skill not found: ${request.name}`);
      return {
        baseDirectory: metadata.directory,
        bytesRead: 1,
        content: `body of ${metadata.path}`,
        metadata,
        sizeBytes: 1,
        truncated: false,
      };
    },
  };
  let parentCalls = 0;
  const childRequests: any[] = [];
  const runtime = createTestAgentRuntime(
    createSessionId("runtime-subagent-skill-grants"),
    {
      mode: "build",
      workingDirectory: "/workspace/project",
      subagents: {
        profiles: [
          {
            name: "skill-agent",
            description: "Uses granted skills.",
            source: "project",
            systemPrompt: "Load the granted skill.",
            tools: options.profileSkills ? ["Read"] : ["Read", "Skill"],
            ...(options.profileSkills ? { skills: options.profileSkills } : {}),
          },
        ],
      },
    },
    {
      eventStore: createTestSessionEventStore(),
      skillPort,
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (toolNames.includes("Agent")) {
            parentCalls++;
            if (parentCalls === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_skill_agent",
                    name: "Agent",
                    input: {
                      description: "skill grants",
                      prompt: "Load the skill.",
                      subagent_type: "skill-agent",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "parent done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          childRequests.push(request);
          phase = "running";
          if (childRequests.length === 1) {
            return {
              finishReason: "tool-calls",
              providerMetadata: undefined,
              text: "",
              toolCalls: [{ id: "call_skill", name: "Skill", input: { skill: options.skillCall } }],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: "child done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );

  await runtime.executeTurn("run skill-agent");

  const messagesText = (request: any) =>
    (request?.messages ?? [])
      .map((message: any) => modelMessageContentToText(message.content))
      .join("\n");
  const firstText = messagesText(childRequests[0]);
  const secondText = messagesText(childRequests[1]);
  return {
    loadRequests,
    skillResultText: secondText.slice(firstText.length),
  };
}

describe("subagent skill grants by physical identity", () => {
  it("grants the user copy when user and project skills share a bare name", async () => {
    const run = await runSkillAgent({
      discover: () => [USER_FOO, PROJECT_FOO],
      profileSkills: ["foo"],
      skillCall: "foo",
    });

    expect(run.loadRequests).toHaveLength(1);
    expect(run.loadRequests[0]?.path).toBe(USER_FOO.path);
    expect(run.skillResultText).toContain(`body of ${USER_FOO.path}`);
    expect(run.skillResultText).not.toContain("ambiguous");
  });

  it("keeps the grant frozen when a same-named skill appears after the child started", async () => {
    const run = await runSkillAgent({
      // A higher-priority copy shows up only after the grants were frozen.
      discover: (phase) => (phase === "start" ? [USER_FOO] : [LATE_FOO, USER_FOO]),
      profileSkills: ["foo"],
      skillCall: "foo",
    });

    expect(run.loadRequests.map((request) => request.path)).toEqual([USER_FOO.path]);
  });

  it("rejects a granted skill that disappeared while the child runs", async () => {
    const run = await runSkillAgent({
      discover: (phase) => (phase === "start" ? [USER_FOO] : []),
      profileSkills: ["foo"],
      skillCall: "foo",
    });

    expect(run.loadRequests).toHaveLength(0);
    expect(run.skillResultText).toContain("Skill is not allowed for subagent");
  });

  it("starts with no granted skills when discovery fails at child start", async () => {
    const run = await runSkillAgent({
      discover: (phase) => {
        if (phase === "start") throw new Error("scan failed");
        return [USER_FOO];
      },
      profileSkills: ["foo"],
      skillCall: "foo",
    });

    expect(run.loadRequests).toHaveLength(0);
    expect(run.skillResultText).toContain("Skill is not allowed for subagent");
  });

  it("passes the exact path when the profile declares no skill list", async () => {
    const run = await runSkillAgent({
      discover: () => [PROJECT_FOO],
      skillCall: "foo",
    });

    expect(run.loadRequests.map((request) => request.path)).toEqual([PROJECT_FOO.path]);
  });
});

function skill(name: string, path: string, scope: SkillMetadata["scope"]): SkillMetadata {
  return {
    description: `${name} description`,
    directory: path.slice(0, path.lastIndexOf("/")),
    frontmatterKeys: ["name", "description"],
    name,
    path,
    rootPath: path.slice(0, path.indexOf("/skills/") + "/skills".length),
    safeToAutoLoad: true,
    scope,
    source: "zcode",
  };
}
