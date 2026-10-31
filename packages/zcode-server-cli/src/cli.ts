/* eslint-disable max-lines -- The CLI entry point centrally orchestrates subcommand dispatch and process management; splitting its flow across files would fragment it. */
import { fork } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isPublicZCodeErrorCode, ZCODE_VERSION } from "@zcode/shared";
import { SourceServerWorkspaceAliasRepo } from "@zcode/services/node";
import {
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  SERVER_READY_WAIT_TIMEOUT_MS,
  controlRequestSchema,
  createStoppedServerStatus,
  serverStatusSchema,
  type ServerStatus,
} from "./contracts.js";
import { requestControl } from "./ipc/controlClient.js";
import {
  resolveCanonicalServerLayout,
  resolveServerLayout,
  validateUninstallTarget,
} from "./runtime/paths.js";
import { validateServerInstallOwnership } from "./runtime/installationOwnership.js";
import { createReleaseAgentWiring, type BundledAgentWiring } from "./runtime/agentWiring.js";
import { writeStableLauncher } from "./runtime/stableLauncher.js";
import {
  runLocalArchiveUpdateCommand,
  runUpdateCommand,
  type UpdateDaemonHandoff,
} from "./runtime/updateCommand.js";
import { DataRootLock } from "./runtime/lock.js";
import { ReleaseManager } from "./runtime/releaseManager.js";
import { createUpdateDaemonHandoff } from "./runtime/updateHandoff.js";
import {
  acquireUninstallLock,
  describeLockInspection,
  removeRunContentsExceptLock,
} from "./runtime/uninstallGuard.js";
import { readPersistedStatus, readPersistedStatusDetailed } from "./runtime/statusSnapshot.js";
import {
  isStoppedServerStatus,
  readStatusForStopWithoutControl,
  stopSupervisorAndWait,
  waitForServerStopped,
} from "./runtime/shutdownWait.js";
export { readPersistedStatus } from "./runtime/statusSnapshot.js";
import {
  hasLegacyServiceRegistration,
  unregisterInstalledService,
  unregisterLegacyServiceForRoot,
} from "./runtime/serviceInstallation.js";
import { ProxyStdioError, runProxyStdio } from "./server-core/proxyStdio.js";

export interface CliIO {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
  confirm?: (prompt: string) => Promise<string>;
  legacyDelegate?: (argv: readonly string[]) => Promise<number>;
}

export interface ServerCliRuntimeOptions {
  bundledAgentWiring?: BundledAgentWiring | null;
  proxyStdioStreams?: { input: Readable; output: Writable };
  workspaceAliasRepo?: Pick<SourceServerWorkspaceAliasRepo, "retryFailedWorkspace">;
  /** The process/service manager is the external boundary of the update coordinator; tests can inject controlled implementations. */
  updateDaemonHandoff?: UpdateDaemonHandoff;
}

const stdout = (io: CliIO, value: unknown): void =>
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const stderr = (io: CliIO, value: unknown): void =>
  io.stderr?.write(`${value instanceof Error ? value.message : String(value)}\n`);

async function acquireLifecycleCommandLock(
  layout: ReturnType<typeof resolveServerLayout>,
  conflictMessage: string,
): Promise<DataRootLock> {
  const lock = new DataRootLock(layout.updateLockFile);
  try {
    await lock.acquire();
    return lock;
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) {
      throw new Error(conflictMessage, { cause: error });
    }
    throw error;
  }
}

export function serviceRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION !== "1";
}

export function daemonStartupMode(env: NodeJS.ProcessEnv = process.env): "service" | "fallback" {
  return serviceRegistrationEnabled(env) ? "service" : "fallback";
}

export function isRegisteredServiceEntry(args: readonly string[]): boolean {
  return args.includes("--service-entry");
}

export const SERVER_SERVICE_ARGS = ["serve", "--supervisor"] as const;

export function shouldRegisterService(
  daemonRequested: boolean,
  supervisorProcess: boolean,
): boolean {
  return daemonRequested && !supervisorProcess;
}

