// Fork: the Node helper's MCP pipe (specs/fork-rust-node-helper.md F3, "Helper connection"). A queued
// notification waits for the handler before it to complete, so pipe traffic and its cancels must
// bypass the serial queue.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolNdjsonConnection } from "../../src/zcode-protocol/transport.js";

const frame = (message: unknown) => `${JSON.stringify(message)}\n`;

function connect(isConcurrent?: (message: ZCodeProtocolMessage) => boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    ...(isConcurrent ? { isConcurrent } : {}),
    handleMessage: async (message) => {
      if (!("method" in message)) return undefined;
      seen.push(message.method);
      if (message.method === "plugins/install") await slow;
      return "id" in message ? { id: message.id, result: {} } : undefined;
    },
  });
  connection.start();
  return { input, seen, release, connection };
}

describe("fork: concurrent messages on the protocol connection", () => {
  it("handles a concurrent notification while a serial request is still running", async () => {
    const link = connect((message) => "method" in message && message.method.startsWith("helper/mcp/"));
    link.input.write(frame({ id: 1, method: "plugins/install", params: {} }));
    link.input.write(frame({ method: "helper/mcp/send", params: { connection: "c1" } }));
    // The install is still blocked on `slow` here.
    await vi.waitFor(() =>
      expect([...link.seen].sort()).toEqual(["helper/mcp/send", "plugins/install"]),
    );
    link.release();
    link.input.end();
    await link.connection.waitForClose();
  });

  it("keeps the serial order for messages the option does not name", async () => {
    const link = connect();
    link.input.write(frame({ id: 1, method: "plugins/install", params: {} }));
    link.input.write(frame({ method: "helper/mcp/send", params: { connection: "c1" } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(link.seen).toEqual(["plugins/install"]);
    link.release();
    await vi.waitFor(() => expect(link.seen).toEqual(["plugins/install", "helper/mcp/send"]));
    link.input.end();
    await link.connection.waitForClose();
  });
});
