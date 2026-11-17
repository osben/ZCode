// Fork: the Node helper's MCP pipe (specs/fork-rust-node-helper.md F3, "Helper connection"). A queued
// notification waits for the handler before it to complete, so pipe traffic and its cancels must
// bypass the serial queue.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import {
  FORK_RUST_HELPER_BROWSER_CHILD_SESSION,
  FORK_RUST_HELPER_BROWSER_CHILD_SESSION_END,
  FORK_RUST_HELPER_TURN_ENDED,
} from "../../src/fork-rust-helper/browser-control.js";
import { isConcurrent } from "../../src/fork-rust-helper/runtime.js";
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
  return { input, output, seen, release, connection };
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

  // Rust's timeout rule pings the helper while a request is overdue (spec "Per-method timeouts"): a ping
  // queued behind that request would time out and get a live helper killed.
  it("answers helper/ping while a serial request is still running", async () => {
    const link = connect(isConcurrent);
    const answers: unknown[] = [];
    link.output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) answers.push(JSON.parse(line));
    });
    link.input.write(frame({ id: 1, method: "plugins/install", params: {} }));
    link.input.write(frame({ id: 2, method: "helper/ping", params: {} }));
    // The install is still blocked on `slow` here.
    await vi.waitFor(() => expect(answers).toEqual([expect.objectContaining({ id: 2 })]));
    link.release();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    link.input.end();
    await link.connection.waitForClose();
  });

  // Rust awaits childSession with the open timeout before session/open, and sends childSessionEnd and turn/ended
  // before session/close. Behind a queued plugin install those would wait for the install (F4b, F4-D5).
  it("lets the F4b session-lifecycle methods bypass the serial queue", () => {
    for (const method of [
      FORK_RUST_HELPER_BROWSER_CHILD_SESSION,
      FORK_RUST_HELPER_BROWSER_CHILD_SESSION_END,
      FORK_RUST_HELPER_TURN_ENDED,
    ]) {
      expect(isConcurrent({ jsonrpc: "2.0", id: 1, method, params: {} } as ZCodeProtocolMessage)).toBe(true);
    }
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
