/**
 * ACP agent bridge for Model Settings: detection of the agent CLIs installed
 * on the host, a full ACP roundtrip smoke test with raw NDJSON frame capture,
 * and login/status helpers for the settings UI.
 *
 * Everything here runs on the host that owns the workspace (the local desktop
 * host or a remote workspace host): the agent process is spawned there, with
 * the host's runtime environment, which the services assembly has already
 * enriched with the user's login-shell PATH.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_AGENT_DEFINITIONS,
  AcpSessionRuntime,
  detectAcpAgents,
  refreshAcpAgentCache,
  type AcpAgentDefinition,
  type AcpSessionRuntimeOptions,
} from "@zcode/acp-agent-runtime";
import type {
  AcpAgentDetectionResult,
  AcpAgentLoginResult,
  AcpAgentStatusReport,
  AcpAgentSummary,
  AcpAgentTestInput,
  AcpAgentTestResult,
  AcpFrameEvent,
  ProviderSettingsAcpAgentsBridge,
} from "./acpAgentsContract.js";

export type {
  AcpAgentDetectionResult,
  AcpAgentLoginResult,
  AcpAgentStatusReport,
  AcpAgentSummary,
  AcpAgentTestInput,
  AcpAgentTestResult,
  AcpFrameEvent,
  ProviderSettingsAcpAgentsBridge,
} from "./acpAgentsContract.js";

/** Structural subset of `AcpSessionRuntime` used by the smoke test (fake-friendly). */
export interface AcpTestRuntime {
  prompt(text: string): Promise<unknown>;
  cancel(): Promise<void>;
  stop(): Promise<void>;
  stderrTail(): string;
}

export interface AcpAgentsBridgeDependencies {
  /** Detection probe; defaults to the runtime registry against the host environment. */
  readonly detectAgents?: (input: {
    readonly refresh: boolean;
  }) => Promise<readonly AcpAgentSummary[]>;
  /** Runs a short non-interactive command; defaults to `spawn` with output caps. */
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ exitCode: number | null; output: string }>;
  /** Opens the user's terminal with the login command; defaults to Terminal.app on macOS. */
  readonly openTerminal?: (commandLine: string) => Promise<{ opened: boolean; error?: string }>;
  /** Runtime factory for the smoke test; defaults to `AcpSessionRuntime.start`. */
  readonly startRuntime?: (options: AcpSessionRuntimeOptions) => Promise<AcpTestRuntime>;
  /** Temp-dir factory for the smoke-test sandbox. */
  readonly makeSandboxDir?: () => Promise<string>;
}

const MAX_TEST_FRAMES = 400;
const MAX_TEST_FRAME_BYTES = 1024 * 1024;
const MAX_STATUS_OUTPUT_CHARS = 16 * 1024;
const STATUS_TIMEOUT_MS = 10_000;
const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

/** The smoke test allows slow agents to think, but stays bounded. */
const TEST_INITIALIZE_MS = 30_000;
const TEST_NEW_SESSION_MS = 30_000;
const TEST_PROMPT_MS = 60_000;
const TEST_CANCEL_GRACE_MS = 5_000;
const TEST_STOP_GRACE_MS = 2_000;
const TEST_KILL_GRACE_MS = 2_000;
const TEST_PROMPT_TEXT =
  "Reply with the single word: pong. Do not read, create, or modify any files.";

