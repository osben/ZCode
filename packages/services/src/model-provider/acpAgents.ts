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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_AGENT_DEFINITIONS,
  AcpSessionRuntime,
  acpAgentPlatformSupported,
  detectAcpAgents,
  refreshAcpAgentCache,
  type AcpAgentDefinition,
  type AcpConfigOption,
  type AcpRawFrame,
  type AcpRuntimeLogger,
  type AcpSessionRuntimeOptions,
} from "@zcode/acp-agent-runtime";
import {
  describeAcpCommandProblem,
  describeAcpLaunchProblem,
} from "@zcode/shared/acp-launch-rules";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { defaultOpenTerminal, formatLoginCommand } from "./acpAgentLogin.js";
import { defaultRunCommand, STATUS_TIMEOUT_MS } from "./acpAgentCommand.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import type {
  AcpAgentCatalogInput,
  AcpAgentCatalogOption,
  AcpAgentCatalogResult,
  AcpAgentDetectionResult,
  AcpAgentHiddenModelsInput,
  AcpAgentHiddenModelsResult,
  AcpAgentLoginResult,
  AcpAgentStatusReport,
  AcpAgentSummary,
  AcpAgentTestInput,
  AcpAgentTestResult,
  AcpFrameEvent,
  ProviderSettingsAcpAgentsBridge,
} from "./acpAgentsContract.js";

export { buildMacLoginScript, formatLoginCommand } from "./acpAgentLogin.js";
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
  /** The session configuration offered by the handshake (S6); absent for a runtime without options. */
  readonly configOptions?: readonly AcpConfigOption[];
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
  /** Host platform; defaults to `process.platform`. ACP is macOS only (`acpAgentPlatformSupported`). */
  readonly platform?: NodeJS.Platform;
  /** Reads the agent catalog written by Test and by the turn reconcile (S6 readiness). */
  readonly readCatalog?: (agentId: string) => Promise<readonly AcpAgentCatalogOption[] | undefined>;
  /** Reads the model values hidden from the composer (specs/acp-agent-runtime.md "Settings: models and Advanced"). */
  readonly readHiddenModels?: (agentId: string) => Promise<readonly string[]>;
  /** Replaces the agent's hidden model values. */
  readonly writeHiddenModels?: (
    agentId: string,
    hiddenModels: readonly string[],
  ) => Promise<unknown>;
  /**
   * Stores the options a successful handshake offered for a known agent (specs/acp-agent-runtime.md,
   * "S6 readiness"). A failure is reported and never fails the test.
   */
  readonly recordCatalog?: (
    agentId: string,
    options: readonly AcpConfigOption[],
  ) => Promise<unknown>;
}

const MAX_TEST_FRAMES = 400;
const MAX_TEST_FRAME_BYTES = 1024 * 1024;

/** The smoke test allows slow agents to think, but stays bounded. */
const TEST_INITIALIZE_MS = 30_000;
const TEST_NEW_SESSION_MS = 30_000;
const TEST_PROMPT_MS = 60_000;
const TEST_CANCEL_GRACE_MS = 5_000;
const TEST_STOP_GRACE_MS = 2_000;
const TEST_KILL_GRACE_MS = 2_000;
const TEST_PROMPT_TEXT =
  "Reply with the single word: pong. Do not read, create, or modify any files.";

const log = createServiceLogger("acp-agent");

/** The one refusal of an unsupported host (specs/acp-agent-runtime.md "Platform scope"). */
const UNSUPPORTED_PLATFORM_MESSAGE = "ACP agents are supported on macOS only.";

/**
 * Runtime logger adapter. Callers pass only agent ids, exit codes/signals and
 * error messages: never env, args, frames or stderr, which can carry tokens.
 */
const runtimeLogger: AcpRuntimeLogger = {
  info: (message, fields) => log.info(undefined, message, fields ?? {}),
  warn: (message, fields) => log.warn(undefined, message, fields ?? {}),
  error: (message, fields) => log.error(undefined, message, fields ?? {}),
};

/**
 * The host settings bridge (specs/acp-agent-runtime.md, "Availability (platform rule)"). Its only
 * condition is the one availability predicate, `acpAgentPlatformSupported`. Unsupported platforms get no
 * bridge at all, so nothing can spawn a caller-supplied command there. The runtime env changes nothing.
 */
