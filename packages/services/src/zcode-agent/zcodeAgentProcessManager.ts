import { localRuntimeNetworkCapture } from "#src/zcode-agent/localRuntimeNetworkCapture.js";
import { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";
import type { ZCodeAgentStorageStartupSnapshot } from "#src/zcode-agent/zcodeAgent.js";
/* eslint-disable max-lines -- zcodeAgentProcessManager centrally owns agent subprocess spawn, reuse, timeout reclamation, and runtime identity; splitting it would widen the process-lifecycle state sync surface */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Emitter } from "@zcode/rpc";
import { GEN_UI_OUTPUT_DIRECTORY, GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import { getAppConfigDir, getZCodeDataRootDir } from "#src/paths.js";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_AGENT_LIFECYCLE_LOG_MARKER,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
} from "@zcode/shared/process-diagnostic";
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  ZCODE_RUNTIME_ENV_KEY,
  resolveWorkspaceKey,
  resolveZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnv,
} from "@zcode/shared";
import {
  findZCodeAgentRuntimeBinary,
  findZCodeAgentRuntimeNodeBundle,
} from "../runtime-tools/providerRuntimeResolver.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "./zcodeStdioTransport.js";
import { readZCodeStdioTapDevState } from "./zcodeStdioTapDevConfig.js";
import type { ZCodeAgentPresentationSurface } from "./zcodeAgentPresentationSurface.js";
import { shouldSpawnInDetachedProcessGroup } from "../process/processTreeTerminator.js";
import type { RuntimeProcessLifecycleReporter } from "../process/runtimeProcessLifecycle.js";
import { buildAgentWorkspaceIdentityEnv } from "../runtime-tools/agentProxyEnv.js";

export interface ZCodeAgentCommand {
  /** Storage-only Worker entry of the local companion CLI bundle; capability is not inferred for remote/custom commands. */
  storagePreparationEntry?: string;
  /** This deployment's Agent supports the pre-migration startup notification; legacy custom commands keep the old protocol. */
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ZCodeAgentCommandResolverContext {
  presentationSurface?: ZCodeAgentPresentationSurface;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export type ZCodeAgentCommandResolver = (
  context: ZCodeAgentCommandResolverContext,
) => Promise<ZCodeAgentCommand | null> | ZCodeAgentCommand | null;

type RuntimeWorkspace = { workspacePath: string; workspaceIdentity?: string };
const SHARED_TASK_RUNTIME_KEY = "shared-local-tasks";
interface RuntimeBinding {
  workspace: RuntimeWorkspace;
  processKey: string;
}

export interface ZCodeAgentProcessManagerOptions {
  /** Host project facts decide the first assignment; a live binding does not change as the project moves. */
  useSharedTaskRuntime?: (workspace: RuntimeWorkspace) => Promise<boolean>;

  commandResolver?: ZCodeAgentCommandResolver;
  presentationSurface?: ZCodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * Process lane identifier. Different lanes of the same workspace each get their own manager
   * instance; the lane is written into runtimeIdentity and spawn/exit logs for troubleshooting.
   * Defaults to the chat main lane with no marker appended.
   */
  lane?: string;
  /**
   * Idle-reclamation threshold: when no request is in flight on the connection for longer than
   * this, the whole process tree is proactively reclaimed and the next getClient transparently
   * respawns. Used only by control-plane lanes like mcp-status that "probe on demand with MCP
   * subprocesses hanging in-process"; chat / plugin default to no reclamation.
   */
  idleTimeoutMs?: number;
  /**
   * Used only when the default process cwd equals the target workspace and that directory is unavailable.
   * The business workspacePath/workspaceKey do not change with the cwd fallback.
   */
  spawnFallbackCwd?: string;
  /**
   * Extra environment variables resolved before each agent subprocess spawn (merged after
   * process.env and before workspace variables).
   * Used to inject settings-page proxy and similar config into the subprocess; read per spawn,
   * naturally "effective on next launch".
   *
   * The context carries this spawn's workspace identity triple (workspacePath/workspaceIdentity/workspaceKey).
   * Helper lifecycle no longer reclaims or restarts an existing Agent.
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Optional external spawn admission hook. CUA's default assembly no longer injects the
   * Helper recovery gate, so Helper lifecycle cannot block or indirectly restart the Agent;
   * this generic hook stays for other product policies.
   */
  waitForSpawnAdmission?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
}

interface ManagedZCodeAgentProcess {
  client: ZCodeProtocolClient;
  child: ChildProcessWithoutNullStreams;
  cleanupPromise?: Promise<void>;
  exitDiagnosticsCompleted: Promise<void>;
  exited: boolean;
  firstCleanupReason?: AgentProcessCleanupReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  readyAt?: number;
  readyReported: boolean;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  runtimeInstanceId: string;
  spawned: boolean;
  startedAt: number;
  terminationIntent?: AgentProcessTerminationIntent;
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

type AgentProcessCleanupReason =
  | "idle-timeout"
  | "idle-timeout-retry"
  | "manager-dispose"
  | "manager-dispose-retry"
  | "protocol-close"
  | "request-timeout"
  | "workspace-dispose"
  | "workspace-dispose-retry";

interface AgentProcessTerminationIntent {
  kind: "expected" | "watchdog_recycle";
  reason: Exclude<AgentProcessCleanupReason, "protocol-close">;
  requestedAt: number;
}

const E2E_COVERAGE_PRELOAD_SOURCE = `
const { takeCoverage } = require("node:v8");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const coverageDirectory = process.env.NODE_V8_COVERAGE;
let coverageFlushStarted = false;
for (const signal of process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const flushCoverage = () => {
    if (coverageFlushStarted) return;
    coverageFlushStarted = true;
    if (coverageDirectory) {
      writeFileSync(
        resolve(coverageDirectory, \`coverage-signal-\${process.pid}.marker\`),
        signal,
      );
    }
    try {
      takeCoverage();
    } catch (error) {
      if (coverageDirectory) {
        writeFileSync(
          resolve(coverageDirectory, \`coverage-signal-error-\${process.pid}.txt\`),
          error instanceof Error ? error.stack || error.message : String(error),
        );
      }
    }
    if (process.listenerCount(signal) !== 1) return;
    setTimeout(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    }, 1000);
  };
  process.prependListener(signal, flushCoverage);
}
if (coverageDirectory) {
  writeFileSync(resolve(coverageDirectory, \`coverage-ready-\${process.pid}.marker\`), "");
}
`;

export function buildE2EAgentCoverageEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== "1" || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "cli");
  mkdirSync(directory, { recursive: true });
  const preloadPath = resolve(directory, "zcode-e2e-coverage-preload.cjs");
  // With an uncompressed CLI bundle, parse time can exceed the E2E early-exit window, and a
  // SIGTERM arrives before the normal shutdown handler registers. A NODE_OPTIONS preload takes
  // over the flush before the bundle is parsed.
  writeFileSync(preloadPath, E2E_COVERAGE_PRELOAD_SOURCE, "utf8");
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), requireOption].filter(Boolean).join(" "),
    NODE_V8_COVERAGE: directory,
  };
}

