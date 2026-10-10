import { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";
import type { ZCodeAgentStorageStartupSnapshot } from "#src/zcode-agent/zcodeAgent.js";
/* eslint-disable max-lines -- zcodeAgentProcessManager centralizes agent child-process startup, reuse, timeout cleanup, and runtime identity; splitting it would expand lifecycle synchronization. */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Emitter } from "@zcode/rpc";
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
  /** Storage-specific Worker entry point for the bundled local CLI; do not infer this capability for remote/custom commands. */
  storagePreparationEntry?: string;
  /** Whether this deployment's Agent supports the pre-migration startup notification; legacy custom commands keep their existing protocol. */
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

export interface ZCodeAgentProcessManagerOptions {
  commandResolver?: ZCodeAgentCommandResolver;
  presentationSurface?: ZCodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * Process lane identifier. Different lanes for the same workspace use separate manager instances; the lane is included in
   * runtimeIdentity and spawn/exit logs to make diagnosis easier.
   * Defaults to the main chat lane with no suffix.
   */
  lane?: string;
  /**
   * Idle cleanup threshold: if the connection has no in-flight requests for longer than this duration, clean up the entire process tree;
   * the next getClient call starts it again transparently. Used only by control-plane lanes such as mcp-status, which probe on demand and keep MCP child processes alive;
   * chat / plugin lanes do not use idle cleanup by default.
   */
  idleTimeoutMs?: number;
  /**
   * Used only when the default process cwd equals the target workspace and that directory is unavailable.
   * Business workspacePath/workspaceKey do not change when falling back from cwd.
   */
  spawnFallbackCwd?: string;
  /**
   * Additional environment variables resolved before each agent child process is spawned (merged after process.env and before workspace variables).
   * Used to inject settings such as the configured proxy into the child process; read at spawn time, so changes naturally take effect on the next start.
   *
   * The context carries this spawn's workspace identity tuple (workspacePath/workspaceIdentity/workspaceKey),
   * allowing CUA broker credential injection to record Helper admission per workspace (see
   * cuaProductHelperWorkspaceRegistry in services/node.ts). Helper lifecycle no longer cleans up or restarts existing Agents.
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Optional external spawn-admission hook. The default CUA wiring no longer injects a Helper recovery gate,
   * avoiding blocked Helper lifecycle operations or indirect Agent restarts; keep this general hook for other product policies.
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

function buildE2EAgentCoverageEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== "1" || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "cli");
  mkdirSync(directory, { recursive: true });
  const preloadPath = resolve(directory, "zcode-e2e-coverage-preload.cjs");
  // Parsing an uncompressed CLI bundle can take longer than the E2E early-exit window, so SIGTERM may arrive before the normal shutdown
  // handler is registered. Use a NODE_OPTIONS preload to take over persistence before bundle parsing begins.
  writeFileSync(preloadPath, E2E_COVERAGE_PRELOAD_SOURCE, "utf8");
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), requireOption].filter(Boolean).join(" "),
    NODE_V8_COVERAGE: directory,
  };
}

/**
 * (CLI reconnect/resubscribe boundary): the agent process for a workspace is recreated (after timeout cleanup/crash,
 * the first getClient starts it again). v4 subscriptions (sessions-index/workspace-config/conversation)
 * live in CLI process memory and become invalid when the process changes; subscribers must send subscribe again after this event.
 */
interface ZCodeAgentRuntimeRestartedEvent {
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

interface ZCodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** Process lane identifier; empty by default for the main chat lane. */
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
      // Redact even bare keys before they reach cross-process diagnostics or production logs.
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
    // ENOENT from Node spawn may mean either the command or cwd is missing.
    // Record visibility of both in production logs before spawn to avoid mistaking a missing workspace path for an auto-update that removed the binary.
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
    // This synchronous command resolver follows the existing existsSync contract; explicit experiments must not silently fall back to JavaScript.
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error("桌面 Agent 字节码入口缺失，请运行 pnpm build:desktop-agent:bytecode");
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // The V8 snapshot may differ between Worker and Electron Node child processes; keep temporary storage preparation in JavaScript.
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // The desktop host runs in an Electron utility process, where process.execPath points to Electron Helper.
      // Explicitly enable Node mode here so the bundled zcode-agent is not launched as an Electron/Chromium child and stalled during GPU initialization.
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/zcode-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
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
  // The old resolver recognized only the ZCODE_AGENT_SERVER_COMMAND env var and the monorepo source tree.
  // On SSH remotes, zcode-server.cjs is deployed as a single file to ~/.zcode/server/, the host process cwd is outside the repository,
  // and ssh exec does not inherit the environment. Even when zcode-agent is deployed to ~/.zcode/server/agents/glm/,
  // the resolver cannot find it, so the first getClient call throws "ZCode agent server command is not configured".
  // Reuse the candidate chain from findZCodeAgentRuntimeBinary (including GLM_BINARY_PATH env,
  // packagedResourcesPath, ~/.zcode/server/agents/glm, bundled-agents, etc.),
  // and use the deployed native binary as the final fallback for both remote and packaged desktop setups.
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
  // Packaged desktop: the host runs in an Electron utility process, where process.execPath points to Electron Helper;
  // its bundled Node runtime matches the zcode-cli target version (Electron 41 = Node 24.x).
  // Run the zcode.cjs bundled in resources/glm directly with the app's Electron Node,
  // avoiding a separate bundled Node binary (reducing package size from ~180 MB to ~16 MB and using the same JS across platforms).
  // Use process.versions.electron as the gate: remote SSH/WSL hosts run system Node and have no Electron,
  // so they skip this path and continue to the native-binary fallback; desktop and remote paths remain independent.
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
    // Important: start in pure Node mode or the child is treated as an Electron/Chromium process and stalls during GPU initialization.
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

