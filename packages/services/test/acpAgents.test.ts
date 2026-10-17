import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createAcpAgentsBridge,
  formatLoginCommand,
  type AcpAgentSummary,
  type AcpAgentsBridgeDependencies,
} from "../src/model-provider/acpAgents.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./fixtures/acp-mock-agent.mjs", import.meta.url));

const mockSummary = (overrides: Partial<AcpAgentSummary> = {}): AcpAgentSummary => ({
  agentId: "opencode",
  displayName: "opencode",
  installed: true,
  version: "1.0.0",
  commandPath: "/usr/local/bin/opencode",
  spawnArgs: ["acp"],
  loginArgs: ["auth", "login"],
  statusArgs: ["auth", "list"],
  ...overrides,
});

describe("ACP agents bridge", () => {
  it("passes refresh through to detection", async () => {
    const detectAgents = vi.fn(async () => [mockSummary()]);
    const bridge = createAcpAgentsBridge({ detectAgents });

    const result = await bridge.detect({ refresh: true });

    expect(result.supported).toBe(true);
    expect(result.agents).toHaveLength(1);
    expect(Number.isFinite(result.detectedAt)).toBe(true);
    expect(detectAgents).toHaveBeenCalledWith({ refresh: true });
  });

  it("rejects unknown agent ids without spawning anything", async () => {
    const startRuntime = vi.fn();
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => []),
      startRuntime: startRuntime as unknown as AcpAgentsBridgeDependencies["startRuntime"],
    });

    const result = await bridge.test({ agentId: "nope" });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Unknown ACP agent");
    expect(result.frames).toEqual([]);
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it("runs a full roundtrip against the mock agent and captures both directions", async () => {
    const bridge = createAcpAgentsBridge({ detectAgents: vi.fn(async () => []) });

    const result = await bridge.test({ command: process.execPath, args: [MOCK_AGENT_PATH] });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.framesDropped).toBe(0);
    const outText = result.frames
      .filter((frame) => frame.direction === "out")
      .map((frame) => frame.text)
      .join("\n");
    const inText = result.frames
      .filter((frame) => frame.direction === "in")
      .map((frame) => frame.text)
      .join("\n");
    expect(outText).toContain('"initialize"');
    expect(outText).toContain('"session/new"');
    expect(outText).toContain('"session/prompt"');
    expect(inText).toContain("services-mock-session");
    expect(inText).toContain("pong");
  });

  it("reports spawn failures honestly", async () => {
    const bridge = createAcpAgentsBridge({ detectAgents: vi.fn(async () => []) });

    const result = await bridge.test({ command: "/definitely/missing/zcode-acp-binary" });

    expect(result.ok).toBe(false);
    expect(result.error?.message.length).toBeGreaterThan(0);
  });

  it("status uses the definition's status args and returns command output", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      output: "✓ Logged in as test@example.com",
    }));
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => [mockSummary()]),
      runCommand,
    });

    const report = await bridge.status({ agentId: "opencode" });

    expect(report).toEqual({
      supported: true,
      exitCode: 0,
      output: "✓ Logged in as test@example.com",
    });
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/local/bin/opencode",
      ["auth", "list"],
      expect.any(Number),
    );
  });

  it("status reports unsupported for unknown agents", async () => {
    const bridge = createAcpAgentsBridge({ detectAgents: vi.fn(async () => []) });

    const report = await bridge.status({ agentId: "who" });

    expect(report.supported).toBe(false);
  });

  it("startLogin quotes paths with spaces and delegates to the terminal opener", async () => {
    const openTerminal = vi.fn(async () => ({ opened: true }));
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => [
        mockSummary({
          agentId: "cursor",
          displayName: "Cursor",
          commandPath: "/Applications/Cursor Agent/bin/cursor-agent",
          loginArgs: ["login"],
          statusArgs: ["status"],
        }),
      ]),
      openTerminal,
    });

    const result = await bridge.startLogin({ agentId: "cursor" });

    expect(result.opened).toBe(true);
    expect(result.command).toBe("'/Applications/Cursor Agent/bin/cursor-agent' login");
    expect(openTerminal).toHaveBeenCalledWith(
      "'/Applications/Cursor Agent/bin/cursor-agent' login",
    );
  });

  it("uses the configured command override for status and login", async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, output: "ok" }));
    const openTerminal = vi.fn(async () => ({ opened: true }));
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => [mockSummary()]),
      runCommand,
      openTerminal,
    });

    await bridge.status({ agentId: "opencode", command: "/custom/opencode" });
    expect(runCommand).toHaveBeenCalledWith(
      "/custom/opencode",
      ["auth", "list"],
      expect.any(Number),
    );

    await bridge.startLogin({ agentId: "opencode", command: "/custom/opencode" });
    expect(openTerminal).toHaveBeenCalledWith("/custom/opencode auth login");
  });

  it("formats manual login commands per platform", () => {
    expect(formatLoginCommand("/usr/local/bin/opencode", ["auth", "login"], "darwin")).toBe(
      "/usr/local/bin/opencode auth login",
    );
    expect(
      formatLoginCommand("/Applications/Cursor Agent/bin/cursor-agent", ["login"], "darwin"),
    ).toBe("'/Applications/Cursor Agent/bin/cursor-agent' login");
    expect(
      formatLoginCommand("C:\\Program Files\\Opencode\\opencode.exe", ["auth", "login"], "win32"),
    ).toBe("& 'C:\\Program Files\\Opencode\\opencode.exe' auth login");
  });
});