/**
 * (CLI reconnect-resubscribe boundary): the same workspace's agent process was rebuilt
 * (reclaimed on timeout, or the first getClient respawning after a crash). v4 subscriptions
 * (sessions-index/workspace-config/conversation) live in the CLI process's memory and die with
 * the process generation — subscribers must re-send subscribe upon receiving this event.
 */
export interface ZCodeAgentRuntimeRestartedEvent {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
}

export interface ZCodeAgentRuntimeLifecycleEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  state: "available" | "unavailable";
}

export interface ZCodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** Process lane identifier; empty by default for the chat main lane. */
  lane?: string;
}

interface ZCodeAgentSpawnPreflight {
  command: string;
  args: string[];
  requestedCwd: string;
  cwd: string;
  cwdSource: "command" | "workspace" | "workspace-fallback";
  commandPathKind: "absolute" | "path-search";
  commandExists: boolean | null;
  cwdExists: boolean;
}

const serviceLog = createServiceLogger("zcode-agent");

const log = (...args: unknown[]) => serviceLog.info(undefined, ...args);
const warnLog = (...args: unknown[]) => serviceLog.warn(undefined, ...args);
const errorLog = (...args: unknown[]) => serviceLog.error(undefined, ...args);

const AGENT_STDERR_TAIL_MAX_LINES = 20;
const AGENT_STDERR_LINE_MAX_CHARS = 1_000;
const AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_STDERR_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_STDERR_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;

function redactAgentDiagnostic(value: string): string {
  return (
    value
      .replace(AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_STDERR_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // Bare keys must also be masked before cross-process diagnostics and production logs.
      .replace(AGENT_STDERR_API_KEY_PATTERN, "$1<redacted>")
  );
}

const debugLog = (...args: unknown[]) => {
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  serviceLog.debug(undefined, ...args);
};

function createAgentStderrTail(): {
  append(line: string): void;
  snapshot(): { lineCount: number; tail: string[] };
} {
  const tail: string[] = [];
  let lineCount = 0;

  return {
    append(line) {
      lineCount += 1;
      const redacted = redactAgentDiagnostic(line);
      const bounded =
        redacted.length > AGENT_STDERR_LINE_MAX_CHARS
          ? `${redacted.slice(0, AGENT_STDERR_LINE_MAX_CHARS)}…[truncated]`
          : redacted;
      tail.push(bounded);
      if (tail.length > AGENT_STDERR_TAIL_MAX_LINES) {
        tail.shift();
      }
    },
    snapshot() {
      return { lineCount, tail: [...tail] };
    },
  };
}

function parseArgsJson(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    // Stop at the nearest checkout root (`.git` dir or worktree `.git` file): worktrees live
    // inside the main checkout, so an unbounded walk ran the parent repo's stale CLI build
    // instead of the worktree's code (specs/agent-cli-checkout-resolution.md).
    if (existsSync(join(current, ".git"))) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function buildZCodeAgentSpawnPreflight(
  command: ZCodeAgentCommand,
  workspacePath: string,
  spawnFallbackCwd?: string,
): Promise<ZCodeAgentSpawnPreflight> {
  const commandPathKind = isAbsolute(command.command) ? "absolute" : "path-search";
  const requestedCwd = command.cwd ?? workspacePath;
  const {
    cwd,
    usedFallback: shouldUseWorkspaceFallback,
    cwdExists,
  } = await resolveZCodeAgentSpawnCwd({ requestedCwd, workspacePath, spawnFallbackCwd });
  return {
    command: command.command,
    args: command.args ?? [],
    requestedCwd,
    cwd,
    cwdSource: shouldUseWorkspaceFallback
      ? "workspace-fallback"
      : command.cwd === undefined
        ? "workspace"
        : "command",
    commandPathKind,
    // Node spawn's ENOENT can come from either a missing command or a missing cwd.
    // Production logs record both visibilities before spawn so a lost workspace path is not
    // misjudged as the auto-update losing the binary.
    commandExists: commandPathKind === "absolute" ? existsSync(command.command) : null,
    cwdExists,
  };
}

function resolveBundledWorkspaceZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const distEntrypoint = findUpward("apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (distEntrypoint) {
    const useBytecode =
      process.versions.electron && process.env.ZCODE_DESKTOP_AGENT_BYTECODE === "1";
    const entrypoint = useBytecode
      ? join(dirname(distEntrypoint), "zcode.bytecode.cjs")
      : distEntrypoint;
    // This synchronous command resolver keeps the existing existsSync contract; an explicit trial must not silently fall back to JS.
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error("桌面 Agent 字节码入口缺失，请运行 pnpm build:desktop-agent:bytecode");
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // Worker and Electron Node subprocesses can differ in V8 snapshot; temporary storage preparation stays on JS.
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // The desktop host runs in an Electron utility process; process.execPath points at the
      // Electron Helper. Explicitly enable Node run mode here so the built-in zcode-agent is
      // not launched as an Electron/Chromium subprocess and stuck in GPU initialization.
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/zcode-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
    if (sourceEntrypoint) {
      // Without this the resolver silently falls through to a packaged build.
      warnLog("ZCode agent source found but node_modules/.bin/tsx is missing", {
        sourceEntrypoint,
      });
    }
    return null;
  }
  return {
    command: tsxEntrypoint,
    args: [sourceEntrypoint, "app-server", "--stdio"],
    cwd: context.workspacePath,
  };
}

function resolveDeployedZCodeAgentBinaryCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // The old resolver only recognized the ZCODE_AGENT_SERVER_COMMAND env and the monorepo source
  // tree. An SSH remote deploys zcode-server.cjs as a single file under ~/.zcode/server/; the
  // host process's cwd is outside the repo and env is not inherited through ssh exec, so even
  // with zcode-agent deployed at ~/.zcode/server/agents/glm/ the resolver found nothing and the
  // first getClient threw "ZCode agent server command is not configured".
  // This reuses findZCodeAgentRuntimeBinary's candidate chain (GLM_BINARY_PATH env,
  // packagedResourcesPath, ~/.zcode/server/agents/glm, bundled-agents, etc.), treating an
  // already-deployed native binary as the final fallback so both remote and packaged desktop
  // form factors hit.
  const binaryPath = findZCodeAgentRuntimeBinary();
  if (!binaryPath) {
    return null;
  }
  return {
    command: binaryPath,
    args: ZCODE_AGENT_RUNTIME.spawnArgs,
    cwd: context.workspacePath,
  };
}

function resolveElectronRuntimeZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  // Packaged desktop: the host runs in an Electron utility process; process.execPath points at
  // the Electron Helper, whose built-in Node runtime matches the zcode-cli target (Electron 41
  // = Node 24.x). Run the resources/glm zcode.cjs directly with the app's own Electron Node
  // instead of bundling a separate Node binary (size drops from ~180MB to ~16MB, one JS copy
  // across platforms). process.versions.electron is the gate: remote SSH/WSL hosts run under
  // system Node without electron, skip this, and continue to the native-binary fallback — the
  // desktop and remote chains do not affect each other.
  if (!process.versions.electron) {
    return null;
  }
  const bundlePath = findZCodeAgentRuntimeNodeBundle();
  if (!bundlePath) {
    return null;
  }
  return {
    command: process.execPath,
    args: [bundlePath, ...ZCODE_AGENT_RUNTIME.spawnArgs],
    storagePreparationEntry: bundlePath,
    cwd: context.workspacePath,
    // Critical: must start in pure Node mode, or the subprocess is treated as an Electron/Chromium child and sticks in GPU initialization.
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function resolveDefaultZCodeAgentCommand(
  context: ZCodeAgentCommandResolverContext,
): ZCodeAgentCommand | null {
  const command = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (command) {
    return applyPresentationSurfaceToCommand(
      {
        command,
        args: parseArgsJson(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],
        cwd: process.env.ZCODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,
      },
      context.presentationSurface,
    );
  }

  // Order: explicit env override → monorepo dev source/dist (dev source edits take effect
  // immediately, never preempted by a remotely-installed legacy native binary) → packaged
  // desktop Electron Node runtime running zcode.cjs → deployed native binary (remote SSH fallback).
  const bundled =
    resolveBundledWorkspaceZCodeAgentCommand(context) ??
    resolveElectronRuntimeZCodeAgentCommand(context);
  return applyPresentationSurfaceToCommand(
    bundled
      ? { ...bundled, supportsStorageStartup: true }
      : resolveDeployedZCodeAgentBinaryCommand(context),
    context.presentationSurface,
  );
}

function applyPresentationSurfaceToCommand(
  command: ZCodeAgentCommand | null,
  presentationSurface: ZCodeAgentCommandResolverContext["presentationSurface"],
): ZCodeAgentCommand | null {
  if (!command || presentationSurface !== "desktop") {
    return command;
  }

  const commandArgs = command.args ?? [];
  const args: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--surface") {
      const nextArg = commandArgs[index + 1];
      // Bug cause: the old logic unconditionally consumed the next token, so an orphaned
      // --surface also swallowed following options like --stdio, stripping the custom Agent
      // command of its protocol launch arguments.
      // Only an explicit non-option value belongs to --surface; other options keep the original argument chain.
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--surface=")) {
      continue;
    }
    args.push(arg);
  }

  return {
    ...command,
    args: [...args, "--surface", "desktop"],
  };
}

