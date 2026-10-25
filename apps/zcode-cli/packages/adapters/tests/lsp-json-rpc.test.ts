import { describe, expect, it } from "vitest";
import {
  encodeJsonRpcFrame,
  JsonRpcFrameDecoder,
  JsonRpcFramingError,
  type JsonRpcMessage,
} from "../src/lsp/json-rpc.js";

function frames(...messages: JsonRpcMessage[]): Buffer {
  return Buffer.concat(messages.map((message) => encodeJsonRpcFrame(message)));
}

const request = (id: number, method: string, params?: unknown): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("LSP JSON-RPC framing", () => {
  it("round-trips one message", () => {
    const decoder = new JsonRpcFrameDecoder();
    expect(decoder.push(encodeJsonRpcFrame(request(1, "initialize", { a: 1 })))).toEqual([
      request(1, "initialize", { a: 1 }),
    ]);
  });

  it("reassembles a message split at every byte boundary", () => {
    const wire = encodeJsonRpcFrame(request(7, "textDocument/hover", { text: "héllo 👋" }));
    const decoder = new JsonRpcFrameDecoder();
    const decoded: JsonRpcMessage[] = [];
    for (const byte of wire) {
      decoded.push(...decoder.push(Buffer.from([byte])));
    }
    expect(decoded).toEqual([request(7, "textDocument/hover", { text: "héllo 👋" })]);
  });

  it("returns several messages that arrive in one chunk", () => {
    const decoder = new JsonRpcFrameDecoder();
    const messages = decoder.push(
      frames(request(1, "a"), request(2, "b"), { jsonrpc: "2.0", method: "c" }),
    );
    expect(messages.map((message) => message.method)).toEqual(["a", "b", "c"]);
  });

  it("keeps a partial trailing frame until the rest arrives", () => {
    const first = encodeJsonRpcFrame(request(1, "one"));
    const second = encodeJsonRpcFrame(request(2, "two"));
    const decoder = new JsonRpcFrameDecoder();
    const cut = second.length - 3;
    const head = decoder.push(Buffer.concat([first, second.subarray(0, cut)]));
    expect(head.map((message) => message.method)).toEqual(["one"]);
    expect(decoder.push(second.subarray(cut)).map((message) => message.method)).toEqual(["two"]);
  });

  it("counts Content-Length in bytes, not characters", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "x", params: "ж€😀" });
    const byteLength = Buffer.byteLength(body, "utf8");
    expect(byteLength).toBeGreaterThan(body.length);
    const wire = Buffer.from(`Content-Length: ${byteLength}\r\n\r\n${body}`, "utf8");
    expect(new JsonRpcFrameDecoder().push(wire)).toEqual([
      { jsonrpc: "2.0", method: "x", params: "ж€😀" },
    ]);
  });

  it("accepts extra headers and any header-name case", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "y" });
    const wire = Buffer.from(
      `content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      "utf8",
    );
    expect(new JsonRpcFrameDecoder().push(wire)).toEqual([{ jsonrpc: "2.0", method: "y" }]);
  });

  it("rejects a header without Content-Length", () => {
    const wire = Buffer.from("X-Other: 1\r\n\r\n{}", "utf8");
    expect(() => new JsonRpcFrameDecoder().push(wire)).toThrow(JsonRpcFramingError);
  });

  it("rejects a header line without a colon", () => {
    const wire = Buffer.from("garbage line\r\nContent-Length: 2\r\n\r\n{}", "utf8");
    expect(() => new JsonRpcFrameDecoder().push(wire)).toThrow(JsonRpcFramingError);
  });

  it("rejects a non-numeric Content-Length", () => {
    const wire = Buffer.from("Content-Length: abc\r\n\r\n{}", "utf8");
    expect(() => new JsonRpcFrameDecoder().push(wire)).toThrow(/non-negative integer/u);
  });

  it("rejects a body that is not a JSON object", () => {
    const body = "[1,2]";
    const wire = Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`, "utf8");
    expect(() => new JsonRpcFrameDecoder().push(wire)).toThrow(/not a JSON object/u);
  });

  it("rejects a body that is not valid JSON", () => {
    const body = "{nope";
    const wire = Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`, "utf8");
    expect(() => new JsonRpcFrameDecoder().push(wire)).toThrow(/not valid JSON/u);
  });

  it("rejects an unterminated header that grows past the limit", () => {
    const decoder = new JsonRpcFrameDecoder();
    expect(() => decoder.push(Buffer.alloc(9_000, "a"))).toThrow(/exceeds/u);
  });
});
