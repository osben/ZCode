import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { listeningAddress } from "./listeningAddress.js";
import { connectViaWebSocket } from "@zcode/client";
import { IQuickPromptService, ServiceCollection, type QuickPromptSnapshot } from "@zcode/services";
import { createHttpServer } from "../src/http.js";

// Spec: specs/composer-quick-prompts.md (rule 21, scenario 10). The Source Server /ws path serves web-remote-replayable
// clients, so mobile must see the controller's quick prompts read-only there too.

describe("standalone Web /ws quick prompts", () => {
  const sockets: WebSocket[] = [];
  const servers: ReturnType<typeof createHttpServer>[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reads quick prompts but rejects every mutation with quick-prompt.read-only", async () => {
    const snapshot: QuickPromptSnapshot = { project: null, globals: [], projectPrompts: [] };
    const quickPromptService = {
      read: vi.fn(async () => snapshot),
      readProjects: vi.fn(async () => []),
      create: vi.fn(async () => {
        throw new Error("create reached the service");
      }),
      delete: vi.fn(async () => undefined),
    };
    const server = createHttpServer(
      new ServiceCollection().register(IQuickPromptService, quickPromptService as never),
      0,
    );
    servers.push(server);
    const client = await connectViaWebSocket(
      `ws://127.0.0.1:${(await listeningAddress(server)).port}/ws`,
      { onOpenSocket: (socket) => sockets.push(socket) },
    );

    await expect(client.quickPromptService.read({ project: null })).resolves.toEqual(snapshot);
    await expect(
      client.quickPromptService.create({
        scope: "global",
        project: null,
        name: "x",
        body: { markdown: "x", nodes: "[]" },
        pinned: true,
      }),
    ).rejects.toThrow("quick-prompt.read-only");
    await expect(client.quickPromptService.delete({ promptId: "p1" })).rejects.toThrow(
      "quick-prompt.read-only",
    );
    expect(quickPromptService.create).not.toHaveBeenCalled();
    expect(quickPromptService.delete).not.toHaveBeenCalled();
  });
});
