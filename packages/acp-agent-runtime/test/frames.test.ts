/**
 * Raw frame observer coverage: frames are captured in both directions for the
 * whole handshake and prompt, observer failures never break the session, and
 * oversized lines are truncated with a marker.
 */
import { describe, expect, it } from "vitest";
import type { AcpFrameEvent } from "../src/index.js";
import { cleanupTempDir, createTempDir, startMockRuntime } from "./helpers.js";

function parseFrameText(frame: AcpFrameEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(frame.text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

describe("raw frame observer", () => {
  it("captures outbound and inbound frames for the handshake and prompt", async () => {
    const cwd = await createTempDir();
    const frames: AcpFrameEvent[] = [];
    const runtime = await startMockRuntime(
      cwd,
      "normal",
      {},
      { onFrame: (frame) => frames.push(frame) },
    );
    try {
      const response = await runtime.prompt("hi");
      expect(response.stopReason).toBe("end_turn");

      const outMethods = frames
        .filter((frame) => frame.direction === "out")
        .map((frame) => parseFrameText(frame)?.method);
      expect(outMethods).toContain("initialize");
      expect(outMethods).toContain("session/new");
      expect(outMethods).toContain("session/prompt");

      const inboundText = frames
        .filter((frame) => frame.direction === "in")
        .map((frame) => frame.text)
        .join("\n");
      expect(inboundText).toContain("mock-session");
      expect(inboundText).toContain("hello");

      for (const frame of frames) {
        expect(Number.isFinite(frame.at)).toBe(true);
      }
      for (const frame of frames.filter((frame) => frame.direction === "out")) {
        expect(parseFrameText(frame)).not.toBeNull();
      }
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("keeps the session healthy when the observer throws", async () => {
    const cwd = await createTempDir();
    let observed = 0;
    const runtime = await startMockRuntime(
      cwd,
      "normal",
      {},
      {
        onFrame: () => {
          observed += 1;
          throw new Error("observer exploded");
        },
      },
    );
    try {
      const response = await runtime.prompt("still works");
      expect(response.stopReason).toBe("end_turn");
      expect(observed).toBeGreaterThan(0);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("truncates oversized inbound frames with a marker", async () => {
    const cwd = await createTempDir();
    const frames: AcpFrameEvent[] = [];
    const runtime = await startMockRuntime(
      cwd,
      "big",
      {},
      { onFrame: (frame) => frames.push(frame) },
    );
    try {
      const response = await runtime.prompt("big one");
      expect(response.stopReason).toBe("end_turn");
      const truncated = frames.filter((frame) => frame.text.includes("[truncated"));
      expect(truncated.length).toBeGreaterThan(0);
      expect(truncated.every((frame) => frame.direction === "in")).toBe(true);
      for (const frame of truncated) {
        expect(frame.text.length).toBeLessThan(24_000);
        expect(frame.text.endsWith("bytes]")).toBe(true);
      }
      // The untruncated parts of the oversized frame stay valid JSON prefixes:
      // the first kept chunk must start a JSON object.
      expect(truncated[0]?.text.startsWith("{")).toBe(true);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });
});
