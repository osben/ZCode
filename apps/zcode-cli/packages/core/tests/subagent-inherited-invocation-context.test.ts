import { describe, expect, it } from "vitest";
import {
  createSessionId,
  getCurrentModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelResult,
  type SessionTaskType,
} from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

interface SeenRequest {
  querySource: unknown;
  sessionType: ModelInvocationContext["modelRequestSessionType"];
  refresh: ModelInvocationContext["refreshRuntimeHeadersBeforeAttempt"];
}

const parentSelection = { providerId: "test", modelId: "parent-model" };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function record(seen: SeenRequest[], context: ModelInvocationContext | undefined) {
  seen.push({
    querySource: (context?.metadata as { querySource?: unknown } | undefined)?.querySource,
    sessionType: context?.modelRequestSessionType,
    refresh: context?.refreshRuntimeHeadersBeforeAttempt,
  });
}

/**
 * The child inherits the parent's Active Model, which is already wrapped by the parent's runtime and
 * turn layers. Those inner layers used to overwrite the child's host classification (main instead of
 * subagent) on every child request.
 */
describe("inherited subagent model invocation context", () => {
  it.each([
    ["off", "inherit"],
    ["on", "inherit"],
    ["off", "explicit"],
    ["on", "explicit"],
  ] as const)(
    "stream=%s, %s: child requests are classified as subagent and the parent stays main",
    async (modelStreaming, kind) => {
      const seen: SeenRequest[] = [];
      let mainCalls = 0;
      const refreshedSessionIds: string[] = [];
      const respond = (context: ModelInvocationContext | undefined): ModelResult => {
        record(seen, context);
        const querySource = (context?.metadata as { querySource?: string } | undefined)
          ?.querySource;
        if (querySource === "subagent") return { finishReason: "stop", text: "child done", usage };
        if (++mainCalls > 1) return { finishReason: "stop", text: "done", usage };
        return {
          finishReason: "tool-calls",
          text: "",
          usage,
          toolCalls: [
            {
              id: "call_child",
              name: "Agent",
              input: {
                description: "Research",
                prompt: "Research code",
                subagent_type: "researcher",
              },
            },
          ],
        };
      };
      const runtime = createTestAgentRuntime(
        createSessionId(`inherited-context-${modelStreaming}-${kind}`),
        {
          mode: "yolo",
          modelStreaming,
          workingDirectory: "/workspace/project",
          modelSelection: parentSelection,
          subagents: {
            profiles: [
              {
                name: "researcher",
                description: "Research code",
                source: "user",
                tools: ["Read"],
                systemPrompt: "Return a short result.",
                ...(kind === "explicit"
                  ? { modelSelection: { providerId: "test", modelId: "child-model" } }
                  : {}),
              },
            ],
          },
        },
        {
          eventStore: createTestSessionEventStore(),
          providerRuntimeHeadersPort: {
            refreshBeforeModelRequest: async (input) => {
              refreshedSessionIds.push(input.sessionId);
              return { headersApplied: true };
            },
          },
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              return respond(observation.invocationContext);
            },
            async *streamText() {
              // Observe the context while the stream is consumed, not when it is created.
              await Promise.resolve();
              const result = respond(getCurrentModelInvocationContext());
              if (result.text) {
                yield { id: "text", type: "text_start" };
                yield { id: "text", type: "text_delta", text: result.text };
                yield { id: "text", type: "text_end" };
              }
              for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
              yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
            },
          }),
        },
      );

      await runtime.executeTurn("Run the researcher.");

      const child = seen.filter((request) => request.querySource === "subagent");
      const parent = seen.filter((request) => request.querySource === "main_turn");
      expect(child).toHaveLength(1);
      expect(parent.length).toBeGreaterThanOrEqual(2);
      expect(child.map((request) => request.sessionType)).toEqual(["subagent"]);
      expect(new Set(parent.map((request) => request.sessionType))).toEqual(new Set(["main"]));
      // The child's turn layer now owns the refresh; account headers must still route to the parent session.
      await child[0]!.refresh!({ attempt: 1, providerId: "test", modelId: "parent-model" });
      expect(refreshedSessionIds).toEqual([runtime.getSessionId()]);
    },
  );

  it("keeps the outermost host layer through an async-generator wrapper between the layers", async () => {
    const seen: SeenRequest[] = [];
    const modelFactory = createTestModelFactory({
      async generateText() {
        return { finishReason: "stop", text: "ok", usage };
      },
      async *streamText() {
        await Promise.resolve();
        record(seen, getCurrentModelInvocationContext());
        yield { type: "finish", finishReason: "stop" };
      },
    });
    const createRuntime = (taskType: SessionTaskType, factory = modelFactory) =>
      createTestAgentRuntime(
        createSessionId(`async-wrapper-${taskType}`),
        { modelSelection: parentSelection, taskType },
        { eventStore: createTestSessionEventStore(), modelFactory: factory },
      );
    const parentModel = createRuntimeModel(createRuntime("interactive") as never, {
      selection: parentSelection,
    });
    // Mirrors the off-peak binding: an async generator defers the inner layers until the first next().
    const deferred: Model = Object.freeze({
      ...parentModel,
      bind: (options) => parentModel.bind(options),
      generateText: (request) => parentModel.generateText(request),
      async *streamText(request) {
        yield* parentModel.streamText(request);
      },
    });
    const childModel = createRuntimeModel(
      createRuntime("subagent_child", () => deferred) as never,
      { selection: parentSelection },
    );

    for (const model of [childModel, parentModel]) {
      for await (const _event of model.streamText({
        messages: [{ role: "user", content: "hello" }],
      })) {
        /* consume the whole stream */
      }
    }

    expect(seen.map((request) => request.sessionType)).toEqual(["subagent", "main"]);
    expect(getCurrentModelInvocationContext()).toBeUndefined();
  });
});