export function createHostAcpAgentsBridge(
  env: Record<string, string | undefined> = process.env,
  dependencies: AcpAgentsBridgeDependencies = {},
): ProviderSettingsAcpAgentsBridge | undefined {
  if (!acpAgentPlatformSupported(dependencies.platform ?? process.platform)) return undefined;
  const e2eAgentPath = resolveE2eAcpAgentPath(env);
  if (e2eAgentPath === undefined || dependencies.detectAgents) {
    return createAcpAgentsBridge(dependencies);
  }
  // Only the probed PATH changes; every other env key reaches the probe unchanged.
  const detectionEnv = { ...env, PATH: e2eAgentPath };
  return createAcpAgentsBridge({
    ...dependencies,
    detectAgents: (input) => defaultDetectAgents(input, detectionEnv),
  });
}

/** E2E detection seam (specs/acp-agent-runtime.md, "E2E seam"). */
export const ACP_E2E_AGENT_PATH_ENV = "ZCODE_E2E_ACP_AGENT_PATH";

/**
 * The PATH that replaces the detection probe path in desktop E2E, or undefined. Honored only in
 * an unpackaged development host (the bridge gate) running the test environment, so a value left
 * in a user's shell never changes what a real install detects.
 */
export function resolveE2eAcpAgentPath(
  env: Record<string, string | undefined>,
): string | undefined {
  if (!isEffectiveDevelopmentNodeEnv(env) || env.ZCODE_ENV !== "test") return undefined;
  const value = env[ACP_E2E_AGENT_PATH_ENV]?.trim();
  return value ? value : undefined;
}

