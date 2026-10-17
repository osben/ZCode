/**
 * Frame observer contract (specs/acp-agent-runtime.md): raw NDJSON lines per
 * direction in wire order, 16 KiB truncation with a marker, observer
 * isolation.
 */
import { describe, expect, it } from "vitest";
import type { AcpRawFrame } from "../src/index.js";
import { FRAME_OBSERVER_MAX_BYTES, FRAME_OBSERVER_TRUNCATION_MARKER } from "../src/transport.js";
import { cleanupTempDir, createTempDir, startMockRuntime } from "./helpers.js";

describe("onFrame observer", () => {
  it("captures raw NDJSON lines in both directions in wire order", async () => {
    const cwd = await createTempDir();
    const frames: AcpRawFrame[] = [];
    const runtime = await startMockRuntime(
      cwd,
      "echo",
      {},
      {
        onFrame: (frame) => frames.push(frame),
      },
    );
    try {
      const response = await runtime.prompt("hello");
      expect(response.stopReason).toBe("end_turn");
      const outbound = frames.filter((frame) => frame.direction === "outbound");
      const inbound = frames.filter((frame) => frame.direction === "inbound");
      // Handshake and prompt request, in wire order.
      const initIdx = outbound.findIndex((frame) => frame.text.includes('"initialize"'));
      const newIdx = outbound.findIndex((frame) => frame.text.includes('"session/new"'));
      const promptIdx = outbound.findIndex((frame) => frame.text.includes('"session/prompt"'));
      expect(initIdx).toBeGreaterThanOrEqual(0);
      expect(newIdx).toBeGreaterThan(initIdx);
      expect(promptIdx).toBeGreaterThan(newIdx);
      expect(outbound.some((frame) => frame.text.includes("hello"))).toBe(true);
      // Initialize response, session/update notification, prompt response.
      expect(inbound.some((frame) => frame.text.includes('"protocolVersion"'))).toBe(true);
      expect(inbound.some((frame) => frame.text.includes('"agent_message_chunk"'))).toBe(true);
      expect(inbound.some((frame) => frame.text.includes('"end_turn"'))).toBe(true);
      expect(frames.every((frame) => !frame.truncated)).toBe(true);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("truncates observed lines over 16 KiB with a marker in both directions", async () => {
    const cwd = await createTempDir();
    const frames: AcpRawFrame[] = [];
    const runtime = await startMockRuntime(
      cwd,
      "echo",
      {},
      {
        onFrame: (frame) => frames.push(frame),
      },
    );
    try {
      await runtime.prompt("x".repeat(40_000));
      // The prompt request (outbound) and the echo notification (inbound) both
      // exceed the observer cap and must be truncated to it, marker appended.
      for (const direction of ["outbound", "inbound"] as const) {
        const truncated = frames.find((frame) => frame.truncated && frame.direction === direction);
        expect(truncated, direction).toBeDefined();
        expect(truncated?.text.endsWith(FRAME_OBSERVER_TRUNCATION_MARKER)).toBe(true);
        expect(truncated?.text.length).toBe(
          FRAME_OBSERVER_MAX_BYTES + FRAME_OBSERVER_TRUNCATION_MARKER.length,
        );
      }
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("keeps the runtime working when the observer throws on every frame", async () => {
    const cwd = await createTempDir();
    let observed = 0;
    const runtime = await startMockRuntime(
      cwd,
      "echo",
      {},
      {
        onFrame: () => {
          observed += 1;
          throw new Error("observer boom");
        },
      },
    );
    try {
      const first = await runtime.prompt("hello");
      expect(first.stopReason).toBe("end_turn");
      const second = await runtime.prompt("again");
      expect(second.stopReason).toBe("end_turn");
      expect(observed).toBeGreaterThan(0);
      expect(runtime.state).toBe("ready");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });
});
