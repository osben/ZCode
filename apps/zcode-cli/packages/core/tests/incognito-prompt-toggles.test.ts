import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import {
  INCOGNITO_CAPABILITY_KEYS,
  INCOGNITO_LOCKDOWN_PROFILE,
  type IncognitoCapabilities,
  type IncognitoProfile,
} from "@zcode/shared";
import { createContextBuilder } from "../src/context/index.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";
import type { EnvInfo } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// specs/incognito-session.md "Prompt toggles": each toggle owns its sections; the markers
// below identify those sections in the built provider-visible text.
const MARKERS = {
  cliPrefix: "You are ZCode, an interactive coding agent",
  identityIntro:
    "You are an interactive ZCode agent that helps users with software engineering tasks.",
  harness: "# Harness",
  desktop: "# ZCode Desktop Context",
  behavior: "# Communicating with the user",
  sessionGuidance: "# Session-specific guidance",
  environment: "# Environment",
  workingDirectory: "Primary working directory",
  gitStatus: "# gitStatus",
} as const;

const SAFETY_NOTICE = "IMPORTANT: Assist with authorized security testing";
const CONFIRMATION_PARAGRAPH =
  "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized";
const CONTEXT_MANAGEMENT = "# Context management";

const ENV_INFO: EnvInfo = {
  cwd: "/workspace/app",
  platform: "darwin",
  shell: "zsh",
  osVersion: "Darwin 27",
  nodeVersion: "v26",
  isGitRepository: true,
  gitBranch: "feat/x",
  gitMainBranch: "main",
  gitUser: "Dev",
  gitStatus: "clean",
  gitStatusLines: [],
  recentCommits: ["abc123 first"],
};

const SKILL = {
  name: "demo-skill",
  description: "A demo skill",
  filePath: "/workspace/app/.zcode/skills/demo-skill/SKILL.md",
  source: "project",
  userInvocable: true,
  disableModelInvocation: false,
} as never;

// Environment, model, Git and date are runtime announcements now: their builder sections are the
// text the runtime announces, so the prompt-toggle checks read them alongside the system messages.
const ANNOUNCED_SOURCES = new Set(["env_info", "model", "session_context", "current_date"]);

function announcedText(result: { sections: Array<{ source: string; content: string }> }): string {
  return result.sections
    .filter((section) => ANNOUNCED_SOURCES.has(section.source))
    .map((section) => section.content)
    .join("\n");
}

function buildMain(incognito: IncognitoProfile | undefined) {
  const builder = createContextBuilder({
    workingDirectory: ENV_INFO.cwd,
    envInfo: ENV_INFO,
    presentationSurface: "zcode_desktop",
    genUiOutputDirectory: "/tmp/gen-ui",
    currentDate: "2026-10-18",
    guidanceToolNames: ["Skill", "Read", "Bash"],
    skills: { skills: [SKILL], diagnostics: [], totalDiscovered: 1 },
    ...(incognito ? { incognito } : {}),
  });
  const result = builder.build();
  const system = result.systemMessages.map((message) => message.content).join("\n");
  const meta = result.metaUserAttachments.map((attachment) => attachment.content).join("\n");
  return { system, text: `${system}\n${meta}\n${announcedText(result)}`, result };
}

function profileWith(on: Partial<IncognitoCapabilities>): IncognitoProfile {
  return { ...INCOGNITO_LOCKDOWN_PROFILE, ...on };
}

function expectMarkers(text: string, present: readonly string[], absent: readonly string[]) {
  for (const marker of present) expect(text, `expected ${marker}`).toContain(marker);
  for (const marker of absent) expect(text, `unexpected ${marker}`).not.toContain(marker);
}

const ALL_MARKERS = Object.values(MARKERS);

