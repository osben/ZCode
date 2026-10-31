import { describe, expect, it } from "vitest";
import { createSessionId, type ModelRequest } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestSkillPort } from "./test-skill-port.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// specs/prompt-cache-stability.md: the model-visible prefix (tools + system messages + meta-user
// blocks) must be byte-identical across requests in a session absent an allowed change. The
// harness pins every input the prefix is built from; only the injected `now` and the session
// model selection vary between scenarios.
const PROJECT_INSTRUCTIONS = "PROJECT_AGENTS_MD_MARKER";
const SNAPSHOT_CURRENT_DATE = "2026-10-18";
const FIRST_TURN_INPUT = "turn-one";

interface CapturedRequest {
  /** JSON.stringify(request.tools) taken at call time; later registry mutations cannot rewrite it. */
  tools: string;
  /** JSON.stringify(request.messages) taken at call time. */
  messages: string;
}

function createStabilityRuntime(input: { sessionId: string; now: () => Date }): {
  runtime: ReturnType<typeof createTestAgentRuntime>;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const runtime = createTestAgentRuntime(
    createSessionId(input.sessionId),
    {
      modelSelection: createTestModelSelection("provider-a/model-a"),
      titleGeneration: { enabled: false },
      userInstructions: { workingDirectory: "/workspace" },
      workingDirectory: "/workspace",
    },
    {
      eventStore: createTestSessionEventStore(),
      skillPort: createTestSkillPort("demo-skill"),
      now: input.now,
      contextSourcePort: {
        async resolveContextSources() {
          return {
            workingDirectory: "/workspace",
            currentDate: SNAPSHOT_CURRENT_DATE,
            diagnostics: [],
            envInfo: {
              cwd: "/workspace",
              platform: "linux",
              shell: "bash",
              osVersion: "Linux",
              nodeVersion: "v26",
            },
            userInstructions: {
              filePath: "/workspace/AGENTS.md",
              fileName: "AGENTS.md",
              content: PROJECT_INSTRUCTIONS,
              bytesRead: PROJECT_INSTRUCTIONS.length,
              sizeBytes: PROJECT_INSTRUCTIONS.length,
              truncated: false,
            },
          };
        },
      },
      modelFactory: createTestModelFactory({
        async generateText(request: ModelRequest) {
          requests.push({
            tools: JSON.stringify(request.tools ?? []),
            messages: JSON.stringify(request.messages ?? []),
          });
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: "ok",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    },
  );
  return { runtime, requests };
}

type CapturedMessage = { role?: string; content?: unknown };

function capturedMessages(request: CapturedRequest): CapturedMessage[] {
  return JSON.parse(request.messages) as CapturedMessage[];
}

function capturedTools(request: CapturedRequest): Array<{ name?: string; inputSchema?: unknown }> {
  return JSON.parse(request.tools) as Array<{ name?: string; inputSchema?: unknown }>;
}

function messageText(message: CapturedMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: string }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

/** Index of the first user conversation message: everything before it is the model-visible prefix. */
function prefixLength(request: CapturedRequest): number {
  const index = capturedMessages(request).findIndex((message) =>
    messageText(message).includes(FIRST_TURN_INPUT),
  );
  expect(index, "first user conversation message must be present").toBeGreaterThan(0);
  return index;
}

function prefixMessages(request: CapturedRequest): CapturedMessage[] {
  return capturedMessages(request).slice(0, prefixLength(request));
}

describe("prompt-cache prefix stability (specs/prompt-cache-stability.md)", () => {
  it("projects tool contracts as plain JSON, so stringify equality is meaningful", async () => {
    const { runtime, requests } = createStabilityRuntime({
      sessionId: "prompt-cache-tools-plain-json",
      now: () => new Date("2026-10-01T12:00:00"),
    });
    await runtime.executeTurn(FIRST_TURN_INPUT);
    expect(requests).toHaveLength(1);
    for (const tool of capturedTools(requests[0]!)) {
      expect(tool.name, "every tool contract carries a name").toEqual(expect.any(String));
      // A function, Date, or symbol inside the schema would be dropped by JSON.stringify and
      // hide prefix drift; the round-trip must be lossless.
      expect(JSON.parse(JSON.stringify(tool.inputSchema))).toEqual(tool.inputSchema);
    }
  });

  it("S1: keeps tools and prefix byte-identical across two plain turns", async () => {
    const { runtime, requests } = createStabilityRuntime({
      sessionId: "prompt-cache-two-plain-turns",
      now: () => new Date("2026-10-01T12:00:00"),
    });
    await runtime.executeTurn(FIRST_TURN_INPUT);
    await runtime.executeTurn("turn-two");

    expect(requests).toHaveLength(2);
    const prefixLengthOfFirst = prefixLength(requests[0]!);
    expect(prefixLengthOfFirst).toBeGreaterThanOrEqual(4);

    expect(requests[1]!.tools).toBe(requests[0]!.tools);
    expect(JSON.stringify(prefixMessages(requests[1]!))).toBe(
      JSON.stringify(prefixMessages(requests[0]!)),
    );
  });

  it("S2: a day rollover keeps the prefix identical and delivers the new date as a tail reminder", async () => {
    let day = 1;
    const { runtime, requests } = createStabilityRuntime({
      sessionId: "prompt-cache-day-rollover",
      now: () => new Date(`2026-10-0${day}T12:00:00`),
    });
    await runtime.executeTurn(FIRST_TURN_INPUT);
    day = 2;
    await runtime.executeTurn("turn-two");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.tools).toBe(requests[0]!.tools);
    expect(JSON.stringify(prefixMessages(requests[1]!))).toBe(
      JSON.stringify(prefixMessages(requests[0]!)),
    );

    // The first request announces the runtime clock's date inside the prefix; the rolled-over date
    // appears only in the tail.
    const prefixJson = JSON.stringify(prefixMessages(requests[1]!));
    expect(prefixJson).toContain("2026-10-01");
    expect(prefixJson).not.toContain("2026-10-02");

    const tail = capturedMessages(requests[1]!)
      .slice(prefixLength(requests[1]!))
      .map(messageText)
      .join("\n");
    expect(tail).toContain("The date has changed");
    expect(tail).toContain("2026-10-02");
  });

  it("S3: a model switch keeps the whole prefix identical and announces the model change in the tail", async () => {
    const { runtime, requests } = createStabilityRuntime({
      sessionId: "prompt-cache-model-switch",
      now: () => new Date("2026-10-01T12:00:00"),
    });
    await runtime.executeTurn(FIRST_TURN_INPUT);
    runtime.setSessionModelSelection({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    });
    await runtime.executeTurn("turn-two");

    expect(requests).toHaveLength(2);
    const first = capturedMessages(requests[0]!);
    for (const index of [0, 1, 2]) {
      expect(first[index]?.role, `system message ${index} stays at the head`).toBe("system");
    }
    // The model line is a runtime announcement (tail), not part of the system blocks.
    expect(JSON.stringify(prefixMessages(requests[1]!))).toBe(
      JSON.stringify(prefixMessages(requests[0]!)),
    );
    const firstTail = capturedMessages(requests[0]!)
      .slice(prefixLength(requests[0]!))
      .map(messageText)
      .join("\n");
    const secondTail = capturedMessages(requests[1]!)
      .slice(prefixLength(requests[1]!))
      .map(messageText)
      .join("\n");
    expect(firstTail).not.toContain("provider-b/model-b");
    expect(secondTail).toContain("You are powered by the model named provider-b/model-b.");
  });
});
