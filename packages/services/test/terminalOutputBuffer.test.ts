import { describe, expect, it } from "vitest";

import {
  createBufferedTerminalOutputEmitter,
  TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS,
} from "../src/terminal/terminalService.js";

describe("createBufferedTerminalOutputEmitter", () => {
  it("replays output emitted before the first subscriber, in order", () => {
    const output = createBufferedTerminalOutputEmitter();
    output.push("prompt$ ");
    output.push("ls\r\n");

    const received: string[] = [];
    output.emitter.event((data) => received.push(data));

    expect(received).toEqual(["prompt$ ", "ls\r\n"]);
  });

  it("delivers live output directly once a subscriber is attached", () => {
    const output = createBufferedTerminalOutputEmitter();
    const received: string[] = [];
    output.emitter.event((data) => received.push(data));

    output.push("live");

    expect(received).toEqual(["live"]);
  });

  it("buffers output while detached and replays it on re-subscription", () => {
    const output = createBufferedTerminalOutputEmitter();
    const first: string[] = [];
    const subscription = output.emitter.event((data) => first.push(data));
    output.push("a");
    subscription.dispose();

    output.push("b");
    const second: string[] = [];
    output.emitter.event((data) => second.push(data));

    expect(first).toEqual(["a"]);
    expect(second).toEqual(["b"]);
  });

  it("drops the oldest chunks once the unsubscribed buffer exceeds its cap", () => {
    const output = createBufferedTerminalOutputEmitter();
    const chunkSize = 1024;
    const chunk = "x".repeat(chunkSize);
    const chunkCount = TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS / chunkSize + 2;
    for (let index = 0; index < chunkCount; index += 1) {
      output.push(`${index}:${chunk}`);
    }

    const received: string[] = [];
    output.emitter.event((data) => received.push(data));

    expect(received.length).toBeLessThan(chunkCount);
    expect(received[received.length - 1]).toBe(`${chunkCount - 1}:${chunk}`);
    const replayedChars = received.reduce((total, data) => total + data.length, 0);
    expect(replayedChars).toBeLessThanOrEqual(TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS);
  });
});