describe("main agent prompt toggles", () => {
  it("normal session keeps every identity, harness and environment section", () => {
    const { text } = buildMain(undefined);
    expectMarkers(text, [...ALL_MARKERS, SAFETY_NOTICE, CONTEXT_MANAGEMENT], []);
  });

  it("incognito with every prompt toggle off keeps only the safety floor and context management", () => {
    const { system, text } = buildMain(INCOGNITO_LOCKDOWN_PROFILE);
    expectMarkers(
      text,
      [SAFETY_NOTICE, CONFIRMATION_PARAGRAPH, CONTEXT_MANAGEMENT],
      [...ALL_MARKERS],
    );
    // The confirmation floor is emitted exactly once, in the stable system message.
    expect(system.split(CONFIRMATION_PARAGRAPH).length - 1).toBe(1);
  });

  it("identity on alone returns the CLI prefix and identity intro only", () => {
    const { text } = buildMain(profileWith({ identity: true }));
    expectMarkers(
      text,
      [MARKERS.cliPrefix, MARKERS.identityIntro],
      [
        MARKERS.harness,
        MARKERS.desktop,
        MARKERS.behavior,
        MARKERS.sessionGuidance,
        MARKERS.environment,
        MARKERS.workingDirectory,
        MARKERS.gitStatus,
      ],
    );
  });

  it("harness on alone returns the harness block, desktop context, behavior and session guidance", () => {
    const { text } = buildMain(profileWith({ harness: true }));
    expectMarkers(
      text,
      [MARKERS.harness, MARKERS.desktop, MARKERS.behavior, MARKERS.sessionGuidance],
      [MARKERS.cliPrefix, MARKERS.identityIntro, MARKERS.environment, MARKERS.gitStatus],
    );
    expect(text.split(CONFIRMATION_PARAGRAPH).length - 1).toBe(1);
  });

  it("environment on alone returns the environment block and git system context", () => {
    const { text } = buildMain(profileWith({ environment: true }));
    expectMarkers(
      text,
      [MARKERS.environment, MARKERS.workingDirectory, MARKERS.gitStatus],
      [MARKERS.cliPrefix, MARKERS.harness, MARKERS.behavior],
    );
  });

  it("environment off keeps the execution-worktree bullet under the environment heading", () => {
    const builder = createContextBuilder({
      workingDirectory: ENV_INFO.cwd,
      envInfo: ENV_INFO,
      executionWorktree: {
        path: "/workspace/app-wt",
        branchName: "feat/x",
        workspacePath: "/workspace/app",
      },
      incognito: INCOGNITO_LOCKDOWN_PROFILE,
    });
    const text = builder
      .build()
      .systemMessages.map((message) => message.content)
      .join("\n");
    expect(text).toContain(
      "# Environment\n- Execution worktree: this session runs in a linked git worktree",
    );
    expect(text).not.toContain(MARKERS.workingDirectory);
    expect(text).not.toContain(MARKERS.gitStatus);
  });

  it("each toggle is independent: every other toggle off leaves the other owners out", () => {
    for (const key of INCOGNITO_CAPABILITY_KEYS) {
      if (!["identity", "harness", "environment"].includes(key)) continue;
      const { text } = buildMain(profileWith({ [key]: true } as Partial<IncognitoCapabilities>));
      const owned: Record<string, string[]> = {
        identity: [MARKERS.cliPrefix, MARKERS.identityIntro],
        harness: [MARKERS.harness, MARKERS.desktop, MARKERS.behavior, MARKERS.sessionGuidance],
        environment: [MARKERS.environment, MARKERS.gitStatus],
      };
      const others = Object.entries(owned)
        .filter(([owner]) => owner !== key)
        .flatMap(([, markers]) => markers);
      expectMarkers(text, owned[key] ?? [], others);
    }
  });

  it("current date and the safety notice stay in every mode", () => {
    const { text } = buildMain(INCOGNITO_LOCKDOWN_PROFILE);
    expect(text).toContain(SAFETY_NOTICE);
    expect(text).toContain("Today's date is 2026-10-18.");
  });
});