export function wrapZCodeAgentCommandWithStdioTapDevProxy(
  command: ZCodeAgentCommand,
  workspaceKey: string,
): ZCodeAgentCommand {
  const tapState = readZCodeStdioTapDevState();
  if (!tapState.enabled) {
    return command;
  }

  const tapScript = findUpward("scripts/dev/zcode-stdio-tap.mjs");
  if (!tapScript) {
    debugLog("ZCode stdio tap proxy enabled but script not found");
    return command;
  }

  // In development, raw stdio frames are as voluminous as the message flow and must not go
  // into ordinary info logs. A side-channel proxy writes them to disk only when the explicit
  // switch is on; production builds and the default dev path are unaffected.
  return {
    supportsStorageStartup: command.supportsStorageStartup,
    command: process.execPath,
    args: [
      tapScript,
      "--workspace-key",
      workspaceKey,
      "--log-dir",
      tapState.logDir,
      "--",
      command.command,
      ...(command.args ?? []),
    ],
    cwd: command.cwd,
    env: {
      ...command.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

export class ZCodeAgentProcessManager {
  private readonly bindings = new Map<string, RuntimeBinding>();
  private readonly bindingFlights = new Map<string, Promise<RuntimeBinding>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly useSharedTaskRuntime: ZCodeAgentProcessManagerOptions["useSharedTaskRuntime"];
  private readonly processesByWorkspaceKey = new Map<string, ManagedZCodeAgentProcess>();
  private readonly ownedProcesses = new Set<ManagedZCodeAgentProcess>();
  private readonly startingByWorkspaceKey = new Map<string, Promise<ZCodeProtocolClient>>();
  private readonly restartGenerationByWorkspaceKey = new Map<string, number>();
  private readonly runtimeGenerationByWorkspaceKey = new Map<string, number>();
  private readonly availableRuntimeIdentityByWorkspaceKey = new Map<string, string>();
  private readonly startAdmissionAbortControllersByWorkspaceKey = new Map<
    string,
    Set<AbortController>
  >();
  private readonly storageStartupEmitter = new Emitter<{
    workspaceKey: string;
    snapshot: ZCodeAgentStorageStartupSnapshot;
  }>();
  readonly onStorageStartupChanged = this.storageStartupEmitter.event;

  getStorageStartupState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeAgentStorageStartupSnapshot | null {
    const managed = this.processesByWorkspaceKey.get(this.processKey(params));
    return managed
      ? {
          generation: managed.runtimeIdentity.generation,
          state: managed.client.storageStartup.snapshot ?? null,
        }
      : null;
  }

  private readonly commandResolver: ZCodeAgentCommandResolver;
  private readonly presentationSurface: ZCodeAgentProcessManagerOptions["presentationSurface"];
  private readonly requestTimeoutMs: number | undefined;
  private readonly processLifecycleReporter: RuntimeProcessLifecycleReporter | undefined;
  private readonly resolveSpawnEnv: ZCodeAgentProcessManagerOptions["resolveSpawnEnv"];
  private readonly waitForSpawnAdmission: ZCodeAgentProcessManagerOptions["waitForSpawnAdmission"];
  private readonly spawnFallbackCwd: string | undefined;
  private readonly lane: string | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly runtimeRestartedEmitter = new Emitter<ZCodeAgentRuntimeRestartedEvent>();
  private readonly runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  private disposeAllInFlight: Promise<void> | undefined;
  private disposed = false;

  /** Process-generation-change notification (fires when generation>1); v4 subscribers resubscribe on it, see ZCodeAgentRuntimeRestartedEvent. */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** available after the process truly spawns; unavailable once the current protocol client closes. */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;

  constructor(options?: ZCodeAgentProcessManagerOptions) {
    this.useSharedTaskRuntime = options?.useSharedTaskRuntime;
    this.commandResolver = options?.commandResolver ?? resolveDefaultZCodeAgentCommand;
    this.presentationSurface = options?.presentationSurface;
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.processLifecycleReporter = options?.processLifecycleReporter;
    this.resolveSpawnEnv = options?.resolveSpawnEnv;
    this.waitForSpawnAdmission = options?.waitForSpawnAdmission;
    this.spawnFallbackCwd = options?.spawnFallbackCwd;
    this.lane = options?.lane?.trim() || undefined;
    this.idleTimeoutMs =
      options?.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  }

  private processKey(params: RuntimeWorkspace): string {
    return (
      this.bindings.get(resolveWorkspaceKey(params))?.processKey ?? resolveWorkspaceKey(params)
    );
  }

  private async bind(params: RuntimeWorkspace): Promise<RuntimeBinding> {
    const key = resolveWorkspaceKey(params);
    const existing = this.bindings.get(key);
    if (existing) {
      const closing = this.closing.get(existing.processKey);
      if (closing) {
        await closing;
        return this.bind(params);
      }
      return existing;
    }
    const pending = this.bindingFlights.get(key);
    if (pending) return pending;
    const flight = Promise.resolve().then(async () => {
      const shared = await (!params.workspaceIdentity
        ? this.useSharedTaskRuntime?.(params)
        : false);
      if (this.disposed) throw new Error("ZCode agent process manager is disposed.");
      if (this.bindingFlights.get(key) !== flight)
        throw new Error("ZCode agent workspace allocation was cancelled.");
      const binding = {
        workspace: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        processKey: shared ? SHARED_TASK_RUNTIME_KEY : key,
      };
      // The old process tree must be fully released before project facts are re-read and assigned.
      const closing = this.closing.get(binding.processKey);
      if (closing) {
        await closing;
        return binding;
      }
      this.bindings.set(key, binding);
      return binding;
    });
    this.bindingFlights.set(key, flight);
    let binding: RuntimeBinding;
    try {
      binding = await flight;
    } finally {
      if (this.bindingFlights.get(key) === flight) this.bindingFlights.delete(key);
    }
    return this.bindings.has(key) ? binding : this.bind(params);
  }

  isSharedRuntime(params: RuntimeWorkspace): boolean {
    return this.processKey(params) === SHARED_TASK_RUNTIME_KEY;
  }

  getRuntimeWorkspaces(params: RuntimeWorkspace): RuntimeWorkspace[] {
    const key = this.processKey(params);
    return [...this.bindings.values()]
      .filter((entry) => entry.processKey === key)
      .map((entry) => entry.workspace);
  }

  private publishAvailable(managed: ManagedZCodeAgentProcess, binding: RuntimeBinding): void {
    if (!managed.spawned || managed.exited || managed.client.isDisposed) return;
    const workspaceKey = resolveWorkspaceKey(binding.workspace);
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) ===
      managed.runtimeIdentity.identity
    )
      return;
    this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, managed.runtimeIdentity.identity);
    const runtimeIdentity = { ...managed.runtimeIdentity, workspaceKey };
    // Workspaces newly joining the shared process must also receive available, for passive index-subscription connections.
    this.runtimeLifecycleEmitter.fire({
      ...binding.workspace,
      workspaceKey,
      runtimeIdentity,
      state: "available",
    });
    if (runtimeIdentity.generation > 1)
      this.runtimeRestartedEmitter.fire({ workspaceKey, runtimeIdentity });
  }

  private reportProcessLifecycle(
    callback: (reporter: RuntimeProcessLifecycleReporter) => void,
  ): void {
    const reporter = this.processLifecycleReporter;
    if (!reporter) {
      return;
    }

    try {
      callback(reporter);
    } catch (error) {
      // Process-lifecycle reporting is a side observation; transient failures must not block agent start or reclamation.
      warnLog("ZCode agent process lifecycle reporter failed", error);
    }
  }

  private clearIdleTimer(managed: ManagedZCodeAgentProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      delete managed.idleTimer;
    }
  }

  /**
   * Idle reclamation: the timer resets each time in-flight requests reach zero; when it fires
   * with still no request in flight and this process still the active instance, the whole
   * process tree (including MCP subprocesses under it) is proactively reclaimed. Attributed as
   * expected/idle-timeout, not counted as a crash by monitoring. If new requests are in flight
   * at the deadline, do nothing and wait for the next drain to restart the timer.
   */
  private scheduleIdleReclaim(workspaceKey: string, managed: ManagedZCodeAgentProcess): void {
    if (!this.idleTimeoutMs || this.disposed || managed.exited) {
      return;
    }
    this.clearIdleTimer(managed);
    const timer = setTimeout(() => {
      delete managed.idleTimer;
      if (this.disposed || managed.exited) {
        return;
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      // A custom Agent's old startup request may settle first and continue DB preparation; zero in-flight RPC does not mean migration idle.
      if (
        managed.client.pendingOperationRequestCount > 0 ||
        managed.client.storageStartup.isWaiting
      ) {
        return;
      }
      log("ZCode agent process idle timeout; reclaiming", {
        workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      void this.cleanupManagedProcessWithRetry(
        managed,
        "idle-timeout",
        "idle-timeout-retry",
        "idle timeout",
      ).catch(() => undefined);
    }, this.idleTimeoutMs);
    // The idle timer must not pin the host process on the event loop.
    timer.unref?.();
    managed.idleTimer = timer;
  }

  private recordTerminationIntent(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
  ): void {
    if (managed.firstCleanupReason) {
      return;
    }
    managed.firstCleanupReason = reason;
    if (reason === "protocol-close") {
      return;
    }
    // A protocol close may be the result of an Agent crash; only a Host-initiated reclamation
    // establishes exit intent. The first cleanup's reason is the root-cause fact — later
    // idempotent reclamations like app quit must not rewrite an already-abnormal protocol
    // close into expected.
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

  private reportRuntimeUnavailable(managed: ManagedZCodeAgentProcess): void {
    for (const binding of this.bindings.values()) {
      if (binding.processKey !== managed.runtimeIdentity.workspaceKey) continue;
      const workspaceKey = resolveWorkspaceKey(binding.workspace);
      if (
        this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
        managed.runtimeIdentity.identity
      )
        continue;
      this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
      this.runtimeLifecycleEmitter.fire({
        ...binding.workspace,
        workspaceKey,
        runtimeIdentity: { ...managed.runtimeIdentity, workspaceKey },
        state: "unavailable",
      });
    }
  }

  private reportRuntimeReady(managed: ManagedZCodeAgentProcess): void {
    if (
      !managed.spawned ||
      managed.exited ||
      managed.readyReported ||
      managed.readyAt == null ||
      typeof managed.child.pid !== "number"
    ) {
      return;
    }
    managed.readyReported = true;
    this.reportProcessLifecycle((reporter) =>
      reporter.onReady?.({
        pid: managed.child.pid!,
        provider: ZCODE_AGENT_PROVIDER,
        ...(this.lane ? { lane: this.lane } : {}),
        workspacePath: managed.workspace.workspacePath,
        readyAt: managed.readyAt!,
        startupDurationMs: Math.max(0, managed.readyAt! - managed.startedAt),
        runtimeGeneration: managed.runtimeIdentity.generation,
        runtimeInstanceId: managed.runtimeInstanceId,
      }),
    );
  }

  private cleanupManagedProcess(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    options: { reportError?: boolean } = {},
  ): Promise<void> {
    this.recordTerminationIntent(managed, reason);
    this.clearIdleTimer(managed);
    if (managed.cleanupPromise) {
      return managed.cleanupPromise;
    }

    // A protocol close only makes the client non-reusable; it does not mean the OS process it
    // backed has exited. Binding the reclamation promise to the managed process lets timeout,
    // restart, and app quit share one idempotent reclamation, and the Host never loses
    // ownership of the retired process.
    let cleanupCompleted = false;
    const cleanupPromise = managed.client
      .disposeAndWait()
      .then(async () => {
        // Process-tree reclamation may return before the async exit listener; stderr/exit
        // events must complete first, or the Host releases ownership early and the closing
        // caller misses the final diagnostic line.
        await managed.exitDiagnosticsCompleted;
        cleanupCompleted = true;
        log("ZCode agent process cleanup completed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
        });
      })
      .finally(() => {
        if (managed.cleanupPromise === cleanupPromise) {
          delete managed.cleanupPromise;
        }
        if (cleanupCompleted) {
          this.ownedProcesses.delete(managed);
        }
      });
    managed.cleanupPromise = cleanupPromise;
    // Bug cause: when dispose races the retry orchestration, a rejection could land before the
    // caller's await attached, and be reported as unhandledRejection (a run-level failure in
    // vitest, equivalent to an unhandled rejection in production). The catch must attach
    // unconditionally at the creation point: swallowed silently under reportError:false (the
    // retry path), with unified reporting done by cleanupManagedProcessWithRetry's
    // await/catch — alerting semantics unchanged.
    void cleanupPromise.catch((error) => {
      if (options.reportError === false) {
        return;
      }
      errorLog("ZCode agent process cleanup failed", {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        reason,
        error,
      });
    });
    return cleanupPromise;
  }

  private async cleanupManagedProcessForShutdown(managed: ManagedZCodeAgentProcess): Promise<void> {
    await this.cleanupManagedProcessWithRetry(
      managed,
      "manager-dispose",
      "manager-dispose-retry",
      "manager dispose",
    );
  }

  private cleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    const processKey = managed.runtimeIdentity.workspaceKey;
    const existing = this.closing.get(processKey);
    if (existing) return existing;
    // Register the barrier before the termination fires synchronous close callbacks, avoiding double reclamation or a concurrently spawned second process tree.
    const flight = Promise.resolve()
      .then(() =>
        this.performCleanupManagedProcessWithRetry(managed, reason, retryReason, retryScope),
      )
      .then(() => {
        for (const [key, binding] of this.bindings) {
          if (binding.processKey === processKey) this.bindings.delete(key);
        }
        if (this.closing.get(processKey) === flight) this.closing.delete(processKey);
      });
    this.closing.set(processKey, flight);
    return flight;
  }

  private async performCleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    try {
      // The first cleanup's process-tree/exit observations may be an intermediate state; when
      // the retry succeeds, the first rejection must not be prematurely escalated to a
      // production error alert. Final failure is still reported once by this method.
      await this.cleanupManagedProcess(managed, reason, { reportError: false });
    } catch (firstError) {
      // Windows process-table queries/exit events can briefly lag, making the first cleanup
      // falsely report root leftovers. Neither restart nor app quit may expose that
      // intermediate state to callers — retry once and reuse the transport's internal
      // snapshot; a real leftover still throws on the second cleanup.
      const cleanupError = firstError as NodeJS.ErrnoException;
      warnLog(`ZCode agent process cleanup retrying during ${retryScope}`, {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        cleanupStage: reason,
        errorName: firstError instanceof Error ? firstError.name || "Error" : "UnknownError",
        ...(typeof cleanupError.code === "string" ? { errorCode: cleanupError.code } : {}),
        error: firstError,
      });
      try {
        await this.cleanupManagedProcess(managed, retryReason, { reportError: false });
      } catch (finalError) {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason: retryReason,
          retryScope,
          error: finalError,
        });
        throw finalError;
      }
    }
  }

  async getClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeProtocolClient> {
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    const binding = await this.bind(params);
    const workspaceKey = binding.processKey;
    const closing = this.closing.get(workspaceKey);
    if (closing) {
      await closing;
      return this.getClient(params);
    }
    if (this.bindings.get(resolveWorkspaceKey(params)) !== binding) return this.getClient(params);
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed && !existing.client.isDisposed) {
      this.publishAvailable(existing, binding);
      return existing.client;
    }

    const starting = this.startingByWorkspaceKey.get(workspaceKey);
    if (starting) {
      const waitStartedAt = Date.now();
      log("ZCode agent process start already in progress", {
        workspaceKey,
      });
      const client = await starting;
      log("ZCode agent process start wait completed", {
        workspaceKey,
        durationMs: Date.now() - waitStartedAt,
      });
      const managed = this.processesByWorkspaceKey.get(workspaceKey);
      if (managed) this.publishAvailable(managed, binding);
      return client;
    }

    // With agent startup pulled earlier, host warmup and the UI's first
    // readWorkspacePresentation/sendPrompt can enter getClient simultaneously. In-flight spawn
    // promises are converged by workspaceKey here so one workspace never double-spawns.
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      workspaceKey === SHARED_TASK_RUNTIME_KEY ? { workspacePath: getZCodeDataRootDir() } : params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    try {
      return await startPromise;
    } catch (error) {
      if (!this.processesByWorkspaceKey.has(workspaceKey)) {
        for (const [key, route] of this.bindings)
          if (route.processKey === workspaceKey) this.bindings.delete(key);
      }
      throw error;
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(workspaceKey);
      }
      if (this.startingByWorkspaceKey.get(workspaceKey) === startPromise) {
        this.startingByWorkspaceKey.delete(workspaceKey);
      }
    }
  }

  /**
   * Reads only the already-registered runtime client; passive observers use this entry to avoid getClient's implicit spawn.
   */
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeProtocolClient | undefined {
    const managed = this.processesByWorkspaceKey.get(this.processKey(params));
    return managed && !managed.child.killed && !managed.client.isDisposed
      ? managed.client
      : undefined;
  }

  /** Resource registry: managed runtimes still alive (pid + workspace + client) */
  listManagedProcesses(): Array<{
    pid: number;
    workspacePath: string;
    workspaceIdentity?: string;
    lane?: string;
    client: ZCodeProtocolClient;
  }> {
    const result: Array<{
      pid: number;
      workspacePath: string;
      workspaceIdentity?: string;
      lane?: string;
      client: ZCodeProtocolClient;
    }> = [];
    for (const managed of this.processesByWorkspaceKey.values()) {
      if (managed.exited || managed.child.killed || typeof managed.child.pid !== "number") continue;
      result.push({
        pid: managed.child.pid,
        workspacePath: managed.workspace.workspacePath,
        ...(managed.workspace.workspaceIdentity
          ? { workspaceIdentity: managed.workspace.workspaceIdentity }
          : {}),
        ...(this.lane ? { lane: this.lane } : {}),
        client: managed.client,
      });
    }
    return result;
  }

  /** Called after the Agent service first passes the provider/model gate; reported once per runtime. */
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ZCodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(this.processKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient may return before the ChildProcess's async spawn event, or the runtime may be
    // replaced during the await. Mark ready only for the process that returned this entry; the
    // spawn callback guarantees the start → ready order.
    this.reportRuntimeReady(managed);
  }

  private async startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
  ): Promise<ZCodeProtocolClient> {
    const startStartedAt = Date.now();
    const resolveCommandStartedAt = Date.now();
    const command = await this.commandResolver({
      ...params,
      ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
      workspaceKey,
    });
    const resolveCommandDurationMs = Date.now() - resolveCommandStartedAt;
    if (!command) {
      throw new Error(
        "ZCode agent server command is not configured. Set ZCODE_AGENT_SERVER_COMMAND before integration.",
      );
    }
    if (admissionSignal.aborted) {
      throw admissionSignal.reason ?? new Error("ZCode agent process start was cancelled.");
    }
    const effectiveCommand = wrapZCodeAgentCommandWithStdioTapDevProxy(command, workspaceKey);
    log("ZCode agent command resolved", {
      workspaceKey,
      command: command.command,
      effectiveCommand: effectiveCommand.command,
      resolveCommandDurationMs,
    });

    // Helper recovery may begin during command resolve; wait once first so env resolution uses
    // post-recovery broker credentials instead of carrying stale state to the spawn boundary.
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // Settings-page proxy and other runtime env merge after process.env (overriding inherited
    // same-name shell variables), while command.env (deployment-specific) keeps top priority.
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // While the app is shutting down, an in-flight warmup may have just finished
      // command/env resolve. Spawning then would bypass disposeAllAndWait's snapshot and
      // re-create an unowned agent process.
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // Switching models restarts a single workspace. An old spawn request resuming after the
      // restart must not spawn and write back into the process pool, or the old agent would
      // overwrite the new config.
      throw new Error("ZCode agent process start was cancelled.");
    }
    // cwd probing also yields the event loop; it must precede the final admission and dispose/generation checks.
    const spawnPreflight = await buildZCodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // env resolution is itself async, and the recovery barrier may close again meanwhile; wait
    // and re-check the generation before spawn — the first admission alone is not enough.
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("ZCode agent process start was cancelled.");
    }
    // When the app launches in local-dev mode, the agent subprocess also gets
    // ZCODE_RUNTIME_ENV=development; NODE_ENV is no longer passed, so user shell/runtime
    // variables cannot influence the ZCode run mode or leak into the Bash tool.
    const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
    log("ZCode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
    const spawnRequestedAt = Date.now();
    const child = spawn(effectiveCommand.command, spawnPreflight.args, {
      cwd: spawnPreflight.cwd,
      // The agent may spawn further runtime/MCP subprocesses. On POSIX the wrapper enters its
      // own process group so shutdown can reclaim the whole tree; on Windows it stays
      // non-detached and taskkill /T handles it.
      detached: shouldSpawnInDetachedProcessGroup(),
      env: {
        ...sanitizeZCodeRuntimeEnv(process.env),
        [ZCODE_RUNTIME_ENV_KEY]: runtimeEnv,
        ...spawnEnv,
        ...effectiveCommand.env,
        // The generated-files root is decided solely by the executing Host, keeping Agent writes and Host reads under one authorization.
        [GEN_UI_OUTPUT_ROOT_ENV]: join(getAppConfigDir(), GEN_UI_OUTPUT_DIRECTORY),
        // Identity/isolation semantics use workspaceIdentity; cwd continues to use workspacePath.
        ...buildAgentWorkspaceIdentityEnv(params.workspaceIdentity),
        ...buildE2EAgentCoverageEnv(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    const stderrTail = createAgentStderrTail();
    const transport = new ZCodeStdioTransport(child, {
      onStderrLine: (line) => {
        const diagnostic = parseZCodeProcessDiagnostic(line);
        if (diagnostic && typeof child.pid === "number") {
          // Root cause: saving only the exit tail missed live-runtime exceptions; this side
          // channel does not depend on the debug switch.
          // The identity binds the child at creation and must not look up the current
          // workspace, so late post-restart events cannot cross processes.
          this.reportProcessLifecycle((reporter) =>
            reporter.onException?.({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              runtimeGeneration,
              runtimeInstanceId,
              diagnostic: {
                ...diagnostic,
                // The masked placeholder can be longer than the original; clamp again so the IPC schema does not reject a legitimate exception.
                name: redactAgentDiagnostic(diagnostic.name).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
                ),
                message: redactAgentDiagnostic(diagnostic.message).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
                ),
                ...(diagnostic.stack !== undefined
                  ? {
                      stack: redactAgentDiagnostic(diagnostic.stack).slice(
                        0,
                        ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
                      ),
                    }
                  : {}),
              },
            }),
          );
          return;
        }
        stderrTail.append(line);
        debugLog(line);
      },
      ownedProcessStartedAtMs: spawnRequestedAt,
      // On POSIX the child was started by this manager with detached=true, so the pid is also
      // the Host-owned independent PGID; after an abnormal root exit, cleanup can still reclaim
      // same-group descendants by group.
      ...(process.platform !== "win32" && child.pid ? { ownedProcessGroupId: child.pid } : {}),
    });
    const client = new ZCodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    if (child.pid) {
      const unregisterNetworkCapture = localRuntimeNetworkCapture.register(client, child.pid);
      child.once("close", unregisterNetworkCapture);
    }
    // After an Agent process restart the Host still needs the runtime identity to distinguish
    // old/new subscriptions and run commands.
    // The Provider Registry is rebuilt by the new Worker from the owning Environment's Config; the UI no longer re-sends it.
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // Lifecycle-event correlation needs only this runtime's opaque identity; the protocol identity containing workspaceKey must not be reused.
    const runtimeInstanceId = `agent-${randomUUID()}`;
    const runtimeIdentity: ZCodeAgentRuntimeIdentity = {
      generation: runtimeGeneration,
      identity: this.lane
        ? `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}`,
      ...(typeof child.pid === "number" ? { processId: child.pid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
    const exitDiagnostics = Promise.withResolvers<void>();
    const managed: ManagedZCodeAgentProcess = {
      child,
      client,
      exited: false,
      exitDiagnosticsCompleted: exitDiagnostics.promise,
      readyReported: false,
      runtimeIdentity,
      runtimeInstanceId,
      spawned: false,
      startedAt,
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    };
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    this.ownedProcesses.add(managed);
    const publishStorage = () => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) return;
      if (client.storageStartup.isWaiting) this.clearIdleTimer(managed);
      else if (
        client.storageStartup.snapshot?.phase === "ready" &&
        client.pendingOperationRequestCount === 0
      ) {
        this.scheduleIdleReclaim(workspaceKey, managed);
      }
      for (const binding of this.bindings.values()) {
        if (binding.processKey !== workspaceKey) continue;
        this.storageStartupEmitter.fire({
          workspaceKey: resolveWorkspaceKey(binding.workspace),
          snapshot: {
            generation: runtimeGeneration,
            state: client.storageStartup.snapshot ?? null,
          },
        });
      }
    };
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(workspaceKey, managed));
    }
    child.once("spawn", () => {
      managed.spawned = true;
      // Node spawn() returns the ChildProcess first and reports cwd/command ENOENT
      // asynchronously. The old code published runtimeRestarted before confirming the spawn,
      // subscribers reconnected and retriggered the launch, and the loop became a
      // failed-start → false-restart → reconnect self-sustaining storm. Only the spawn event
      // proves the new CLI runtime truly exists and it is safe to notify v4 subscribers to resubscribe.
      if (this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        for (const binding of this.bindings.values()) {
          if (binding.processKey === workspaceKey) this.publishAvailable(managed, binding);
        }
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onSpawn({
            pid: child.pid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            command: effectiveCommand.command,
            args: effectiveCommand.args ?? [],
            startedAt,
            runtimeGeneration,
            runtimeInstanceId,
          }),
        );
      }
      this.reportRuntimeReady(managed);
      log("ZCode agent process started", {
        workspaceKey,
        command: effectiveCommand.command,
        cwd: spawnPreflight.cwd,
        pid: child.pid,
        durationMs: Date.now() - startStartedAt,
      });
    });
    child.once("error", (error) => {
      errorLog(
        `ZCode agent process error${this.processLifecycleReporter?.onError ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
        {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          spawnPreflight,
        },
      );
      const errno = error as NodeJS.ErrnoException;
      this.reportProcessLifecycle((reporter) =>
        reporter.onError?.({
          pid: typeof child.pid === "number" ? child.pid : null,
          provider: ZCODE_AGENT_PROVIDER,
          ...(this.lane ? { lane: this.lane } : {}),
          workspacePath: params.workspacePath,
          command: effectiveCommand.command,
          args: effectiveCommand.args ?? [],
          errorName: error.name || "Error",
          ...(typeof errno.code === "string" ? { errorCode: errno.code } : {}),
          errorMessage: error.message,
          ...(error.stack ? { errorStack: error.stack } : {}),
          runtimeGeneration,
          runtimeInstanceId,
          occurredAt: Date.now(),
        }),
      );
      if (child.pid == null) {
        exitDiagnostics.resolve();
        this.ownedProcesses.delete(managed);
      }
    });
    child.once("exit", async (code, signal) => {
      try {
        managed.exited = true;
        this.clearIdleTimer(managed);
        const endedAt = Date.now();
        const terminationKind = managed.terminationIntent?.kind ?? "unexpected";
        // Protocol parsing/stream failures trigger protocol-close first, then the Host reclaims
        // the still-alive process with SIGTERM. Forwarding only the active termination intent
        // would leave the desktop seeing just the final signal, unable to distinguish a
        // protocol fault from a controlled exit; the first cleanup's reason is kept as the
        // structured root cause.
        const terminationReason = managed.terminationIntent?.reason ?? managed.firstCleanupReason;
        // The protocol is already invalid, but exit precedes stderr EOF; keep the old runtime's closure identity to gather the final diagnostics.
        await transport.waitForStderrDrain();
        const stderr = stderrTail.snapshot();
        const exitContext = {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          code,
          signal,
          terminationKind,
          terminationReason,
        };
        // Previously the log had only the new "process started", with no exit trail for the old
        // pid. After an agent native crash the UI only saw protocol close/Session is not active
        // and could not tell a crash from an intentional restart.
        log("ZCode agent process exited", exitContext);
        if (terminationKind === "unexpected") {
          // An Agent top-level exception only writes stderr and exits with a non-zero code;
          // stderr used to flow only through dev-mode debug, leaving production logs with just
          // code=1 and no way to reconstruct the exception. Do not judge by non-zero code
          // alone: a signal crash and a long-running Agent exiting 0 on its own are both
          // unexpected exits too.
          // Separate lifecycle events exist; explicitly mark the wrapper log so Electron does not also count it as a JS exception.
          errorLog(
            `ZCode agent process exited unexpectedly${this.processLifecycleReporter ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
            {
              ...exitContext,
              stderr,
            },
          );
        }
        if (typeof child.pid === "number") {
          this.reportProcessLifecycle((reporter) =>
            reporter.onExit({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              exitCode: code,
              signal,
              endedAt,
              terminationKind,
              runtimeReady: managed.readyAt != null,
              ...(terminationReason ? { terminationReason } : {}),
              runtimeGeneration,
              runtimeInstanceId,
              uptimeMs: Math.max(0, endedAt - startedAt),
              stderrLineCount: stderr.lineCount,
              ...(terminationKind === "unexpected" && stderr.tail.length > 0
                ? { stderrTail: stderr.tail }
                : {}),
            }),
          );
        }
      } finally {
        exitDiagnostics.resolve();
      }
    });
    client.onRequestTimeout((event) => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      if (event.method === "workspace/cancelGenerateText") {
        warnLog(
          "ZCode agent cancel notification timed out; keeping client (best-effort control plane)",
          {
            workspaceKey,
            method: event.method,
            requestId: event.requestId,
            timeoutMs: event.timeoutMs,
            pid: child.pid,
          },
        );
        return;
      }
      warnLog("ZCode agent request timed out; disposing stale protocol client", {
        workspaceKey,
        method: event.method,
        requestId: event.requestId,
        timeoutMs: event.timeoutMs,
        pid: child.pid,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      // A timeout means the protocol request/response path is no longer trustworthy. The old
      // implementation only rejected the current request, but the child had not exited, so the
      // same workspace kept reusing the broken client and timing out repeatedly.
      // Proactively reclaim the process tree here so the next getClient spawns a clean app-server.
      void this.cleanupManagedProcessWithRetry(
        managed,
        "request-timeout",
        "request-timeout",
        "request timeout",
      ).catch(() => undefined);
    });
    client.onClose(() => {
      const wasActiveClient = this.processesByWorkspaceKey.get(workspaceKey) === managed;
      log("ZCode agent protocol client closed", {
        workspaceKey,
        pid: child.pid,
        runtimeIdentity: runtimeIdentity.identity,
        wasActiveClient,
      });
      if (wasActiveClient) {
        this.processesByWorkspaceKey.delete(workspaceKey);
      }
      this.reportRuntimeUnavailable(managed);
      if (this.ownedProcesses.has(managed)) {
        // The root child's exit does not mean same-group MCP descendants are gone. Even when
        // the protocol close comes from the root exiting, the idempotent reclamation of the
        // original process group must complete before releasing Host ownership.
        void this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "protocol close",
        ).catch(() => undefined);
      }
    });
    return client;
  }

  async getRuntimeIdentity(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAgentRuntimeIdentity> {
    const workspaceKey = this.processKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // runtime identity is a query interface, but the old implementation reused the
    // spawning getClient, so passive probes like provider saves implicitly spawned the Agent
    // CLI once per workspace.
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ZCode agent runtime identity is unavailable.");
    }
    return { ...managed.runtimeIdentity, workspaceKey: resolveWorkspaceKey(params) };
  }

  async canStart(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ available: boolean; workspaceKey: string; reason?: string }> {
    const workspaceKey = resolveWorkspaceKey(params);
    try {
      const command = await this.commandResolver({
        ...params,
        ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
        workspaceKey,
      });
      return command
        ? { available: true, workspaceKey }
        : {
            available: false,
            workspaceKey,
            reason: "ZCODE_AGENT_SERVER_COMMAND is not configured",
          };
    } catch (error) {
      return {
        available: false,
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async disposeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    this.bindingFlights.delete(resolveWorkspaceKey(params));
    const workspaceKey = this.processKey(params);
    const closing = this.closing.get(workspaceKey);
    if (closing) {
      try {
        await closing;
        return;
      } catch {
        // Auto-acquired connections stay isolated; only an explicit recovery may retry the unfinished process-tree cleanup.
        if (this.closing.get(workspaceKey) === closing) this.closing.delete(workspaceKey);
      }
    }
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
    this.abortPendingStarts(workspaceKey);
    const managed =
      this.processesByWorkspaceKey.get(workspaceKey) ??
      [...this.ownedProcesses].find(
        (candidate) => candidate.runtimeIdentity.workspaceKey === workspaceKey,
      );
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose must not drop a still-pending start promise from the tracking map. Dropping it
    // lets recovery/UI's next getClient open another spawn, while the old promise may still
    // write back into the process pool past an async resolve, creating a spawn/dispose storm
    // on the same workspace. The generation check fails the old promise before it truly
    // spawns, and finally cleans the map by promise identity.
    if (managed) {
      // restartWorkspaceProcess reclaims the physical process bound to that workspace,
      // covering all sharing workspaces. It must not reuse disposeAll, which would mark the
      // whole manager closed so later first-launch/warmup could not respawn.
      this.reportRuntimeUnavailable(managed);
      await this.cleanupManagedProcessWithRetry(
        managed,
        "workspace-dispose",
        "workspace-dispose-retry",
        "workspace dispose",
      );
    }
  }

  private abortPendingStarts(
    workspaceKey: string,
    reason = new Error("ZCode agent process start was cancelled."),
  ): void {
    const controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(reason);
    }
  }

  private abortAllPendingStarts(
    reason = new Error("ZCode agent process manager is disposed."),
  ): void {
    for (const workspaceKey of this.startAdmissionAbortControllersByWorkspaceKey.keys()) {
      this.abortPendingStarts(workspaceKey, reason);
    }
  }

  disposeAll(): void {
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();
    for (const managed of this.ownedProcesses) {
      this.recordTerminationIntent(managed, "manager-dispose");
      this.reportRuntimeUnavailable(managed);
      managed.client.dispose();
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();
  }

  async disposeAllAndWait(): Promise<void> {
    if (this.disposeAllInFlight) {
      return this.disposeAllInFlight;
    }
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();

    const managedProcesses = [...this.ownedProcesses];
    for (const managed of managedProcesses) {
      this.reportRuntimeUnavailable(managed);
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();

    // On app/host exit the old logic only synchronously disposed the client; the process
    // tree's SIGKILL backstop relied on an unref'd timer that never runs once the host itself
    // exits, leaving zcode-cli behind as an orphan. Here the host can wait for each
    // workspace's agent process tree to finish graceful + force cleanup.
    this.disposeAllInFlight = Promise.all(
      managedProcesses.map((managed) => this.cleanupManagedProcessForShutdown(managed)),
    ).then(() => undefined);
    try {
      await this.disposeAllInFlight;
    } finally {
      this.disposeAllInFlight = undefined;
    }
  }
}