export function createAcpAgentsBridge(
  dependencies: AcpAgentsBridgeDependencies = {},
): ProviderSettingsAcpAgentsBridge {
  const detectAgents = dependencies.detectAgents ?? defaultDetectAgents;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const openTerminal = dependencies.openTerminal ?? defaultOpenTerminal;
  const startRuntime = dependencies.startRuntime ?? ((options) => AcpSessionRuntime.start(options));
  const makeSandboxDir =
    dependencies.makeSandboxDir ?? (() => mkdtemp(join(tmpdir(), "zcode-acp-test-")));

  const findDefinition = (agentId: string): AcpAgentDefinition | undefined =>
    ACP_AGENT_DEFINITIONS.find((definition) => definition.agentId === agentId);

  const resolveCommandPath = async (
    agentId: string,
    definition: AcpAgentDefinition | undefined,
  ): Promise<string> => {
    const detected = await detectAgents({ refresh: false });
    const commandPath = detected.find((agent) => agent.agentId === agentId)?.commandPath ?? null;
    return commandPath ?? definition?.binaries[0] ?? "";
  };

  return {
    async detect(input = {}) {
      const agents = await detectAgents({ refresh: input.refresh === true });
      return { supported: true, agents, detectedAt: Date.now() };
    },

    async test(input) {
      const startedAt = Date.now();
      const definition = input.agentId ? findDefinition(input.agentId) : undefined;
      if (input.agentId && !definition) {
        return {
          ok: false,
          error: { message: `Unknown ACP agent: ${input.agentId}` },
          frames: [],
          framesDropped: 0,
          durationMs: Date.now() - startedAt,
        };
      }
      let command = input.command?.trim() ?? "";
      if (!command && input.agentId) {
        command = await resolveCommandPath(input.agentId, definition);
      }
      if (!command) {
        return {
          ok: false,
          error: { message: "No command to test: pass an agentId or an explicit command." },
          frames: [],
          framesDropped: 0,
          durationMs: Date.now() - startedAt,
        };
      }
      const args = input.args ? [...input.args] : definition ? [...definition.spawnArgs] : [];

      const frames: AcpFrameEvent[] = [];
      let framesDropped = 0;
      let capturedBytes = 0;
      const onFrame = (frame: AcpFrameEvent): void => {
        if (frames.length >= MAX_TEST_FRAMES || capturedBytes >= MAX_TEST_FRAME_BYTES) {
          framesDropped += 1;
          return;
        }
        capturedBytes += frame.text.length;
        frames.push(frame);
      };

      const sandbox = await makeSandboxDir();
      let runtime: AcpTestRuntime | null = null;
      let stderrTail: string | undefined;
      let error: { message: string } | undefined;
      try {
        runtime = await startRuntime({
          agentId: input.agentId ?? definition?.agentId ?? "custom",
          command,
          args,
          cwd: sandbox,
          ...(input.env ? { env: input.env } : {}),
          timeouts: {
            initializeMs: TEST_INITIALIZE_MS,
            newSessionMs: TEST_NEW_SESSION_MS,
            cancelGraceMs: TEST_CANCEL_GRACE_MS,
            stopGraceMs: TEST_STOP_GRACE_MS,
            killGraceMs: TEST_KILL_GRACE_MS,
            stallWarningMs: 0,
          },
          onFrame,
        });
        let promptTimeout: NodeJS.Timeout | undefined;
        try {
          const promptPromise = runtime.prompt(TEST_PROMPT_TEXT);
          const timeoutPromise = new Promise<never>((_, reject) => {
            promptTimeout = setTimeout(() => {
              // Ask the runtime to cancel; escalation to a kill is built in.
              void runtime?.cancel().catch(() => {});
              reject(new Error(`Agent did not finish the test prompt within ${TEST_PROMPT_MS}ms`));
            }, TEST_PROMPT_MS);
          });
          // Both promises are raced below; keep losing rejections handled.
          promptPromise.catch(() => {});
          timeoutPromise.catch(() => {});
          await Promise.race([promptPromise, timeoutPromise]);
        } finally {
          if (promptTimeout) clearTimeout(promptTimeout);
        }
      } catch (caught) {
        error = { message: caught instanceof Error ? caught.message : String(caught) };
      } finally {
        if (runtime) {
          stderrTail = runtime.stderrTail();
          try {
            await runtime.stop();
          } catch {
            // The runtime may already be gone; the error above is authoritative.
          }
        }
        try {
          await rm(sandbox, { recursive: true, force: true });
        } catch {
          // Best effort: a leftover temp dir must not fail the test result.
        }
      }

      return {
        ok: error === undefined,
        ...(error ? { error } : {}),
        frames,
        framesDropped,
        ...(stderrTail ? { stderrTail } : {}),
        durationMs: Date.now() - startedAt,
      };
    },

    async status(input) {
      const definition = findDefinition(input.agentId);
      if (!definition) {
        return { supported: false, error: `Unknown ACP agent: ${input.agentId}` };
      }
      if (!definition.statusArgs || definition.statusArgs.length === 0) {
        return { supported: false };
      }
      const commandPath = await resolveCommandPath(input.agentId, definition);
      const result = await runCommand(commandPath, definition.statusArgs, STATUS_TIMEOUT_MS);
      return { supported: true, exitCode: result.exitCode, output: result.output };
    },

    async startLogin(input) {
      const definition = findDefinition(input.agentId);
      if (!definition || definition.loginArgs.length === 0) {
        return {
          opened: false,
          command: "",
          error: `No login flow is known for ${input.agentId}`,
        };
      }
      const commandPath = await resolveCommandPath(input.agentId, definition);
      const commandLine = [quoteShellArg(commandPath), ...definition.loginArgs].join(" ");
      const result = await openTerminal(commandLine);
      return {
        opened: result.opened,
        command: commandLine,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  };
}

async function defaultDetectAgents(input: {
  readonly refresh: boolean;
}): Promise<readonly AcpAgentSummary[]> {
  if (input.refresh) refreshAcpAgentCache();
  const detections = detectAcpAgents();
  return detections.map((detection) => {
    const definition = ACP_AGENT_DEFINITIONS.find((entry) => entry.agentId === detection.agentId);
    return {
      agentId: detection.agentId,
      displayName: detection.displayName,
      installed: detection.installed,
      version: detection.version,
      commandPath: detection.commandPath,
      spawnArgs: definition?.spawnArgs ?? ["acp"],
      loginArgs: definition?.loginArgs ?? [],
      statusArgs: definition?.statusArgs ?? null,
    };
  });
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const suffix = timedOut ? `\n[timed out after ${timeoutMs}ms]` : "";
      resolve({ exitCode, output: `${output.trim()}${suffix}`.trim() });
    };
    const append = (chunk: Buffer): void => {
      if (output.length >= MAX_STATUS_OUTPUT_CHARS) return;
      output += chunk.toString("utf8");
      if (output.length > MAX_STATUS_OUTPUT_CHARS)
        output = output.slice(0, MAX_STATUS_OUTPUT_CHARS);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      resolve({ exitCode: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error: Error) => {
      append(Buffer.from(error.message, "utf8"));
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

async function defaultOpenTerminal(
  commandLine: string,
): Promise<{ opened: boolean; error?: string }> {
  if (process.platform !== "darwin") {
    return { opened: false, error: "Opening a terminal window is only supported on macOS." };
  }
  try {
    const dir = await mkdtemp(join(tmpdir(), "zcode-acp-login-"));
    const scriptPath = join(dir, "login.command");
    const script = [
      "#!/bin/sh",
      `echo "[ZCode] Running: ${escapeForEcho(commandLine)}"`,
      commandLine,
      "",
    ].join("\n");
    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o755);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("open", ["-a", "Terminal", scriptPath], { stdio: "ignore" });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve(null);
      }, TERMINAL_OPEN_TIMEOUT_MS);
      child.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (exitCode === 0) return { opened: true };
    return { opened: false, error: `Could not open Terminal (exit code ${exitCode}).` };
  } catch (error) {
    return { opened: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Quotes as a single shell argument when plain-safe characters are not sufficient. */
function quoteShellArg(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeForEcho(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