describe("subagent prompt toggles", () => {
  const subagentSystem = (incognito: IncognitoProfile | undefined, worktree = false) => {
    const builder = createSubagentContextBuilder({
      agentPrompt: "SUBAGENT_TASK_PROMPT",
      envInfo: ENV_INFO,
      ...(worktree
        ? {
            executionWorktree: {
              path: "/workspace/app-wt",
              branchName: "feat/x",
              workspacePath: "/workspace/app",
            },
          }
        : {}),
      ...(incognito ? { incognito } : {}),
    });
    const result = builder.build();
    return `${result.systemMessages.map((message) => message.content).join("\n")}\n${announcedText(result)}`;
  };

  it("a normal subagent keeps the CLI prefix, notes and environment", () => {
    const text = subagentSystem(undefined);
    expect(text).toContain(MARKERS.cliPrefix);
    expect(text).toContain("Notes:");
    expect(text).toContain("Primary working directory: /workspace/app");
  });

  it("an incognito subagent with all prompt toggles off keeps only its task prompt and the confirmation floor", () => {
    const text = subagentSystem(INCOGNITO_LOCKDOWN_PROFILE);
    expect(text).toContain("SUBAGENT_TASK_PROMPT");
    expect(text).toContain(CONFIRMATION_PARAGRAPH);
    expect(text).not.toContain(MARKERS.cliPrefix);
    expect(text).not.toContain("Notes:");
    expect(text).not.toContain("<env>");
    expect(text).not.toContain("Working directory");
  });

  it("an incognito subagent keeps the worktree line in its environment context", () => {
    const text = subagentSystem(INCOGNITO_LOCKDOWN_PROFILE, true);
    expect(text).toContain("Execution worktree: this session runs in a linked git worktree");
    expect(text).not.toContain("Working directory");
  });

  it("identity and environment toggles on the subagent restore only their own text", () => {
    const withIdentity = subagentSystem(profileWith({ identity: true }));
    expect(withIdentity).toContain(MARKERS.cliPrefix);
    expect(withIdentity).not.toContain("Working directory");
    const withEnvironment = subagentSystem(profileWith({ environment: true }));
    expect(withEnvironment).toContain("Primary working directory: /workspace/app");
    expect(withEnvironment).not.toContain(MARKERS.cliPrefix);
  });
});

describe("automationTools runtime gate", () => {
  const WORKFLOW_GUIDANCE = "the CreateWorkflow tool is mandatory";
  const AUTOMATION_NAMES = ["CronCreate", "CronList", "CronUpdate", "CronDelete"];
  const OFF_PEAK_NAMES = ["OffPeakCreate", "OffPeakList"];
  const DYNAMIC_WORKFLOW_NAMES = [
    "CreateWorkflow",
    "AmendWorkflow",
    "SaveWorkflow",
    "ListSavedWorkflows",
    "ListModels",
    "EvalWorkflowSnippet",
    "ListWorkflowRuns",
    "GetWorkflowRun",
    "ResumeWorkflowRun",
    "ResolveWorkflowQuestion",
    "FillWorkflowHole",
  ];

  function requestToolNames(incognito: IncognitoProfile | undefined) {
    const requests: Array<{ tools: string[]; text: string; toolsJson: string }> = [];
    const automationPort = {
      create: async () => {
        throw new Error("not called");
      },
      update: async () => {
        throw new Error("not called");
      },
      delete: async () => undefined,
      list: async () => [],
    };
    const runtime = createTestAgentRuntime(
      createSessionId(`automation-gate-${incognito ? "incognito" : "normal"}`),
      {
        mode: "build",
        workingDirectory: "/workspace/project",
        ...(incognito ? { incognito } : {}),
      },
      {
        automationPort,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            requests.push({
              tools: (request.tools ?? []).map((tool: { name: string }) => tool.name),
              text: JSON.stringify(request.messages),
              toolsJson: JSON.stringify(request.tools ?? []),
            });
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );
    return runtime.executeTurn("hello").then(() => requests[0]!);
  }

  it("a normal session registers the Cron tools and the dynamic-workflow tools", async () => {
    const { tools } = await requestToolNames(undefined);
    expect(tools).toEqual(expect.arrayContaining([...AUTOMATION_NAMES, ...DYNAMIC_WORKFLOW_NAMES]));
  });

  it("an incognito session without automationTools removes Cron, workflow tools and workflow guidance", async () => {
    const { tools, toolsJson } = await requestToolNames(INCOGNITO_LOCKDOWN_PROFILE);
    for (const name of [...AUTOMATION_NAMES, ...OFF_PEAK_NAMES, ...DYNAMIC_WORKFLOW_NAMES]) {
      expect(tools, name).not.toContain(name);
    }
    // Agent and Task descriptions drop the CreateWorkflow instruction together with the tool.
    expect(toolsJson).not.toContain(WORKFLOW_GUIDANCE);
  });

  it("automationTools on restores the Cron tools, the dynamic-workflow tools and their guidance", async () => {
    const { tools, toolsJson } = await requestToolNames(profileWith({ automationTools: true }));
    expect(tools).toEqual(expect.arrayContaining([...AUTOMATION_NAMES, ...DYNAMIC_WORKFLOW_NAMES]));
    expect(toolsJson).toContain(WORKFLOW_GUIDANCE);
  });
});
