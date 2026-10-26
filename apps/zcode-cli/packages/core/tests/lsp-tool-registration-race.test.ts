import { describe, expect, it } from "vitest";
import { createSessionId, type ModelRequest } from "@zcode/contracts";
import { createLspService } from "../src/lsp/index.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import {
  FakeLanguageServerPort,
  LSP_KEY,
  MemoryFileSystem,
  makePreferences,
  makeServer,
} from "./lsp-fakes.js";

// specs/prompt-cache-stability.md, "Known violation": agent-runtime.ts:373 fires
// `void runtime.applyLspPreferences()` without awaiting it. When the LSP availability check
// (LspService.isAvailable -> port.isInstalled, core/src/runtime/methods/lsp.ts:23-42) resolves
// after the first model request was already sent, the LSP tool joins the registry mid-session and
// the tools array — part of the model-visible prefix — changes between request 1 and request 2.

/** Holds `isInstalled` back until the test releases it, modeling a slow binary lookup. */
class HeldBackLspPort extends FakeLanguageServerPort {
  private readonly heldAvailability = Promise.withResolvers<boolean>();

  override isInstalled(): Promise<boolean> {
    return this.heldAvailability.promise;
  }

  releaseInstalled(installed: boolean): void {
    this.heldAvailability.resolve(installed);
  }
}

function createRaceRuntime(port: HeldBackLspPort): {
  runtime: ReturnType<typeof createTestAgentRuntime>;
  requests: string[];
} {
  const requests: string[] = [];
  const service = createLspService({
    port,
    servers: [makeServer()],
    key: LSP_KEY,
    fileSystem: new MemoryFileSystem().asPort(),
    getPreferences: () => makePreferences(),
  });
  const runtime = createTestAgentRuntime(
    createSessionId("lsp-tool-registration-race"),
    {
      titleGeneration: { enabled: false },
      workingDirectory: "/workspace",
    },
    {
      eventStore: createTestSessionEventStore(),
      lsp: service,
      modelFactory: createTestModelFactory({
        async generateText(request: ModelRequest) {
          // Captured at call time: a later registry change must show up as a captured difference.
          requests.push(JSON.stringify((request.tools ?? []).map((tool) => tool.name)));
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

describe("LSP tool registration race", () => {
  it("registers the LSP tool once the held availability check resolves", async () => {
    const port = new HeldBackLspPort();
    const { runtime } = createRaceRuntime(port);
    expect(runtime.getToolRegistry().has("LSP")).toBe(false);

    port.releaseInstalled(true);
    await runtime.applyLspPreferences();
    expect(runtime.getToolRegistry().has("LSP")).toBe(true);
  });

  // reproduces LSP late-registration race; fix pending
  it.fails("sends an equal tool list when LSP availability settles after turn 1 starts", async () => {
    const port = new HeldBackLspPort();
    const { runtime, requests } = createRaceRuntime(port);

    await runtime.executeTurn("turn-one");
    expect(requests).toHaveLength(1);
    // The held check settles after turn 1's request went out; the LSP tool registers afterwards.
    port.releaseInstalled(true);
    await runtime.applyLspPreferences();
    await runtime.executeTurn("turn-two");

    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
  });
});
