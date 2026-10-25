import { describe, expect, it } from "vitest";
import { AcpSessionRuntime, type AcpAuthMethod } from "../src/index.js";
import { cleanupTempDir, collectEvents, createTempDir, startMockRuntime } from "./helpers.js";

describe("startup and handshake", () => {
  it("fails with ACP_SPAWN_FAILED when the binary does not exist", async () => {
    const cwd = await createTempDir();
    try {
      await expect(
        AcpSessionRuntime.start(
          {
            agentId: "ghost",
            command: "no-such-binary-xyz-acp",
            args: [],
            cwd,
            timeouts: { stopGraceMs: 500, killGraceMs: 500 },
          },
          {},
        ),
      ).rejects.toMatchObject({ code: "ACP_SPAWN_FAILED" });
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("fails with ACP_PROTOCOL_VERSION on a version mismatch", async () => {
    const cwd = await createTempDir();
    try {
      await expect(startMockRuntime(cwd, "protocol-version")).rejects.toMatchObject({
        code: "ACP_PROTOCOL_VERSION",
      });
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("propagates a session/new failure", async () => {
    const cwd = await createTempDir();
    try {
      await expect(startMockRuntime(cwd, "new-fails")).rejects.toThrowError();
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("surfaces advertised auth methods through the bridge", async () => {
    const cwd = await createTempDir();
    const seen: AcpAuthMethod[][] = [];
    const runtime = await startMockRuntime(cwd, "auth", {
      onAuthMethods: (methods) => {
        seen.push([...methods]);
      },
    });
    try {
      expect(seen).toHaveLength(1);
      expect(seen[0]?.[0]?.id).toBe("mock-login");
      expect(runtime.acpAuthMethods[0]?.name).toBe("Mock Login");
      const response = await runtime.prompt("hi");
      expect(response.stopReason).toBe("end_turn");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("passes explicit env overrides to the child process", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "env", {}, { env: { MOCK_MARKER: "42" } });
    try {
      const events = collectEvents(runtime);
      await runtime.prompt("env");
      expect(events).toContainEqual({ type: "message_chunk", text: "env:42" });
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("sends explicit content blocks to the agent", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "echo");
    try {
      const events = collectEvents(runtime);
      await runtime.prompt("ignored", [{ type: "text", text: "BLOCKS" }]);
      expect(events).toContainEqual({ type: "message_chunk", text: "got:BLOCKS" });
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });
});
