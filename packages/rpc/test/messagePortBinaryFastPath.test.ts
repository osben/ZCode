import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MessagePortProtocol,
  type MessagePortLike,
  type MessagePortPayload,
} from "../src/protocol.js";

// specs/rpc-messageport-binary-fast-path.md: Object.keys on a Uint8Array allocates one string per
// byte, so the control-object check must never enumerate binary payloads.

class LoopbackPort implements MessagePortLike {
  private readonly listeners = new Set<(event: { data: MessagePortPayload }) => void>();
  addEventListener(_type: "message", listener: (event: { data: MessagePortPayload }) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: { data: MessagePortPayload }) => void) {
    this.listeners.delete(listener);
  }
  postMessage(): void {}
  emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data: data as MessagePortPayload });
  }
  start(): void {}
  close(): void {}
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MessagePortProtocol binary fast path", () => {
  it("delivers a large binary payload without enumerating its keys", () => {
    const port = new LoopbackPort();
    const protocol = new MessagePortProtocol(port);
    const received: number[] = [];
    protocol.onMessage((message) => received.push(message.byteLength));
    const payload = new Uint8Array(256 * 1024).fill(7);
    const keys = vi.spyOn(Object, "keys");

    port.emit(payload);

    expect(keys.mock.calls.some(([target]) => target === payload)).toBe(false);
    expect(received).toEqual([payload.byteLength]);
    protocol.disconnect();
  });

  it("keeps control-object semantics", () => {
    const port = new LoopbackPort();
    const protocol = new MessagePortProtocol(port);
    const flow: string[] = [];
    const binary: number[] = [];
    protocol.onFlowState((state) => flow.push(state));
    protocol.onMessage((message) => binary.push(message.byteLength));

    port.emit({ __zcodeRpcControl: "connection-flow-v1", state: "drained" });
    port.emit({ __zcodeRpcControl: "connection-flow-v1", state: "forged" });
    port.emit({ __zcodeRpcControl: "connection-flow-v1", state: "saturated", extra: true });
    port.emit({ hello: "world" });

    expect(flow).toEqual(["drained"]);
    expect(binary).toEqual([]);
    protocol.disconnect();
  });
});