export function createAcpAgentsBridge(
  dependencies: AcpAgentsBridgeDependencies = {},
): ProviderSettingsAcpAgentsBridge {
  const detectAgents = dependencies.detectAgents ?? ((input) => defaultDetectAgents(input));
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const openTerminal = dependencies.openTerminal ?? defaultOpenTerminal;
  const startRuntime = dependencies.startRuntime ?? ((options) => AcpSessionRuntime.start(options));
  const makeSandboxDir =
    dependencies.makeSandboxDir ?? (() => mkdtemp(join(tmpdir(), "zcode-acp-test-")));
  const supported = acpAgentPlatformSupported(dependencies.platform ?? process.platform);

  const findDefinition = (agentId: string): AcpAgentDefinition | undefined =>
    ACP_AGENT_DEFINITIONS.find((definition) => definition.agentId === agentId);

  const resolveCommandPath = async (
    agentId: string,
    definition: AcpAgentDefinition | undefined,
    override?: string,
  ): Promise<string> => {
    // A provider enabled with a custom executable must use that executable for
    // status/login too, not the detected default installation.
    const explicit = override?.trim();
    if (explicit) return explicit;
    const detected = await detectAgents({ refresh: false });
    const commandPath = detected.find((agent) => agent.agentId === agentId)?.commandPath ?? null;
    return commandPath ?? definition?.binaries[0] ?? "";
  };

  return {
    async detect(input = {}) {
      // The single owner of detection support: an unsupported platform reports no agents at all.
      if (!supported) return { supported: false, agents: [], detectedAt: Date.now() };
      const agents = await detectAgents({ refresh: input.refresh === true });
      return { supported: true, agents, detectedAt: Date.now() };
    },

    async catalog(input: AcpAgentCatalogInput): Promise<AcpAgentCatalogResult> {
      if (!supported) return { supported: false };
      const [options, hiddenModels] = await Promise.all([
        dependencies.readCatalog?.(input.agentId),
        dependencies.readHiddenModels?.(input.agentId),
      ]);
      return {
        supported: true,
        ...(options === undefined ? {} : { options }),
        ...(hiddenModels && hiddenModels.length > 0 ? { hiddenModels } : {}),
      };
    },

    async setHiddenModels(input: AcpAgentHiddenModelsInput): Promise<AcpAgentHiddenModelsResult> {
      if (!supported || !dependencies.writeHiddenModels) return { supported: false };
      await dependencies.writeHiddenModels(input.agentId, input.hiddenModels);
      return { supported: true };
    },

    async test(input) {
      const startedAt = Date.now();
      // The platform refusal comes first, whatever the input: nothing is looked up, spawned or written here.
      if (!supported) {
        return {
          ok: false,
          error: { message: UNSUPPORTED_PLATFORM_MESSAGE },
          frames: [],
          framesDropped: 0,
          durationMs: Date.now() - startedAt,
        };
      }
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
      const launchProblem = describeAcpLaunchProblem({ command, args, env: input.env });
      if (launchProblem) {
        return {
          ok: false,
          error: { message: `Invalid ACP launch: ${launchProblem}` },
          frames: [],
          framesDropped: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      const frames: AcpFrameEvent[] = [];
      let framesDropped = 0;
      let capturedBytes = 0;
      // Runtime frames use the wire vocabulary ("inbound"/"outbound", no
      // timestamp); map them onto the contract's test-report frame shape.
      const onFrame = (frame: AcpRawFrame): void => {
        // MAX_TEST_FRAME_BYTES is a byte bound; `text.length` counts UTF-16
        // code units, so measure actual UTF-8 bytes (CJK is up to 3x larger).
        const frameBytes = Buffer.byteLength(frame.text, "utf8");
        if (frames.length >= MAX_TEST_FRAMES || capturedBytes + frameBytes > MAX_TEST_FRAME_BYTES) {
          framesDropped += 1;
          return;
        }
        capturedBytes += frameBytes;
        frames.push({
          direction: frame.direction === "inbound" ? "in" : "out",
          text: frame.text,
          at: Date.now(),
        });
      };

      const sandbox = await makeSandboxDir();
      // Isolation note: the sandbox directory is only the session cwd. The
      // agent runs as the user like any enabled agent (no OS-level sandbox),
      // and the test does not advertise ACP fs capabilities, so tool access
      // stays minimal; the prompt additionally asks not to touch files.
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
          logger: runtimeLogger,
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
        // An empty snapshot has nothing for the composer; it must not replace a catalog that has options.
        if (
          input.agentId &&
          definition &&
          dependencies.recordCatalog &&
          runtime.configOptions &&
          runtime.configOptions.length > 0
        ) {
          // The handshake has answered session/new: the offered options are known before any prompt.
          try {
            await dependencies.recordCatalog(definition.agentId, runtime.configOptions);
          } catch (catalogError) {
            log.warn(undefined, "ACP agent catalog could not be stored", {
              agentId: definition.agentId,
              error: catalogError instanceof Error ? catalogError.message : String(catalogError),
            });
          }
        }
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
        log.warn(undefined, "ACP agent smoke test failed", {
          agentId: input.agentId ?? "custom",
          error: error.message,
        });
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
      if (!supported) return { supported: false };
      const definition = findDefinition(input.agentId);
      if (!definition) {
        return { supported: false, error: `Unknown ACP agent: ${input.agentId}` };
      }
      if (!definition.statusArgs || definition.statusArgs.length === 0) {
        return { supported: false };
      }
      const commandPath = await resolveCommandPath(input.agentId, definition, input.command);
      const commandProblem = describeAcpCommandProblem(commandPath);
      if (commandProblem) {
        return { supported: true, error: `Invalid ACP command: ${commandProblem}` };
      }
      const result = await runCommand(commandPath, definition.statusArgs, STATUS_TIMEOUT_MS);
      return { supported: true, exitCode: result.exitCode, output: result.output };
    },

    async startLogin(input) {
      if (!supported) return { opened: false, command: "", error: UNSUPPORTED_PLATFORM_MESSAGE };
      const definition = findDefinition(input.agentId);
      if (!definition || definition.loginArgs.length === 0) {
        return {
          opened: false,
          command: "",
          error: `No login flow is known for ${input.agentId}`,
        };
      }
      const commandPath = await resolveCommandPath(input.agentId, definition, input.command);
      // The login command line is written into a shell script: a CR/LF would end
      // the printed line and run the rest as its own command.
      const commandProblem = describeAcpCommandProblem(commandPath);
      if (commandProblem) {
        return { opened: false, command: "", error: `Invalid ACP command: ${commandProblem}` };
      }
      const commandLine = formatLoginCommand(commandPath, definition.loginArgs);
      const result = await openTerminal(commandLine);
      return {
        opened: result.opened,
        command: commandLine,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  };
}

async function defaultDetectAgents(
  input: { readonly refresh: boolean },
  detectionEnv?: Record<string, string | undefined>,
): Promise<readonly AcpAgentSummary[]> {
  if (input.refresh) refreshAcpAgentCache();
  const detections = await detectAcpAgents(detectionEnv ? { env: detectionEnv } : {});
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