export async function runServerCli(
  argv: readonly string[],
  io: CliIO = {},
  runtimeOptions: ServerCliRuntimeOptions = {},
): Promise<number> {
  const json = argv.includes("--json");
  try {
    const parsed = parseServerCliArguments(argv);
    const command = parsed.argv[0];
    if (command === "version" || command === "--version") {
      // Bug cause: Server --version used to fall through to the legacy delegate, so its output depended on the adjacent Agent
      // zcode.cjs, and the Desktop probe could not reliably judge Server compatibility.
      stdout(io, json ? { product: "zcode-server", version: ZCODE_VERSION } : ZCODE_VERSION);
      return 0;
    }
    const proxyStdioRequested =
      command === "proxy-stdio" || (command === "server" && parsed.argv[1] === "proxy-stdio");
    const migrateRetryRequested = command === "migrate" && parsed.argv[1] === "retry";
    if (!command) {
      return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
    // Symlink aliases of the same physical data-root derive different control endpoints and OS service
    // identities. Lifecycle commands canonicalize the root before any IO so a second Supervisor cannot bypass probing and register again.
    const layout =
      ["serve", "status", "stop", "restart", "update", "uninstall"].includes(command) ||
      proxyStdioRequested ||
      migrateRetryRequested
        ? await resolveCanonicalServerLayout(parsed.layout.serverRoot)
        : parsed.layout;
    if (proxyStdioRequested) {
      try {
        await runProxyStdio({
          layout,
          input: runtimeOptions.proxyStdioStreams?.input ?? process.stdin,
          output: runtimeOptions.proxyStdioStreams?.output ?? process.stdout,
        });
        return 0;
      } catch (error) {
        const code = error instanceof ProxyStdioError ? error.code : "proxy-stdio-failed";
        io.stderr?.write(
          `${JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        return 1;
      }
    }
    if (migrateRetryRequested) {
      const pathIndex = parsed.argv.indexOf("--path");
      const workspacePath = pathIndex >= 0 ? parsed.argv[pathIndex + 1] : undefined;
      if (!workspacePath) throw new Error("migrate retry requires --path");
      if (!isAbsolute(workspacePath)) throw new Error("migrate retry --path must be absolute");
      const result = await (
        runtimeOptions.workspaceAliasRepo ?? new SourceServerWorkspaceAliasRepo()
      ).retryFailedWorkspace(workspacePath);
      stdout(io, json ? { ok: true, ...result } : `Migration recovered: ${result.canonicalKey}`);
      return 0;
    }
    switch (command) {
      case "serve":
        return await runServe(parsed.argv.slice(1), io, json, layout, runtimeOptions);
      case "stop":
        // Bug cause: runControl does not receive argv, so `stop --wait` used to be treated as an ack-style stop and returned at once;
        // the Desktop reported "stopped" while the remote still held the lock. --wait must go through the unified stop wait.
        if (parsed.argv.includes("--wait")) return await runStopAndWait(io, layout);
        return await runControl(command, io, json, {}, layout);
      case "restart": {
        // Same lifecycle command lock as update / uninstall: with several computers or terminals running concurrently, a restart must not stop a service
        // that is being updated or taken over by uninstall. When the lock is held, fail immediately (no waiting, no stopping the running service), reusing uninstall's conflict output.
        const restartLock = await acquireLifecycleCommandLock(
          layout,
          "A ZCode Server update is already running",
        );
        try {
          return await runRestart(io, json, layout, runtimeOptions);
        } finally {
          await restartLock.release();
        }
      }
      case "status":
      case "running-tasks":
        return await runControl(command, io, json, {}, layout);
      case "update": {
        const updateLock = await acquireLifecycleCommandLock(
          layout,
          "Another ZCode Server update is already running",
        );
        const updateDaemonHandoff =
          runtimeOptions.updateDaemonHandoff ?? createUpdateDaemonHandoff();
        try {
          if (parsed.argv.includes("--from-archive")) {
            return await runLocalArchiveUpdateCommand(
              parsed.argv,
              io,
              json,
              layout,
              () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
              updateDaemonHandoff,
            );
          }
          return await runUpdateCommand(
            parsed.argv,
            io,
            json,
            layout,
            () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
            updateDaemonHandoff,
          );
        } finally {
          await updateLock.release();
        }
      }
      case "uninstall": {
        const uninstallLock = await acquireLifecycleCommandLock(
          layout,
          "A ZCode Server update is already running",
        );
        try {
          return await runUninstall(io, json, layout);
        } finally {
          await uninstallLock.release();
        }
      }
      default:
        return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
  } catch (error: unknown) {
    if (json) {
      const structured =
        error && typeof error === "object"
          ? (error as { code?: unknown; retryable?: unknown })
          : null;
      const publicCode = isPublicZCodeErrorCode(structured?.code) ? structured.code : undefined;
      stdout(io, {
        ok: false,
        ...(publicCode ? { code: publicCode } : {}),
        ...(publicCode && typeof structured?.retryable === "boolean"
          ? { retryable: structured.retryable }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    } else stderr(io, error);
    return 1;
  }
}

function parseServerCliArguments(argv: readonly string[]): {
  argv: readonly string[];
  layout: ReturnType<typeof resolveServerLayout>;
} {
  const rootOptionIndexes = argv.flatMap((value, index) =>
    value === "--server-root" ? [index] : [],
  );
  if (rootOptionIndexes.length > 1) throw new Error("--server-root may only be specified once");
  const rootOptionIndex = rootOptionIndexes[0];
  if (rootOptionIndex === undefined) return { argv, layout: resolveServerLayout() };
  const serverRoot = argv[rootOptionIndex + 1];
  if (!serverRoot) throw new Error("--server-root requires an absolute path");
  if (!isAbsolute(serverRoot)) throw new Error("--server-root must be an absolute path");
  return {
    argv: argv.filter(
      (_value, index) => index !== rootOptionIndex && index !== rootOptionIndex + 1,
    ),
    layout: resolveServerLayout(serverRoot),
  };
}

async function runServe(
  args: readonly string[],
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  runtimeOptions: ServerCliRuntimeOptions,
): Promise<number> {
  const daemonRequested = args.includes("--daemon");
  const supervisorProcess = args.includes("--supervisor");
  if (shouldRegisterService(daemonRequested, supervisorProcess)) {
    let startupMode = daemonStartupMode();
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
    if (startupMode === "service") {
      const { isServiceManagerAvailable } = await import("./platform/serviceManager.js");
      if (!(await isServiceManagerAvailable(platform))) {
        // Bug cause: SSH used to treat the transport type as "systemd --user/launchd is always present".
        // Containers, minimal systems and non-interactive sessions without a user bus therefore always failed to connect after installation.
        startupMode = "fallback";
      }
    }
    const legacyIdentityMigration =
      startupMode === "service" && (await hasLegacyServiceRegistration(layout));
    const existing = await readControlStatus(layout, 500);
    if (existing && (existing.state === "ready" || existing.state === "starting")) {
      // Bug cause: fallback can now be the normal result of a systemd load failure. The old logic stopped an idle fallback
      // before registering again when the service manager was available; reconnects then failed to register again and relaunched, and with running tasks it errored outright and blocked the connection.
      // A live daemon is always reused; only an old identity service under the same root still needs migration.
      if (!legacyIdentityMigration) {
        // Bug cause: reusing a starting Supervisor used to return exit 0 with port:null immediately; the Desktop only accepts a success result that carries a port,
        // so it reported "did not report a valid ingress port" while the daemon went ready normally right afterwards.
        const reused = existing.state === "ready" ? existing : await waitForControlReady(layout);
        if (json) stdout(io, reused);
        else
          stdout(io, `ZCode Server ${reused.state} at ${reused.host ?? ""}:${reused.port ?? ""}`);
        return 0;
      }
      if (existing.runningTaskCount > 0) {
        throw new Error(
          `Cannot replace legacy service daemon while ${existing.runningTaskCount} task(s) are running; stop the server first`,
        );
      }
      // An old-identity daemon holds the data-root lock, so registering and starting a new identity directly only
      // launches a Supervisor that immediately conflicts on the lock. When idle, shut the old daemon down first, then register the new identity.
      await stopSupervisorAndWait(layout, "legacy service migration");
    } else if (existing?.state === "stop-failed" && existing.pid === null) {
      // Bug cause: a stop-failed Supervisor still holds the lock and control socket after observing a late Core terminal state;
      // starting directly only makes the new Supervisor conflict on the lock, and the device cannot recover before a manual stop. When no live Core remains,
      // the original owner closes out per the stop contract; if the pid still exists, no stop is sent and the lock keeps failing closed.
      await stopSupervisorAndWait(layout, "stop-failed restart");
    }
    const baselineUpdatedAt = (await readPersistedStatus(layout))?.updatedAt ?? 0;
    let serviceStarted = false;
    let serviceFallbackReason: string | undefined;
    let childEarlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let reapForkedSupervisor: (() => Promise<void>) | undefined;
    if (startupMode === "service") {
      const {
        createDaemonServiceDescriptor,
        isServiceLoadFailure,
        registerService,
        serviceDescriptorPath,
      } = await import("./platform/serviceManager.js");
      await writeStableLauncher(layout, platform, {
        command: process.execPath,
        entry: process.argv[1] ?? fileURLToPath(import.meta.url),
      });
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      await mkdir(layout.serviceDir, { recursive: true, mode: 0o700 });
      const descriptorPath = serviceDescriptorPath(layout, descriptor);
      await writeFile(descriptorPath, descriptor.content, "utf8");
      await unregisterLegacyServiceForRoot(layout);
      try {
        await registerService(descriptor, descriptorPath);
        serviceStarted = true;
      } catch (error) {
        // Bug cause: the capability probe only proves that the user manager's bus is reachable. enable is run by the manager, which reads the unit with its own group list and
        // mount view; groups joined after the manager started, or the manager's private /tmp, can hide the server root from it. The old rule returned this failure directly,
        // so every SSH reconnect failed even though a detached fallback on the same root would run fine. On a load-stage failure no unit has been started in this run, so
        // fall back to detached mode and carry the reason; on a start-stage failure the unit is already enabled. Unmarked errors (launchd / Task Scheduler) also cannot
        // confirm the stage, so they are still returned unchanged.
        if (!isServiceLoadFailure(error)) throw error;
        serviceFallbackReason = (error as Error).message.trim();
        if (!json)
          stderr(io, `Starting ZCode Server in detached fallback mode: ${serviceFallbackReason}`);
      }
    }
    if (!serviceStarted) {
      // Bug cause: when archive bootstrap coordinates an update, import.meta.url points at the temporary extraction directory, which is cleaned up after the
      // handoff. The fallback must reuse the real argv entry of this update's target release.
      const supervisorEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
      const child = fork(
        supervisorEntry,
        [...SERVER_SERVICE_ARGS, "--server-root", layout.serverRoot],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
            ZCODE_SERVER_ROOT: layout.serverRoot,
          },
        },
      );
      child.unref();
      // The Supervisor is an independent daemon and does not need to keep the CLI<->Supervisor IPC channel; closing it
      // lets the one-shot `serve --daemon` CLI actually exit after returning ready.
      child.disconnect();
      // The child Supervisor starts detached with stdio ignored, so on a lock conflict or other startup failure it exits silently;
      // recording the early-exit info lets the wait loop report the real cause immediately.
      const childExited = new Promise<void>((resolve) => {
        child.once("exit", (code, signal) => {
          childEarlyExit = { code, signal };
          resolve();
        });
      });
      reapForkedSupervisor = async () => {
        // An unref'd child no longer keeps the event loop alive; without ref() again the CLI would exit silently before the exit event arrives.
        child.ref();
        child.kill("SIGKILL");
        await childExited;
      };
    }
    let started: ServerStatus;
    try {
      started = await waitForPersistedStatus(
        layout,
        "ready",
        baselineUpdatedAt,
        () =>
          childEarlyExit
            ? `ZCode Server daemon exited before ready (code=${childEarlyExit.code ?? "null"} signal=${childEarlyExit.signal ?? "none"})`
            : undefined,
        serviceStarted,
      );
    } catch (error) {
      // Bug cause: after the CLI gave up waiting, a slow cold-started fallback Supervisor still took the lock and became ready; the caller got a failure
      // that contradicted the remote facts, and an update rollback's stop could fail to reach it (it had not yet listened on control) and then raced for the lock.
      // The fallback Supervisor is forked by this CLI, which is its only owner: force-kill it and wait for exit before reporting failure
      // (Core disconnects over IPC and closes itself out; a leftover lock is taken over by the next owner as stale). The OS service is held by the service manager and is not stopped here.
      await reapForkedSupervisor?.();
      throw error;
    }
    // The fallback reason belongs only to this startup result and is not written into status.json.
    if (json) stdout(io, serviceFallbackReason ? { ...started, serviceFallbackReason } : started);
    else stdout(io, `ZCode Server ${started.state} at ${started.host ?? ""}:${started.port ?? ""}`);
    process.stdin.pause();
    process.stdin.destroy();
    return 0;
  }
  const daemon = supervisorProcess;
  const { Supervisor } = await import("./supervisor/supervisor.js");
  const serviceRegistered = supervisorProcess && isRegisteredServiceEntry(args);
  const executingRelease = await new ReleaseManager(layout).readCurrent();
  const executingEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
  const executingReleaseDir = dirname(dirname(resolve(executingEntry)));
  const supervisorReleaseId =
    executingRelease?.releaseId &&
    resolve(executingRelease.releaseDir) === resolve(executingReleaseDir)
      ? executingRelease.releaseId
      : undefined;
  let foregroundStopped: (() => void) | undefined;
  const supervisor = new Supervisor({
    layout,
    launcher: {
      launch: (generation, release) => {
        const runtimeRoot = release?.releaseDir ? join(release.releaseDir, "runtime") : null;
        const corePath = runtimeRoot
          ? join(runtimeRoot, "server-core.js")
          : fileURLToPath(new URL("./server-core.js", import.meta.url));
        const runtimeNode = runtimeRoot
          ? join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node")
          : process.execPath;
        const inheritedEnv = {
          ...process.env,
          ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
          ZCODE_SERVER_ROOT: layout.serverRoot,
        };
        const releaseWiring = runtimeRoot
          ? createReleaseAgentWiring(runtimeRoot, runtimeNode, inheritedEnv)
          : runtimeOptions.bundledAgentWiring;
        return fork(corePath, [String(generation)], {
          execPath: runtimeNode,
          env: {
            ...inheritedEnv,
            ...releaseWiring,
            ...(runtimeRoot ? { ZCODE_SERVER_RUNTIME_ROOT: runtimeRoot } : {}),
            ...(release?.releaseId ? { ZCODE_SERVER_RELEASE_ID: release.releaseId } : {}),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      },
    },
    version: ZCODE_VERSION,
    ...(supervisorReleaseId ? { supervisorReleaseId } : {}),
    serviceRegistered,
    onStopped: () => {
      process.stdin.pause();
      foregroundStopped?.();
      if (supervisorProcess) process.disconnect?.();
    },
    // After losing the server root, the control server still listens, so the process cannot end by returning; closing it would delete the new owner's socket by path.
    // A missing lock file is an abnormal exit: the OS service restarts the real owner per Restart=on-failure / KeepAlive.
    // Bug cause: exiting with 1 also happened when the lock had been taken over by another owner. Two hosts sharing one home each judged the other's live lock as stale,
    // and their service managers restarted in turn, taking over from each other and stopping the Core every round. The new owner is already running, so exit 0 and the service manager does not restart.
    onServerRootLost: (loss) => process.exit(loss === "missing" ? 1 : 0),
  });
  await supervisor.start();
  let status: ServerStatus;
  try {
    status = await waitForSupervisorReady(supervisor);
  } catch (error) {
    // When Core enters crash-loop, the error must not be thrown straight to the CLI top-level handler: the control
    // socket still holds the event loop, leaving the foreground process hung. If the user presses Ctrl+C (the signal handler is not yet registered at this point,
    // so the default force-kill runs), the lock file and socket remain and later serve commands report "already running" forever.
    // On startup failure, stop the Supervisor first to close out the lock and socket, then rethrow the error.
    await supervisor.stop("startup-failed").catch(() => undefined);
    throw error;
  }
  if (json) stdout(io, status);
  else stdout(io, `ZCode Server ${status.state} at ${status.host ?? ""}:${status.port ?? ""}`);
  await new Promise<void>((resolve) => {
    foregroundStopped = resolve;
    if (!daemon) {
      const finish = () => {
        void supervisor.stop("signal").then(() => resolve());
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    }
  });
  return 0;
}

// The worst-case path of apply-update on the server includes: stopping the old Core, waiting for the new Core to become ready, stopping the new Core on rollback,
// waiting for the old Core to become ready, and stopping again after the old Core's ready timeout: three stop budgets plus two ready budgets,
// plus headroom for current/pending file operations and IPC scheduling. The client timeout must cover the complete rollback path,
// otherwise the CLI reports a timeout while the update is still running in the background (R2-CLI-08).
export const APPLY_UPDATE_TIMEOUT_MS =
  3 * (CORE_STOP_GRACE_TIMEOUT_MS + CORE_KILL_TIMEOUT_MS) + 2 * CORE_READY_TIMEOUT_MS + 30_000;

async function requestApplyUpdate(
  layout: ReturnType<typeof resolveServerLayout>,
  force: boolean,
): Promise<unknown> {
  return await requestControl(
    layout.controlEndpoint,
    { command: "apply-update", ...(force ? { force: true } : {}) },
    APPLY_UPDATE_TIMEOUT_MS,
  );
}

async function runControl(
  command: string,
  io: CliIO,
  json: boolean,
  extra: Record<string, unknown> = {},
  layout = resolveServerLayout(),
): Promise<number> {
  const request = controlRequestSchema.parse({ id: "cli", command, ...extra });
  let result: unknown;
  try {
    result = await requestControl(
      layout.controlEndpoint,
      request,
      command === "apply-update" ? APPLY_UPDATE_TIMEOUT_MS : undefined,
    );
  } catch (error: unknown) {
    if (command === "status") {
      const persisted = await readPersistedStatusDetailed(layout);
      result = persisted.status ?? createStoppedServerStatus(ZCODE_VERSION);
    } else if (command === "stop") {
      // A missing snapshot means the daemon never wrote its status; report it as stopped.
      result =
        (await readStatusForStopWithoutControl(layout, error)) ??
        createStoppedServerStatus(ZCODE_VERSION);
    } else {
      throw error;
    }
  }
  if (json) stdout(io, result);
  else stdout(io, result ?? "ok");
  return 0;
}

/**
 * `stop --wait`: outputs the final ServerStatus only after the data-root lock is released and the status is a stopped newer than the baseline (R2 §8.1).
 * When the daemon is not running (lock missing or stale), succeeds immediately; stop-failed and control timeouts fail with public error codes.
 */
async function runStopAndWait(
  io: CliIO,
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<number> {
  await stopSupervisorAndWait(layout, "stop");
  const persisted = await readPersistedStatusDetailed(layout);
  const status = persisted.status;
  // After the Supervisor has died, the snapshot may still show the ready state from before its death; the output only states the final fact "stopped".
  stdout(
    io,
    isStoppedServerStatus(status)
      ? status
      : createStoppedServerStatus(ZCODE_VERSION, {
          serviceRegistered: status?.serviceRegistered ?? false,
        }),
  );
  return 0;
}

/**
 * Full process-tree restart (R2 §8.1), coordinated by the CLI that issued the command rather than self-bootstrapped inside the lock-holding Supervisor.
 * Bug cause: the old `restart` only swapped the Core inside the Supervisor through control, so the Supervisor and its crash budget stayed unchanged;
 * when the daemon was not running, or the Supervisor was dead but its socket remained, it errored outright, and `crash-loop-stopped` could not recover itself.
 * Now it first drains the existing Supervisor with the unified stop wait (a missing or stale lock counts as not running and skips the stop; a new
 * `stop-failed` fails with a public code and starts no new instance), then starts it with `serve --daemon` and waits for ready. This process is run from the
 * current release by the stable launcher, and the startup mode follows the same environment decision (OS service / detached fallback).
 *
 */
async function runRestart(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  runtimeOptions: ServerCliRuntimeOptions,
): Promise<number> {
  await stopSupervisorAndWait(layout, "restart");
  return await runServe(["--daemon"], io, json, layout, runtimeOptions);
}

async function runUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<number> {
  const first = await (io.confirm?.("Type DELETE to uninstall ZCode Server: ") ??
    Promise.resolve(""));
  if (first !== "DELETE") throw new Error("Uninstall cancelled");
  const second = await (io.confirm?.("Type DELETE again to confirm: ") ?? Promise.resolve(""));
  if (second !== "DELETE") throw new Error("Uninstall cancelled");
  // The same --server-root must not be used both as the allowlist root and as the deletion target: containment
  // always holds, so any absolute directory could be recursively deleted by the uninstall flow. Install ownership must be verified before the service is stopped.
  const ownership = await validateServerInstallOwnership(layout);
  try {
    await runControl("confirm-uninstall", io, json, { confirmation: "DELETE" }, layout);
  } catch (error: unknown) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (isStoppedServerStatus(persisted.status))
      return await finishUninstall(io, json, layout, ownership);
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "active") {
      throw new Error(`Cannot uninstall while Server lock is held by pid ${lockInspection.pid}`, {
        cause: error,
      });
    }
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(
        `Cannot verify Server shutdown before uninstall (${describeLockInspection(lockInspection)})`,
        { cause: error },
      );
    }
  }
  await waitForServerStopped(layout);
  return await finishUninstall(io, json, layout, ownership);
}

async function finishUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  ownership: Awaited<ReturnType<typeof validateServerInstallOwnership>>,
): Promise<number> {
  await unregisterInstalledService(layout);
  const uninstallLock = await acquireUninstallLock(layout);
  // Root cause: deleting install.json creates a new device identity while the data is still retained, so the App archives the original connection and splits off a new device.
  // Formal uninstall removes only runtime assets; the identity is kept with user data, and the uninstall state stays protected by uninstalled.json.
  const uninstallEntries = [
    "releases",
    "run",
    "cache",
    "bin",
    "service",
    "current.json",
    "pending.json",
    "downgrade.json",
    "uninstalled.json",
    "update-transaction.json",
    "node",
    "zcode-server.cjs",
    "agents",
    "build",
    "tools",
  ] as const;
  try {
    for (const entry of uninstallEntries) {
      const target = validateUninstallTarget(
        ownership.canonicalServerRoot,
        join(ownership.canonicalServerRoot, entry),
      );
      if (!target.ok || !target.canonicalPath) {
        throw new Error(`Unsafe uninstall target: ${target.reason ?? "unknown"}`);
      }
      if (entry === "run") {
        await removeRunContentsExceptLock(layout);
      } else {
        await rm(target.canonicalPath, { recursive: true, force: true });
      }
    }
    const preservedPaths = (await readdir(ownership.canonicalServerRoot))
      .filter((entry) => entry !== "run")
      .sort();
    // A server root the user explicitly specified must not be recursively deleted with unknown contents. Uninstall cleans up only the ZCode allowlist above,
    // and writes the retained items into the result for the user to audit. The marker is written to disk first, then the lock is released,
    // so a concurrent Supervisor also fails closed in the final window while the run directory is being deleted.
    await writeFile(
      layout.uninstalledFile,
      `${JSON.stringify({ uninstalled: true, uninstalledAt: Date.now(), version: ZCODE_VERSION, preservedPaths }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await uninstallLock.release();
    await rm(layout.runDir, { recursive: true, force: true });
    if (json) stdout(io, { uninstalled: true, preservedPaths });
    else stdout(io, "uninstalled");
    return 0;
  } catch (error: unknown) {
    await uninstallLock.release().catch(() => undefined);
    throw error;
  }
}

// Bug cause: when Core startup failed, the Supervisor had already written the reason into status, but the CLI wait failure only reported
// "Timed out waiting for Server ready", so the 3.16.2 remote-timeout ticket could not tell why Core never came up.
// On failure, append the state and lastExitReason written during this startup; a stale pre-startup snapshot must not pass as this startup's cause.
function describeStartupStatus(status: ServerStatus | null, minUpdatedAt: number): string {
  if (!status || status.updatedAt <= minUpdatedAt) return "";
  return ` (state=${status.state}${status.lastExitReason ? `, last exit: ${status.lastExitReason}` : ""})`;
}

// The appended Core reason may contain text such as permission denied, ECONNREFUSED or timeout; when the Desktop guesses the category from that text,
// the UI title would change because of it. The category of the original first sentence is carried explicitly as a code (consistent with the Desktop's judgment before the detail was appended); the detail is for display only.
function startupWaitError(
  message: string,
  code: "remote-connection-timeout" | "remote-connection-unknown",
): Error {
  return Object.assign(new Error(message), { code });
}

async function waitForPersistedStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  expectedState: "ready" | "stopped",
  minUpdatedAt = 0,
  /** A non-empty return value means the awaited operation has failed; the value is the first sentence of the error, and the status detail is appended by this function. */
  readEarlyFailure?: () => string | undefined,
  expectedServiceRegistered?: boolean,
): Promise<ServerStatus> {
  const deadline = Date.now() + SERVER_READY_WAIT_TIMEOUT_MS;
  let lastStatus: ServerStatus | null = null;
  while (Date.now() < deadline) {
    const status = await readPersistedStatus(layout);
    if (
      status?.state === expectedState &&
      status.updatedAt > minUpdatedAt &&
      (expectedServiceRegistered === undefined ||
        status.serviceRegistered === expectedServiceRegistered)
    )
      return status;
    lastStatus = status ?? lastStatus;
    const earlyFailure = readEarlyFailure?.();
    if (earlyFailure) {
      // The final status the Supervisor wrote before exiting may land after this round's read, so read it again before reporting.
      const detail = describeStartupStatus(
        (await readPersistedStatus(layout)) ?? lastStatus,
        minUpdatedAt,
      );
      throw startupWaitError(
        `${earlyFailure}${detail || `; check ${layout.statusFile} for details`}`,
        "remote-connection-unknown",
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw startupWaitError(
    `Timed out waiting for Server ${expectedState}${describeStartupStatus(lastStatus, minUpdatedAt)}`,
    "remote-connection-timeout",
  );
}

// The reused Supervisor is already running and control is its live state; status.json may be a ready snapshot left by an old Supervisor
// (its port is no longer valid), and cannot serve as the readiness basis when reusing.
async function waitForControlReady(
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<ServerStatus> {
  const deadline = Date.now() + SERVER_READY_WAIT_TIMEOUT_MS;
  let lastStatus: ServerStatus | null = null;
  while (Date.now() < deadline) {
    const status = await readControlStatus(layout, 500);
    if (status?.state === "ready") return status;
    lastStatus = status ?? lastStatus;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  // The reused object is the running Supervisor and control returns its current state, so no startup-baseline filtering is needed.
  throw startupWaitError(
    `Timed out waiting for Server ready${describeStartupStatus(lastStatus, 0)}`,
    "remote-connection-timeout",
  );
}

async function waitForSupervisorReady(supervisor: {
  status: () => ServerStatus;
}): Promise<ServerStatus> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = supervisor.status();
    if (status.state === "ready") return status;
    if (status.state === "crash-loop-stopped")
      throw new Error("Server Core entered crash-loop-stopped");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Server Core ready");
}

async function readControlStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  timeoutMs: number,
): Promise<ServerStatus | null> {
  try {
    const result = await requestControl(layout.controlEndpoint, { command: "status" }, timeoutMs);
    return serverStatusSchema.parse(result);
  } catch {
    return null;
  }
}

async function delegateLegacyCli(argv: readonly string[], io: CliIO): Promise<number> {
  const candidate =
    process.env.ZCODE_LEGACY_CLI_ENTRY?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "zcode.cjs");
  try {
    await access(candidate);
  } catch {
    stdout(io, argv.length ? `Unknown command: ${argv[0]}` : "ZCode TUI");
    return argv.length ? 1 : 0;
  }
  const child = fork(candidate, [...argv], { stdio: "inherit" });
  return await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}