  // Order: explicit env override → monorepo dev source/dist (source edits take effect immediately and are not preempted by a legacy remote native binary)
  // → packaged desktop Electron Node runtime running zcode.cjs → deployed native binary (SSH remote fallback).
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
      // Bug: the old logic always consumed the next token, so a standalone --surface also swallowed later options
      // such as --stdio, leaving custom Agent commands without their protocol startup arguments.
      // Only an explicit non-option value belongs to --surface; other options continue through the original argument flow.
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

function wrapZCodeAgentCommandWithStdioTapDevProxy(
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

  // In development, raw stdio frame volume is comparable to the message stream and must not go into ordinary info logs.
  // Write it to disk through a side-channel proxy only when explicitly enabled; production builds and the default development path are unaffected.
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
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
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

  /** Process-replacement notification (emitted when generation > 1); v4 subscribers resubscribe, see ZCodeAgentRuntimeRestartedEvent. */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** Available after the process actually spawns; unavailable after the current protocol client closes. */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;

  constructor(options?: ZCodeAgentProcessManagerOptions) {
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
      // Process lifecycle reporting is side-channel observability; temporary failures must not block Agent startup or cleanup.
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
   * Idle cleanup: reset the timer whenever in-flight requests reach zero; when it expires, if there are still no requests and this process is still active,
   * clean up the entire process tree, including MCP children. The reason is expected/idle-timeout,
   * so monitoring does not treat it as a crash. If a new request is in flight at expiry, do nothing and restart the timer when requests next reach zero.
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
      // A legacy startup request for a custom Agent may settle before database preparation continues; no in-flight RPC does not mean migration is idle.
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
    // The idle timer must not keep the host process on the event loop.
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
    // Protocol close may result from an Agent crash; only cleanup initiated by the Host establishes an exit intent.
    // The first cleanup reason records the root cause; later idempotent cleanup such as app quit must not
    // rewrite an already abnormal protocol close as expected.
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

  private reportRuntimeUnavailable(managed: ManagedZCodeAgentProcess): void {
    const workspaceKey = managed.runtimeIdentity.workspaceKey;
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
      managed.runtimeIdentity.identity
    ) {
      return;
    }
    this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
    this.runtimeLifecycleEmitter.fire({
      workspacePath: managed.workspace.workspacePath,
      ...(managed.workspace.workspaceIdentity
        ? { workspaceIdentity: managed.workspace.workspaceIdentity }
        : {}),
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "unavailable",
    });
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

    // Protocol close only makes the client unusable; it does not mean the corresponding
    // OS process has exited. Bind the cleanup Promise to the managed process so timeout, restart, and
    // app quit can share one idempotent cleanup, and the Host retains ownership of retired processes.
    let cleanupCompleted = false;
    const cleanupPromise = managed.client
      .disposeAndWait()
      .then(() => {
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
    if (options.reportError !== false) {
      void cleanupPromise.catch((error) => {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
          error,
        });
      });
    }
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

  private async cleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    try {
      // The first process-tree/exit observation during cleanup may be an intermediate state; if retry succeeds,
      // do not prematurely escalate the first rejection to a production error alert. This method reports a final failure once.
      await this.cleanupManagedProcess(managed, reason, { reportError: false });
    } catch (firstError) {
      // Windows process-table queries/exit events may briefly lag, causing the first cleanup to falsely report a remaining root.
      // Do not expose this intermediate state to callers during restart/app quit; retry once using
      // the transport's internal snapshot. A real leftover process will still fail on the second cleanup.
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
    const workspaceKey = resolveWorkspaceKey(params);
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed) {
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
      return client;
    }

    // After Agent startup is moved earlier, host warmup and the UI's first readWorkspacePresentation/sendPrompt
    // may enter getClient concurrently. Coalesce in-flight startup promises by workspaceKey to avoid duplicate spawns for one workspace.
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    try {
      return await startPromise;
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
   * Read only an already-registered runtime client; passive observers use this entry point to avoid getClient's implicit spawn.
   */
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeProtocolClient | undefined {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed && !managed.child.killed ? managed.client : undefined;
  }

  /** Resource manager: currently alive managed runtimes (pid + workspace + client). */
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

  /** Called the first time the Agent service passes the provider/model gate; reported once per runtime. */
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ZCodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient may return before the ChildProcess's asynchronous spawn event, or the runtime may be replaced during await.
    // Mark only the process belonging to this entry as ready; the spawn callback preserves start → ready ordering.
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

    // Helper recovery may begin while the command is being resolved; wait once so environment resolution uses
    // the broker credentials after recovery instead of carrying stale state to the spawn boundary.
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // Runtime environment settings such as the settings-page proxy are merged after process.env (overriding inherited shell variables with the same name),
    // while command.env (deployment-specific) retains the highest priority.
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // While the app is closing, startup warmup may have just finished resolving the command/environment.
      // Spawning now would bypass disposeAllAndWait's snapshot and create an unmanaged Agent process again.
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // Changing models restarts one workspace. If an old startup request resumes after the restart,
      // it must not spawn and write back into the process pool, or the old Agent would override the new config.
      throw new Error("ZCode agent process start was cancelled.");
    }
    // cwd probing also yields to the event loop and must happen before the final admission and disposal/generation checks.
    const spawnPreflight = await buildZCodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // Environment resolution is asynchronous, and the recovery barrier may close again during it; wait and check the generation
    // once more before spawn instead of relying only on the first admission.
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("ZCode agent process start was cancelled.");
    }
    // When the app starts in local development mode, also set ZCODE_RUNTIME_ENV=development for the Agent child process.
    // Do not pass NODE_ENV, which could let user shell/runtime variables affect ZCode mode or leak into Bash tools.
    const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
    log("ZCode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
    const spawnRequestedAt = Date.now();
    const child = spawn(effectiveCommand.command, spawnPreflight.args, {
      cwd: spawnPreflight.cwd,
      // The Agent may spawn runtime/MCP child processes. On POSIX, put the wrapper in its own process group
      // so shutdown can clean up the whole tree; on Windows, keep it attached and let taskkill /T handle it.
      detached: shouldSpawnInDetachedProcessGroup(),
      env: {
        ...sanitizeZCodeRuntimeEnv(process.env),
        [ZCODE_RUNTIME_ENV_KEY]: runtimeEnv,
        ...spawnEnv,
        ...effectiveCommand.env,
        // Use workspaceIdentity for identity/isolation semantics; continue using workspacePath for cwd.
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
          // Root cause: saving only the exit tail misses exceptions from a live runtime; this side channel does not depend on the debug switch.
          // Bind identity to the child created here instead of looking up the current workspace, preventing late events after restart from crossing processes.
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
                // Redaction placeholders may be longer than the original text, so truncate again to keep the IPC schema from rejecting a valid error.
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
      // On POSIX, this manager starts the child with detached=true, so its pid is also the independent PGID
      // owned by the Host; after an abnormal root exit, cleanup can still terminate its descendants by group.
      ...(process.platform !== "win32" && child.pid ? { ownedProcessGroupId: child.pid } : {}),
    });
    const client = new ZCodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    // After the Agent process restarts, the Host still needs runtime identity to distinguish old and new subscriptions and commands.
    // The new Worker rebuilds Provider Registry from its Environment's Config; the UI no longer sends it again.
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // Lifecycle-event correlation needs only this runtime's opaque identity; do not reuse the protocol identity that includes workspaceKey.
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
    const managed: ManagedZCodeAgentProcess = {
      child,
      client,
      exited: false,
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
      this.storageStartupEmitter.fire({
        workspaceKey,
        snapshot: { generation: runtimeGeneration, state: client.storageStartup.snapshot ?? null },
      });
    };
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(workspaceKey, managed));
    }
    child.once("spawn", () => {
      managed.spawned = true;
      // Node spawn() returns a ChildProcess before asynchronously reporting cwd/command ENOENT.
      // The old code published runtimeRestarted before confirming spawn succeeded, causing subscribers to reconnect and trigger another
      // startup, creating a loop of failed start → false restart → reconnect. Only the spawn event confirms
      // that the new CLI runtime exists and makes it safe to notify v4 subscribers to resubscribe.
      if (runtimeGeneration > 1 && this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.runtimeRestartedEmitter.fire({ workspaceKey, runtimeIdentity });
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, runtimeIdentity.identity);
        this.runtimeLifecycleEmitter.fire({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          workspaceKey,
          runtimeIdentity,
          state: "available",
        });
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
        this.ownedProcesses.delete(managed);
      }
    });
    child.once("exit", async (code, signal) => {
      managed.exited = true;
      this.clearIdleTimer(managed);
      const endedAt = Date.now();
      const terminationKind = managed.terminationIntent?.kind ?? "unexpected";
      // Protocol parsing/stream failures trigger protocol-close first, then the Host sends SIGTERM
      // to clean up the still-running process. If only an intentional termination intent is forwarded, desktop sees only the final signal
      // and cannot distinguish a protocol failure from a controlled exit; preserve the first cleanup reason as the structured root cause.
      const terminationReason = managed.terminationIntent?.reason ?? managed.firstCleanupReason;
      // The protocol is already invalid, but exit may occur before stderr EOF; keep the old runtime closure identity to collect the final diagnostics.
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
      // Previously logs recorded only the new "process started" event and omitted the old pid's exit trail.
      // After a native Agent crash, the UI saw only protocol close/Session is not active and could not tell a crash from an intentional restart.
      log("ZCode agent process exited", exitContext);
      if (terminationKind === "unexpected") {
        // A top-level Agent exception writes only to stderr and exits with a nonzero code; stderr previously went only to development
        // debug logs, leaving production logs with just code=1 and no way to recover the exception. Do not classify by nonzero code alone: signal crashes
        // and an Agent exiting with code 0 after running for a long time are also unexpected exits.
        // A separate lifecycle event already exists; mark this as a wrapped log explicitly so Electron does not count it again as a JS exception.
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
      // A timeout means the protocol request/response path is no longer trustworthy. The old implementation rejected only the current request,
      // but the child had not exited, so later requests in the same workspace reused the bad client and timed out repeatedly.
      // Clean up the process tree here so the next getClient starts a fresh app-server.
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
        // The root child exiting does not mean its MCP descendants in the same group have exited. Even when protocol close
        // comes from root-process exit, complete idempotent cleanup for the original process group before releasing Host ownership.
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
    const workspaceKey = resolveWorkspaceKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // Runtime identity is a query, but the old implementation reused startup-oriented getClient,
    // causing passive checks such as provider saves to implicitly spawn an Agent CLI for each workspace.
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ZCode agent runtime identity is unavailable.");
    }
    return managed.runtimeIdentity;
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
    const workspaceKey = resolveWorkspaceKey(params);
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
    this.abortPendingStarts(workspaceKey);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose must not remove an unfinished start promise from the tracking table. Removing it would let the next recovery/UI
    // getClient start another spawn, while the old promise could later pass its async resolve and write into the process pool,
    // creating a spawn/dispose storm for the same workspace. The generation check makes the old promise fail before spawn;
    // finally then removes the map entry by promise identity.
    if (managed) {
      // restartWorkspaceProcess should clean up only the Agent for the current workspace.
      // Do not reuse disposeAll, which marks the entire manager as closed and prevents later startup/warmup from launching it again.
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

    // On app/host exit, the old logic synchronously disposed only the client; the process tree's SIGKILL fallback
    // depended on an unref timer, which would not run after the host exited, leaving zcode-cli as an orphan process.
    // This lets the host wait for graceful and forced cleanup of each workspace's Agent process tree.
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
