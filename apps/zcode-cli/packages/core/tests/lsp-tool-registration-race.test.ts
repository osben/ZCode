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

  it("holds the first request until the initial LSP availability check settles", async () => {
    const port = new HeldBackLspPort();
    const { runtime, requests } = createRaceRuntime(port);

    const turnOne = runtime.executeTurn("turn-one");
    // Let turn preparation run up to the tools step; no request may go out while the check is held.
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(0);

    port.releaseInstalled(true);
    await turnOne;
    await runtime.executeTurn("turn-two");

    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0] ?? "[]")).toContain("LSP");
    expect(requests[1]).toBe(requests[0]);
  });
});
