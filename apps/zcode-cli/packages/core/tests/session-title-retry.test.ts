import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { maybeStartSessionTitleGeneration } from "../src/runtime/methods/session-title.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

type TitleReply = "title" | "empty" | "throw";

function setup(
  id: string,
  replies: TitleReply[],
  config: Partial<AgentRuntimeConfig> = {},
  gate?: Promise<void>,
  extraDeps: Record<string, unknown> = {},
) {
  const store = createRecordingSubagentSessionStore();
  const titleRequests: string[] = [];
  const runtime = createTestAgentRuntime(
    createSessionId(id),
    {
      modelSelection: createTestModelSelection("user/normal"),
      titleGeneration: {},
      workingDirectory: "/workspace",
      ...config,
    },
    {
      sessionStore: store,
      eventStore: createTestSessionEventStore(),
      ...extraDeps,
      modelFactory: createTestModelFactory({
        async generateText(request, observation) {
          if (observation.invocationContext?.metadata?.querySource !== "session_title") {
            return {
              text: "done",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          titleRequests.push(JSON.stringify(request));
          await gate;
          const reply = replies[titleRequests.length - 1] ?? "title";
          if (reply === "throw") throw new Error("title failed");
          return {
            text: reply === "empty" ? "" : `{"title":"Title ${titleRequests.length}"}`,
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    },
  );
  return { runtime, store, titleRequests, internal: runtime as unknown as AgentRuntimeInternal };
}

const titleOf = async (
  store: ReturnType<typeof setup>["store"],
  runtime: ReturnType<typeof setup>["runtime"],
) => (await store.getSession(runtime.sessionId))?.title;

describe("bounded session title retry", () => {
  it("retries once with the first message after an empty reply, then stops", async () => {
    const { runtime, store, titleRequests } = setup("retry-empty", ["empty", "title"]);
    await runtime.executeTurn("implement the dark mode toggle");
    await expect.poll(() => titleRequests.length).toBe(1);
    await expect.poll(async () => (await store.getSession(runtime.sessionId))?.titleSource).toBe(
      "first_input",
    );

    await runtime.executeTurn("also add a settings entry for it");
    await expect.poll(() => titleRequests.length).toBe(2);
    await expect.poll(() => titleOf(store, runtime)).toBe("Title 2");
    expect(titleRequests[1]).toContain("dark mode toggle");
    expect(titleRequests[1]).not.toContain("settings entry");

    await runtime.executeTurn("and one more follow up message");
    await runtime.executeTurn("yet another follow up message");
    expect(titleRequests).toHaveLength(2);
    expect(await titleOf(store, runtime)).toBe("Title 2");
  });

  it("makes at most two model attempts when both fail", async () => {
    const { runtime, store, titleRequests } = setup("retry-cap", ["throw", "empty", "title"]);
    await runtime.executeTurn("implement the dark mode toggle");
    await expect.poll(() => titleRequests.length).toBe(1);
    await runtime.executeTurn("second message long enough");
    await expect.poll(() => titleRequests.length).toBe(2);
    await runtime.executeTurn("third message long enough");
    await runtime.executeTurn("fourth message long enough");
    expect(titleRequests).toHaveLength(2);
    expect((await store.getSession(runtime.sessionId))?.titleSource).toBe("first_input");
  });

  it("titles a session whose first message was too short from the next message", async () => {
    const { runtime, store, titleRequests } = setup("retry-short", []);
    await runtime.executeTurn("hi");
    expect(titleRequests).toHaveLength(0);
    expect(await titleOf(store, runtime)).toBe("hi");

    await runtime.executeTurn("please add dark mode support");
    await expect.poll(() => titleRequests.length).toBe(1);
    await expect.poll(() => titleOf(store, runtime)).toBe("Title 1");
    expect(titleRequests[0]).toContain("please add dark mode support");
  });

  it("does not retry after the user renamed the session", async () => {
    const { runtime, store, titleRequests, internal } = setup("retry-renamed", ["empty"]);
    await runtime.executeTurn("implement the dark mode toggle");
    await expect.poll(() => titleRequests.length).toBe(1);
    await internal.setCustomSessionTitle({ title: "My name", traceContext: runtime.rootTraceContext });

    await runtime.executeTurn("a follow up that is long enough");
    expect(titleRequests).toHaveLength(1);
    expect(await titleOf(store, runtime)).toBe("My name");
  });

  it("does not start a second attempt while one is in flight", async () => {
    const gate = Promise.withResolvers<void>();
    const { runtime, titleRequests, internal } = setup("retry-inflight", ["title"], {}, gate.promise);
    try {
      await runtime.executeTurn("implement the dark mode toggle");
      await expect.poll(() => titleRequests.length).toBe(1);
      expect(
        maybeStartSessionTitleGeneration.call(
          internal,
          "a second message long enough",
          "m2" as never,
          runtime.rootTraceContext,
        ),
      ).toBe(false);
      expect(titleRequests).toHaveLength(1);
    } finally {
      gate.resolve();
    }
  });
});

describe("retry edge cases", () => {
  it("keeps the /goal path first-turn-only so its goal summary fallback still runs", async () => {
    const { runtime, internal, titleRequests } = setup("retry-goal", []);
    internal.turnNumber = 3;
    expect(
      maybeStartSessionTitleGeneration.call(
        internal,
        "ship the dark mode feature end to end",
        "m1" as never,
        runtime.rootTraceContext,
        { goalSummaryTargetID: "goal-1" },
      ),
    ).toBe(false);
    expect(titleRequests).toHaveLength(0);
  });

  it("after a cold resume with a generated title, the next message only reads the store", async () => {
    const { runtime, store, internal, titleRequests } = setup("retry-resumed", []);
    await store.createSession({
      id: runtime.sessionId,
      projectID: "p" as never,
      taskType: "interactive",
      slug: "s",
      directory: "/workspace",
      path: "/workspace",
      title: "Existing generated title",
      titleSource: "generated",
      titleMessageID: "m0" as never,
      version: "1",
      time: { created: 1, updated: 1 },
    } as never);
    internal.turnNumber = 4;
    maybeStartSessionTitleGeneration.call(
      internal,
      "a follow up that is long enough",
      "m5" as never,
      runtime.rootTraceContext,
    );
    await expect.poll(() => internal.sessionTitleGenerationSettled).toBe(true);
    expect(titleRequests).toHaveLength(0);
    expect(internal.sessionTitleGenerationAttempts).toBe(0);
    expect(await titleOf(store, runtime)).toBe("Existing generated title");
  });

  it("retries after the turn for providers that need a runtime-header refresh", async () => {
    const { runtime, titleRequests } = setup(
      "retry-headers",
      ["empty", "title"],
      {},
      undefined,
      { providerRuntimeHeadersPort: { shouldRefreshBeforeModelRequest: () => true } },
    );
    await runtime.executeTurn("implement the dark mode toggle");
    await expect.poll(() => titleRequests.length).toBe(1);
    await runtime.executeTurn("also add a settings entry for it");
    await expect.poll(() => titleRequests.length).toBe(2);
    expect(titleRequests[1]).toContain("dark mode toggle");
  });
});

describe("selection side chat titles", () => {
  const SIDE_CHAT_ID = "side-chat-title";

  async function createSideChat(replies: TitleReply[], taskType: "selection_side_chat" | "fork") {
    const harness = setup(SIDE_CHAT_ID, replies, { taskType });
    const { store, runtime, internal } = harness;
    await store.createSession({
      id: runtime.sessionId,
      projectID: "p" as never,
      parentID: createSessionId("parent"),
      taskType,
      slug: "side",
      directory: "/workspace",
      path: "/workspace",
      title: taskType === "fork" ? "Fork of parent" : "Selection side chat",
      titleSource: "generated",
      version: "1",
      time: { created: 1, updated: 1 },
    } as never);
    // A side chat resumes with the copied parent history, so its turn counter is not zero.
    internal.turnNumber = 6;
    return harness;
  }

  it("generates a title from the first question and settles", async () => {
    const { runtime, store, titleRequests, internal } = await createSideChat(
      ["title"],
      "selection_side_chat",
    );
    expect(
      maybeStartSessionTitleGeneration.call(
        internal,
        "what does this function return?",
        "m1" as never,
        runtime.rootTraceContext,
      ),
    ).toBe(true);
    await expect.poll(() => titleOf(store, runtime)).toBe("Title 1");
    expect(titleRequests).toHaveLength(1);

    expect(
      maybeStartSessionTitleGeneration.call(
        internal,
        "and what about the error case?",
        "m2" as never,
        runtime.rootTraceContext,
      ),
    ).toBe(false);
  });

  it("keeps a side chat title that is no longer the placeholder", async () => {
    const { runtime, store, titleRequests, internal } = await createSideChat(
      ["title"],
      "selection_side_chat",
    );
    // A title written by the sidecar always records the message it came from.
    await store.updateSession({
      id: runtime.sessionId,
      title: "Already named",
      titleMessageID: "m0" as never,
    });
    maybeStartSessionTitleGeneration.call(
      internal,
      "what does this function return?",
      "m1" as never,
      runtime.rootTraceContext,
    );
    await expect.poll(() => internal.sessionTitleGenerationSettled).toBe(true);
    expect(titleRequests).toHaveLength(0);
    expect(await titleOf(store, runtime)).toBe("Already named");
  });

  it("never titles forks", async () => {
    const { runtime, titleRequests, internal } = await createSideChat(["title"], "fork");
    expect(
      maybeStartSessionTitleGeneration.call(
        internal,
        "what does this function return?",
        "m1" as never,
        runtime.rootTraceContext,
      ),
    ).toBe(false);
    expect(titleRequests).toHaveLength(0);
  });

  it("settles when the stored session is a fork although the runtime config looks interactive", async () => {
    const harness = setup("fork-by-store", ["title"]);
    await harness.store.createSession({
      id: harness.runtime.sessionId,
      projectID: "p" as never,
      parentID: createSessionId("parent"),
      taskType: "fork",
      slug: "f",
      directory: "/workspace",
      path: "/workspace",
      title: "Fork of parent",
      titleSource: "generated",
      version: "1",
      time: { created: 1, updated: 1 },
    } as never);
    harness.internal.turnNumber = 3;
    maybeStartSessionTitleGeneration.call(
      harness.internal,
      "what does this function return?",
      "m1" as never,
      harness.runtime.rootTraceContext,
    );
    await expect.poll(() => harness.internal.sessionTitleGenerationSettled).toBe(true);
    expect(harness.titleRequests).toHaveLength(0);
  });

  it("never titles subagent children", async () => {
    const { runtime, internal } = setup("subagent-title", [], {
      taskType: "subagent_child",
      parentSessionId: createSessionId("parent"),
    });
    expect(
      maybeStartSessionTitleGeneration.call(
        internal,
        "investigate the failing build please",
        "m1" as never,
        runtime.rootTraceContext,
      ),
    ).toBe(false);
  });
});
