import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMacLoginScript,
  createAcpAgentsBridge,
  createHostAcpAgentsBridge,
  formatLoginCommand,
  resolveE2eAcpAgentPath,
  type AcpAgentSummary,
  type AcpAgentsBridgeDependencies,
} from "../src/model-provider/acpAgents.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./fixtures/acp-mock-agent.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
const CRAFTED_COMMAND =
  "/usr/local/bin/opencode\nZCODE_ACP_LOGIN_BANNER\ntouch /tmp/zcode-acp-pwned";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env.ZCODE_ACP_TEST_TOKEN;
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-acp-bridge-test-"));
  tempDirs.push(dir);
  return dir;
}

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

// S6 readiness: ACP agents are macOS only, and a Test roundtrip records the offered options (the catalog).
describe("ACP agents bridge platform scope and catalog", () => {
  it("reports unsupported and spawns nothing outside macOS", async () => {
    const detectAgents = vi.fn(async () => [mockSummary()]);
    const bridge = createAcpAgentsBridge({ detectAgents, platform: "linux" });

    const result = await bridge.detect();

    expect(result).toMatchObject({ supported: false, agents: [] });
    expect(detectAgents).not.toHaveBeenCalled();
    const roundtrip = await bridge.test({ command: process.execPath, args: [MOCK_AGENT_PATH] });
    expect(roundtrip.ok).toBe(false);
    expect(roundtrip.error?.message).toContain("macOS");
    expect(roundtrip.frames).toEqual([]);
  });

  it("is not wired on non-macOS development hosts", () => {
    const env = { ZCODE_RUNTIME_ENV: "development" };
    expect(createHostAcpAgentsBridge(env, { platform: "linux" })).toBeUndefined();
    expect(createHostAcpAgentsBridge(env, { platform: "win32" })).toBeUndefined();
    expect(createHostAcpAgentsBridge(env, { platform: "darwin" })).toBeDefined();
  });

  it("records the options a handshake offered for a known agent", async () => {
    const recordCatalog = vi.fn(async () => true);
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => []),
      platform: "darwin",
      recordCatalog,
    });

    const result = await bridge.test({
      agentId: "opencode",
      command: process.execPath,
      args: [MOCK_AGENT_PATH, "--config", "options"],
    });

    expect(result.ok).toBe(true);
    expect(recordCatalog).toHaveBeenCalledTimes(1);
    const [agentId, options] = recordCatalog.mock.calls[0] as unknown as [
      string,
      Array<{ id: string }>,
    ];
    expect(agentId).toBe("opencode");
    expect(options.map((option) => option.id)).toEqual(["mode", "model"]);
  });

  it("reads the stored catalog on macOS and reports unsupported elsewhere", async () => {
    const options = [
      {
        id: "mode",
        name: "Mode",
        description: null,
        category: "mode",
        currentValue: "agent",
        options: [{ value: "plan", name: "Plan", description: null, group: null }],
      },
    ];
    const readCatalog = vi.fn(async (agentId: string) =>
      agentId === "opencode" ? options : undefined,
    );
    const mac = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => []),
      platform: "darwin",
      readCatalog,
    });

    expect(await mac.catalog({ agentId: "opencode" })).toEqual({ supported: true, options });
    expect(await mac.catalog({ agentId: "cursor" })).toEqual({ supported: true });

    const linux = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => []),
      platform: "linux",
      readCatalog,
    });
    expect(await linux.catalog({ agentId: "opencode" })).toEqual({ supported: false });
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });

  it("does not record a catalog for a custom command, and a failing store never fails the test", async () => {
    const recordCatalog = vi.fn(async () => {
      throw new Error("disk full");
    });
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => []),
      platform: "darwin",
      recordCatalog,
    });

    const custom = await bridge.test({
      command: process.execPath,
      args: [MOCK_AGENT_PATH, "--config", "options"],
    });
    expect(custom.ok).toBe(true);
    expect(recordCatalog).not.toHaveBeenCalled();

    const known = await bridge.test({
      agentId: "opencode",
      command: process.execPath,
      args: [MOCK_AGENT_PATH, "--config", "options"],
    });
    expect(known.ok).toBe(true);
    expect(recordCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("ACP agents bridge hardening", () => {
  it("rejects a crafted login command before any terminal opens", async () => {
    const openTerminal = vi.fn(async () => ({ opened: true }));
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => [mockSummary()]),
      openTerminal,
    });

    const result = await bridge.startLogin({ agentId: "opencode", command: CRAFTED_COMMAND });

    expect(result.opened).toBe(false);
    expect(result.error).toMatch(/CR or LF/);
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it("rejects a crafted status command without running it", async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, output: "" }));
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => [mockSummary()]),
      runCommand,
    });

    const report = await bridge.status({ agentId: "opencode", command: CRAFTED_COMMAND });

    expect(report.error).toMatch(/CR or LF/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects loader env overrides, line breaks and oversized args in the smoke test", async () => {
    const startRuntime = vi.fn();
    const makeSandboxDir = vi.fn(async () => "/tmp/unused");
    const bridge = createAcpAgentsBridge({
      detectAgents: vi.fn(async () => []),
      startRuntime: startRuntime as unknown as AcpAgentsBridgeDependencies["startRuntime"],
      makeSandboxDir,
    });

    for (const input of [
      { command: process.execPath, args: [MOCK_AGENT_PATH], env: { LD_PRELOAD: "/tmp/x.so" } },
      { command: process.execPath, args: [MOCK_AGENT_PATH], env: { DYLD_INSERT_LIBRARIES: "/x" } },
      { command: process.execPath, args: [MOCK_AGENT_PATH], env: { NODE_OPTIONS: "-r /x.js" } },
      { command: `${process.execPath}\nid`, args: [MOCK_AGENT_PATH] },
      { command: process.execPath, args: Array.from({ length: 33 }, () => "a") },
    ]) {
      const result = await bridge.test(input);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/Invalid ACP launch/);
    }
    expect(startRuntime).not.toHaveBeenCalled();
    expect(makeSandboxDir).not.toHaveBeenCalled();
  });

  it("builds a login script without a heredoc that prints and runs the command literally", async () => {
    const dir = await makeTempDir();
    const marker = join(dir, "marker");
    const commandLine = formatLoginCommand("/bin/echo", [`it's $(touch ${marker})`], "darwin");
    const script = buildMacLoginScript(commandLine);
    expect(script).not.toContain("<<");
    expect(script.split("\n")[1]).toMatch(/^printf '%s\\n' '/);
    expect(() => buildMacLoginScript("opencode\nid")).toThrow(/CR or LF/);

    // The script removes its own directory, so run it from a dedicated subdirectory.
    const scriptDir = await mkdtemp(join(dir, "script-"));
    const scriptPath = join(scriptDir, "login.command");
    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o755);
    const { stdout } = await execFileAsync("/bin/sh", [scriptPath]);

    expect(stdout).toContain(`[ZCode] Running: ${commandLine}`);
    expect(stdout).toContain(`it's $(touch ${marker})`);
    expect(await readdir(dir)).not.toContain("marker");
  });

  it("runs the status command with the scrubbed child environment", async () => {
    const dir = await makeTempDir();
    const scriptPath = join(dir, "opencode");
    await writeFile(
      scriptPath,
      '#!/bin/sh\necho "token=${ZCODE_ACP_TEST_TOKEN:-absent} path=${PATH:+set}"\n',
      "utf8",
    );
    await chmod(scriptPath, 0o755);
    process.env.ZCODE_ACP_TEST_TOKEN = "leaked-secret";
    const bridge = createAcpAgentsBridge({ detectAgents: vi.fn(async () => []) });

    const report = await bridge.status({ agentId: "opencode", command: scriptPath });

    expect(report.exitCode).toBe(0);
    expect(report.output).toBe("token=absent path=set");
  });

  it("wires the bridge only in development host runtimes", () => {
    expect(createHostAcpAgentsBridge({ ZCODE_RUNTIME_ENV: "development" })).toBeDefined();
    expect(createHostAcpAgentsBridge({ ZCODE_RUNTIME_ENV: "production" })).toBeUndefined();
    expect(createHostAcpAgentsBridge({ ZCODE_RUNTIME_ENV: "test" })).toBeUndefined();
    // NODE_ENV leaks from user shells and never enables the gate.
    expect(createHostAcpAgentsBridge({ NODE_ENV: "development" })).toBeUndefined();
    expect(createHostAcpAgentsBridge({})).toBeUndefined();
  });

  it("honors the E2E detection path only in a development host running ZCODE_ENV=test", () => {
    const dir = "/tmp/zcode-e2e-acp-bin";
    const seam = { ZCODE_E2E_ACP_AGENT_PATH: dir };
    expect(
      resolveE2eAcpAgentPath({ ...seam, ZCODE_RUNTIME_ENV: "development", ZCODE_ENV: "test" }),
    ).toBe(dir);
    expect(
      resolveE2eAcpAgentPath({
        ...seam,
        ZCODE_RUNTIME_ENV: "development",
        ZCODE_ENV: "production",
      }),
    ).toBeUndefined();
    expect(resolveE2eAcpAgentPath({ ...seam, ZCODE_RUNTIME_ENV: "development" })).toBeUndefined();
    // A packaged host runs as production: the seam stays closed even with ZCODE_ENV=test.
    expect(
      resolveE2eAcpAgentPath({ ...seam, ZCODE_RUNTIME_ENV: "production", ZCODE_ENV: "test" }),
    ).toBeUndefined();
    expect(
      resolveE2eAcpAgentPath({ ZCODE_RUNTIME_ENV: "development", ZCODE_ENV: "test" }),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "replaces only the detection PATH with the E2E seam directory",
    async () => {
      const dir = await makeTempDir();
      const shim = join(dir, "opencode");
      await writeFile(shim, "#!/bin/sh\necho 9.9.9-e2e\n", "utf8");
      await chmod(shim, 0o755);
      const env = {
        PATH: process.env.PATH,
        ZCODE_RUNTIME_ENV: "development",
        ZCODE_E2E_ACP_AGENT_PATH: dir,
      };

      const seamed = await createHostAcpAgentsBridge({ ...env, ZCODE_ENV: "test" })!.detect({
        refresh: true,
      });
      const opencode = seamed.agents.find((agent) => agent.agentId === "opencode");
      expect(opencode).toMatchObject({ installed: true, commandPath: shim, version: "9.9.9-e2e" });
      expect(seamed.agents.find((agent) => agent.agentId === "cursor")?.installed).toBe(false);

      const ignored = await createHostAcpAgentsBridge({ ...env, ZCODE_ENV: "production" })!.detect({
        refresh: true,
      });
      expect(ignored.agents.find((agent) => agent.agentId === "opencode")?.commandPath).not.toBe(
        shim,
      );
    },
  );
});
