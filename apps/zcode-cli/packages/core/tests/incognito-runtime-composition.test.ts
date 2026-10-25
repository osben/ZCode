import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { INCOGNITO_LOCKDOWN_PROFILE, type IncognitoProfile } from "@zcode/shared";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestSkillPort } from "./test-skill-port.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// apps/zcode-cli/docs/design/v2/incognito-session.md: core owns the projectInstructions and
// skills listing override points.
const PROJECT_INSTRUCTIONS = "PROJECT_AGENTS_MD_MARKER";

async function runFirstTurn(incognito: IncognitoProfile | undefined) {
  const instructionRequests: unknown[] = [];
  const requests: Array<{ text: string; tools: string[] }> = [];
  const runtime = createTestAgentRuntime(
    createSessionId("incognito-runtime-composition"),
    {
      workingDirectory: "/workspace",
      titleGeneration: { enabled: false },
      userInstructions: { workingDirectory: "/workspace" },
      ...(incognito ? { incognito } : {}),
    },
    {
      eventStore: createTestSessionEventStore(),
      skillPort: createTestSkillPort("incognito-demo-skill"),
      contextSourcePort: {
        async resolveContextSources(request) {
          instructionRequests.push(request.userInstructions);
          return {
            workingDirectory: "/workspace",
            currentDate: "2026-10-18",
            diagnostics: [],
            envInfo: {
              cwd: "/workspace",
              platform: "linux",
              shell: "bash",
              osVersion: "Linux",
              nodeVersion: "v26",
            },
            ...(request.userInstructions
              ? {
                  userInstructions: {
                    filePath: "/workspace/AGENTS.md",
                    fileName: "AGENTS.md",
                    content: PROJECT_INSTRUCTIONS,
                    bytesRead: PROJECT_INSTRUCTIONS.length,
                    sizeBytes: PROJECT_INSTRUCTIONS.length,
                    truncated: false,
                  },
                }
              : {}),
          };
        },
      },
      modelFactory: createTestModelFactory({
        async generateText(request) {
          requests.push({
            text: JSON.stringify(request.messages),
            tools: (request.tools ?? []).map((tool: { name: string }) => tool.name),
          });
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: "ok",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );
  await runtime.executeTurn("hello");
  return {
    instructionRequests,
    request: requests[0]!,
  };
}

describe("core incognito overrides", () => {
  it("composes instructions and the skills listing for a normal session", async () => {
    const { instructionRequests, request } = await runFirstTurn(undefined);
    expect(instructionRequests[0]).toBeDefined();
    expect(request.text).toContain(PROJECT_INSTRUCTIONS);
    expect(request.text).toContain("incognito-demo-skill");
    expect(request.tools).toContain("Skill");
  });

  it("drops instructions and the skills listing but keeps the Skill tool for lockdown", async () => {
    const { instructionRequests, request } = await runFirstTurn(INCOGNITO_LOCKDOWN_PROFILE);
    expect(instructionRequests[0]).toBeUndefined();
    expect(request.text).not.toContain(PROJECT_INSTRUCTIONS);
    expect(request.text).not.toContain("incognito-demo-skill");
    expect(request.tools).toContain("Skill");
  });

  it("keeps a capability the session opted back into", async () => {
    const { request } = await runFirstTurn({
      ...INCOGNITO_LOCKDOWN_PROFILE,
      skills: true,
    });
    expect(request.text).not.toContain(PROJECT_INSTRUCTIONS);
    expect(request.text).toContain("incognito-demo-skill");
  });
});
