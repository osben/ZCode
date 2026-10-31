import type { SourceServerRunningTask } from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- The Supervisor centrally maintains the lifecycle, Core generations and the update rollback state machine; the startup recovery and lock boundary fixes must not split its atomic flow. */

import { type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServiceLogger } from "@zcode/services/node";
import { SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE } from "@zcode/shared";
import {
  CORE_HEARTBEAT_INTERVAL_MS,
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  CORE_UNRESPONSIVE_HEARTBEAT_PERIODS,
  coreMessageSchema,
  SERVER_CLI_PROTOCOL_VERSION,
  type ControlRequest,
  type LifecycleState,
  type ReleaseManifest,
  type RuntimeIdentity,
  type ServerStatus,
} from "../contracts.js";
import { createControlServer, type ControlHandler } from "../ipc/controlServer.js";
import { ControlRequestError } from "../ipc/controlError.js";
import { DataRootLock, type DataRootLockLoss } from "../runtime/lock.js";
import { resolveServerLayout, type ServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createStatusPersister } from "../runtime/statusSnapshot.js";
import { recoverSupervisorStartup } from "../runtime/startupRecovery.js";
import { waitForUpdateReady } from "../runtime/updateReadiness.js";
import { createRollbackFailure, updateErrorMessage } from "../runtime/updateErrors.js";
import { CrashBudget } from "./crashBudget.js";

// Lifecycle events use info/warn/error by operational troubleshooting criteria (operators must be able to see them in the log when something goes wrong);
// high-frequency heartbeat/task-activity details go to debug to avoid bloating the production log.
const log = createServiceLogger("server-supervisor");

export interface CoreLauncher {
  launch(generation: number, release?: ReleaseManifest | null): ChildProcess;
}

export interface SupervisorOptions {
  layout?: ServerLayout;
  launcher: CoreLauncher;
  version: string;
  /** The immutable release this Supervisor bundle belongs to; the development entry point may leave it unset. */
  supervisorReleaseId?: string;
  serviceRegistered?: boolean;
  /** Tests and diagnostics may shorten the ready wait; production defaults to CORE_READY_TIMEOUT_MS. */
  coreReadyTimeoutMs?: number;
  /** Tests may shorten the Core graceful exit and the terminal-state wait after a force kill; production defaults to the stop budgets in contracts. */
  coreStopGraceTimeoutMs?: number;
  coreKillTimeoutMs?: number;
  now?: () => number;
  onStopped?: () => void;
  /**
   * The data-root lock on the path no longer belongs to this instance; the Core has been stopped
   * and the caller ends the process according to the reason: exit non-zero on "missing" so the
   * service manager starts a new owner, exit 0 on "taken" because a new owner already runs.
   */
  onServerRootLost?: (loss: DataRootLockLoss) => void;
}

// The control `restart` that restarted only the Core has been removed (R2 §8.1): restarting the whole process tree is coordinated by the CLI that issues the command.
type LifecycleOperationKind = "stop" | "update" | "uninstall";

export class Supervisor {
  private readonly layout: ServerLayout;
  private readonly lock: DataRootLock;
  private readonly crashBudget: CrashBudget;
  private readonly releaseManager: ReleaseManager;
  private core: ChildProcess | undefined;
  private control: Awaited<ReturnType<typeof createControlServer>> | undefined;
  private state: LifecycleState = "stopped";
  private generation = 0;
  private host: string | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private runningTaskCount = 0;
  private runningTasks: SourceServerRunningTask[] | undefined;
  private lastExitReason: string | null = null;
  private readonly persistStatusSnapshot: () => Promise<void>;
  private lifecycleOperation:
    | { kind: LifecycleOperationKind; promise: Promise<unknown> }
    | undefined;
  private activeRelease: ReleaseManifest | null = null;
  private coreVersion: string | undefined;
  private coreReleaseId: string | undefined;
  /**
   * Fatal reason summary for the current core: either the fatal reported by the Core via IPC, or an
   * unresponsive judgment made by the Supervisor; cleared with the core scope and folded into
   * lastExitReason when the Core exits.
   */
  private coreFatalMessage: string | undefined;
  /** Consecutive heartbeat periods in which the ready Core has sent no IPC message; cleared with the core scope. */
  private coreSilentPeriods = 0;
  private coreLivenessTimer: NodeJS.Timeout | undefined;
  private serverRootLost = false;

  public constructor(private readonly options: SupervisorOptions) {
    this.layout = options.layout ?? resolveServerLayout();
    this.lock = new DataRootLock(this.layout.lockFile);
    this.crashBudget = new CrashBudget({ now: options.now });
    this.releaseManager = new ReleaseManager(this.layout);
    this.persistStatusSnapshot = createStatusPersister(
      this.layout.statusFile,
      () => this.status(),
      (error) => log.warn("failed to persist status snapshot", error),
      () => this.ownsServerRoot(),
    );
  }

  private async ownsServerRoot(): Promise<boolean> {
    // While the daemon runs, the server root can be deleted or replaced: this instance's lock,
    // control socket and the ingress-token written by the Core vanish with the old directory, yet
    // the Supervisor keeps writing ready snapshots with the old port into the new root's
    // status.json. probe and serve --daemon then treat that snapshot as the new root's daemon and
    // fail reading the token; the OS service unit stays active so start never spawns a real owner,
    // and every reconnect repeats the failure. Confirm the lock on the path is still ours before
    // each snapshot write; once it is not, stop writing, stop the Core and end the process so the
    // service manager or the next serve --daemon starts the actual owner.
    if (this.serverRootLost) return false;
    const loss = await this.lock.readLoss();
    if (!loss) return true;
    this.serverRootLost = true;
    void this.stepDownAfterServerRootLost(loss);
    return false;
  }

  private async stepDownAfterServerRootLost(loss: DataRootLockLoss): Promise<void> {
    log.error("data-root lock is gone or owned by another instance; stopping this supervisor", {
      serverRoot: this.layout.serverRoot,
      loss,
    });
    // Deliberately not stopInternal: control.close() and lock release clean up by path, and the
    // socket and lock on that path may already belong to the new owner.
    await this.stopCore("server root lost").catch((error: unknown) => {
      log.error("failed to stop server core after server root was lost", error);
    });
    this.options.onServerRootLost?.(loss);
  }

  public async start(): Promise<ServerStatus> {
    if (this.state === "ready" || this.state === "starting") return this.status();
    await this.releaseManager.ensure();
    await this.lock.acquire();
    try {
      // Startup recovery rewrites current.json and deletes update-transaction.json, so it must first acquire
      // the data-root single-instance lock; otherwise a live Supervisor's apply-update would race with a second starter,
      // leaving the in-memory process running the new release while the disk current pointer is rolled back to the old release.
      await recoverSupervisorStartup(
        this.releaseManager,
        this.layout.uninstalledFile,
        this.layout.serverRoot,
        async (error) => {
          this.state = "stop-failed";
          this.lastExitReason = `update rollback recovery failed: ${updateErrorMessage(error)}`;
          await this.persistStatusSnapshot();
        },
      );
      // Recovery may already have restored the current pointer; read it after recovery so a rolled-back candidate is not started.
      this.activeRelease = await this.releaseManager.readCurrentForExecution();
      await mkdir(this.layout.runDir, { recursive: true, mode: 0o700 });
      const handler: ControlHandler = (request) => this.handleControl(request);
      this.control = await createControlServer(this.layout.controlEndpoint, handler);
      this.state = "starting";
      log.info("supervisor started", {
        serverRoot: this.layout.serverRoot,
        version: this.options.version,
      });
      this.launchCore();
      await this.persistStatusSnapshot();
      return this.status();
    } catch (error) {
      // Releasing the lock only when recovery fails is not enough: a failure in mkdir, the control server, Core startup or
      // the initial state write leaves the lock behind (and possibly an already-started Core), and a retry by the same Supervisor would identify
      // itself as another instance. The startup critical section may release the lock only after Core/control are confirmed closed out.
      const recoveryFailed = this.state === "stop-failed";
      let coreStopped = this.core === undefined;
      if (this.core) {
        try {
          await this.stopCore("startup-failed");
          coreStopped = true;
        } catch (stopError) {
          log.error("failed to stop Core after supervisor startup failure", stopError);
        }
      }

      let controlClosed = this.control === undefined;
      if (this.control) {
        try {
          await this.control.close();
          this.control = undefined;
          controlClosed = true;
        } catch (closeError) {
          log.error("failed to close control server after supervisor startup failure", closeError);
        }
      }

      if (coreStopped && controlClosed) {
        // Recovery failure itself has already written stop-failed; even when no Core/control needs closing out, keep that
        // state so status keeps exposing the transaction that needs manual handling, while releasing the lock lets the same instance retry later.
        this.state = recoveryFailed ? "stop-failed" : "stopped";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stopped state after supervisor startup failure",
            snapshotError,
          );
        });
        await this.lock.release();
      } else {
        this.state = "stop-failed";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stop-failed state after supervisor startup failure",
            snapshotError,
          );
        });
      }
      throw error;
    }
  }

  public async stop(reason = "requested"): Promise<ServerStatus> {
    return await this.runLifecycleOperation("stop", () => this.stopInternal(reason));
  }

  private async stopInternal(reason: string): Promise<ServerStatus> {
    if (!this.core) {
      this.state = "stopped";
      await this.persistStatusSnapshot();
      await this.control?.close();
      this.control = undefined;
      await this.lock.release();
      this.options.onStopped?.();
      return this.status();
    }
    await this.stopCore(reason);
    this.state = "stopped";
    await this.persistStatusSnapshot();
    await this.control?.close();
    this.control = undefined;
    await this.lock.release();
    log.info("supervisor stopped", { reason });
    this.options.onStopped?.();
    return this.status();
  }

  private async stopCore(reason: string): Promise<void> {
    if (!this.core) return;
    this.state = "stopping";
    this.lastExitReason = reason;
    log.info("stopping server core", { reason, pid: this.core.pid });
    const core = this.core;
    try {
      await new Promise<void>((resolve, reject) => {
        // After sending SIGKILL we must not return unconditionally after at most two seconds: if no child terminal state was observed,
        // the data-root lock would be released and a second Core could start. Only exit/close proves the process has closed out;
        // if there is still no terminal state after the force kill, fail and keep the Core reference and the lock.
        let killTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(graceTimer);
          if (killTimer) clearTimeout(killTimer);
          core.off("exit", finish);
          core.off("close", finish);
          core.off("error", handleError);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error(`Server Core pid ${core.pid ?? "unknown"} did not terminate after SIGKILL`),
          );
        };
        const handleError = (error: Error): void => {
          log.warn("server core emitted an error while stopping; awaiting exit or close", error);
        };
        const forceKill = (): void => {
          log.warn("server core did not exit within grace period, sending SIGKILL", {
            pid: core.pid,
          });
          core.kill("SIGKILL");
          if (!settled) {
            killTimer = setTimeout(fail, this.options.coreKillTimeoutMs ?? CORE_KILL_TIMEOUT_MS);
          }
        };
        const graceTimer = setTimeout(() => {
          forceKill();
        }, this.options.coreStopGraceTimeoutMs ?? CORE_STOP_GRACE_TIMEOUT_MS);
        core.once("exit", finish);
        core.once("close", finish);
        core.once("error", handleError);
        try {
          core.send({ command: "shutdown" });
        } catch {
          // IPC being closed does not mean the OS process has exited; after a force kill, still wait for the exit/close terminal state.
          clearTimeout(graceTimer);
          forceKill();
        }
      });
    } catch (error) {
      if (this.core === core) {
        this.state = "stop-failed";
        this.lastExitReason = error instanceof Error ? error.message : String(error);
        await this.persistStatusSnapshot();
      }
      throw error;
    }
    if (this.core === core) {
      this.core = undefined;
      this.clearCoreScopedStatus();
    }
  }

  private async applyUpdate(force: boolean): Promise<unknown> {
    const pending = await this.releaseManager.readPending();
    if (!pending) throw new Error("No pending release is prepared");
    if (this.runningTaskCount > 0 && !force) {
      throw new ControlRequestError(
        SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
        "Running tasks require --force for update",
        false,
      );
    }
    const previous = await this.releaseManager.readCurrent();
    log.info("applying pending release", { version: pending.version, force });
    await this.stopCore("update");
    this.state = "updating";
    await this.persistStatusSnapshot();
    try {
      await this.releaseManager.applyPendingWithTransaction(previous);
      this.activeRelease = pending;
      this.state = "starting";
      this.launchCore();
      await waitForUpdateReady(
        () => this.state,
        this.options.coreReadyTimeoutMs ?? CORE_READY_TIMEOUT_MS,
      );
      await this.releaseManager.completeUpdate();
      log.info("release applied", { version: pending.version });
      return { applied: true, version: pending.version };
    } catch (error) {
      this.enterUpdateRollback();
      // If the updated Core is not ready, the still-living child process must be stopped before the current pointer is restored;
      // otherwise the timeout path overwrites the this.core reference and leaves the new Core alive alongside the rolled-back old Core.
      if (this.core) {
        try {
          await this.stopCore("update-rollback");
        } catch (stopError) {
          log.error("failed to stop unhealthy release during rollback", stopError);
          await this.persistStatusSnapshot();
          throw stopError;
        }
      }
      // Restore the current pointer so the next start does not keep using the bad release.
      log.error("release apply failed, restoring previous current pointer", error);
      try {
        await this.releaseManager.restoreCurrent(previous);
        await this.releaseManager.completeUpdate();
      } catch (rollbackError: unknown) {
        this.state = "stop-failed";
        this.lastExitReason = `rollback pointer restore failed: ${updateErrorMessage(rollbackError)}`;
        await this.persistStatusSnapshot();
        throw createRollbackFailure(error, rollbackError);
      }
      this.activeRelease = previous;
      // Rollback not only restores the pointer but also immediately relaunches the old release; otherwise the daemon would stay stopped
      // in an unusable state, and the user would have to restart manually to recover the service.
      this.state = "stopped";
      if (previous) {
        this.state = "starting";
        this.launchCore();
        try {
          await waitForUpdateReady(
            () => this.state,
            this.options.coreReadyTimeoutMs ?? CORE_READY_TIMEOUT_MS,
          );
        } catch (rollbackError) {
          log.error("previous release rollback failed", rollbackError);
          // If the old release times out waiting for ready, changing only the state would leave the still-living Core, PID and lock out of sync with stopped; reuse stopCore to wait for exit/close, and keep stop-failed if that fails.
          if (this.core) await this.stopCore("update-rollback");
          this.state = "stopped";
        }
      }
      await this.persistStatusSnapshot();
      throw error;
    }
  }

  public status(): ServerStatus {
    return {
      protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
      state: this.state,
      pid: this.core?.pid ?? null,
      port: this.port,
      host: this.host,
      // status.version keeps the compatibility meaning of Core/current release; the Supervisor's own version and release
      // are returned by the independent runtime-identity control, so the strict persisted schema gains no field that would break older-version rollback.
      version: this.activeRelease?.version ?? this.options.version,
      generation: this.generation,
      startedAt: this.startedAt,
      lastExitReason: this.lastExitReason,
      serviceRegistered: this.options.serviceRegistered ?? false,
      runningTaskCount: this.runningTaskCount,
      crashBudget: this.crashBudget.snapshot(),
      updatedAt: Date.now(),
    };
  }

  private runtimeIdentity(): RuntimeIdentity {
    return {
      supervisorVersion: this.options.version,
      ...(this.options.supervisorReleaseId
        ? { supervisorReleaseId: this.options.supervisorReleaseId }
        : {}),
      ...(this.activeRelease?.version ? { activeReleaseVersion: this.activeRelease.version } : {}),
      ...(this.activeRelease?.releaseId ? { activeReleaseId: this.activeRelease.releaseId } : {}),
      ...(this.coreVersion ? { coreVersion: this.coreVersion } : {}),
      ...(this.coreReleaseId ? { coreReleaseId: this.coreReleaseId } : {}),
    };
  }

  private launchCore(): void {
    const generation = ++this.generation;
    const child = this.options.launcher.launch(generation, this.activeRelease);
    this.core = child;
    this.clearCoreScopedStatus();
    log.info("launching server core", { generation, pid: child.pid });
    child.on("message", (raw: unknown) => this.handleCoreMessage(child, generation, raw));
    let terminalObserved = false;
    let spawnErrorReason: string | undefined;
    const handleTerminal = (reason: string): void => {
      if (terminalObserved) return;
      terminalObserved = true;
      if (this.core !== child || this.state === "stopping" || this.state === "stopped") return;
      // Bug cause: when the Core fails to start it sends fatal before exiting; the old logic
      // overwrote the fatal with the exit code, leaving status with only "core exited code=1"
      // so the CLI and remote clients could never see why the Core failed to come up.
      // Keep the fatal appended after the exit code, bounded by the 500-char status schema cap.
      const exitReason = this.coreFatalMessage
        ? `${reason}: ${this.coreFatalMessage}`.slice(0, 500)
        : reason;
      if (this.state === "stop-failed") {
        // While stop has failed, keep the lock; a late terminal state only clears the dead child and must not count toward the crash budget
        // or start a replacement Core. Release the control socket and data-root lock only after the user retries stop.
        this.core = undefined;
        this.clearCoreScopedStatus();
        this.lastExitReason = exitReason;
        void this.persistStatusSnapshot();
        return;
      }
      this.core = undefined;
      this.clearCoreScopedStatus();
      this.state = "crashed";
      this.lastExitReason = exitReason;
      const decision = this.crashBudget.recordCrash();
      if (!decision.shouldRestart) {
        this.state = "crash-loop-stopped";
        log.error("server core crash budget exhausted, entering crash-loop-stopped", {
          lastExitReason: this.lastExitReason,
        });
        void this.persistStatusSnapshot();
        return;
      }
      log.warn("server core crashed, scheduling restart", {
        lastExitReason: this.lastExitReason,
        delayMs: decision.delayMs,
      });
      void this.persistStatusSnapshot();
      setTimeout(() => {
        if (this.state !== "crashed") return;
        this.state = "starting";
        this.launchCore();
      }, decision.delayMs).unref();
    };
    // When the forked child's execPath does not exist or is not executable, Node emits only error + close, not exit.
    // error and exit must share a one-time terminal state; otherwise an unhandled error would kill the Supervisor, and the
    // new current pointer already written by the update would bypass catch/rollback.
    child.once("error", (error: Error & { code?: string }) => {
      spawnErrorReason = `core spawn error code=${error.code ?? "unknown"}: ${error.message}`;
      this.lastExitReason = spawnErrorReason;
      log.error("server core process error", error);
      void this.persistStatusSnapshot();
    });
    child.once("exit", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core exited code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    child.once("close", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core closed code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
  }

  private handleCoreMessage(child: ChildProcess, expectedGeneration: number, raw: unknown): void {
    // The old child's message listener survives across generations, so a delayed heartbeat/ready
    // could overwrite the current Core's state. Messages must be bound to the current child too; ready must also match the startup generation.
    if (this.core !== child) return;
    // Any IPC message from the current Core proves that its event loop is running.
    this.coreSilentPeriods = 0;
    const parsed = coreMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === "ready") {
      // ready is valid only for the Core currently starting; late messages in the stopping/stopped/stop-failed phases
      // must not revive a Supervisor that has already closed out or entered an uncertain terminal state.
      if (message.generation !== expectedGeneration || this.state !== "starting") return;
      this.state = "ready";
      this.host = message.host;
      this.port = message.port;
      this.generation = message.generation;
      this.startedAt = Date.now();
      this.coreVersion = message.version;
      this.coreReleaseId = message.releaseId;
      this.watchCoreLiveness(child);
      log.info("server core ready", {
        host: this.host,
        port: this.port,
        generation: this.generation,
      });
    } else if (message.type === "heartbeat" || message.type === "task-activity") {
      this.runningTaskCount = message.runningTaskCount;
      this.runningTasks = message.runningTasks;
      log.debug("core activity snapshot", {
        type: message.type,
        runningTaskCount: message.runningTaskCount,
      });
    } else if (message.type === "fatal") {
      this.coreFatalMessage = message.message;
      this.lastExitReason = message.message;
      log.error("server core reported fatal error", { message: message.message });
    } else if (message.type === "exit") {
      this.lastExitReason = message.reason;
      log.info("server core reported exit", { reason: message.reason });
    }
    void this.persistStatusSnapshot();
  }

  private enterUpdateRollback(): void {
    // After a candidate Core crashes, handleTerminal sets the state to crashed and schedules an automatic restart;
    // during rollback file operations it must leave crashed first, otherwise the timer would relaunch Core using the bad activeRelease.
    if (this.state === "crashed") this.state = "updating";
  }

  private watchCoreLiveness(child: ChildProcess): void {
    // Bug cause (ZCT-2113570821476302848): when the Core's event loop is saturated by synchronous work, the process still exists but sends no heartbeat,
    // does not answer the handshake, and cannot run the JS-level SIGTERM handler. The Supervisor only enters the crash budget when the Core exits;
    // status keeps reporting ready, the serve --daemon fallback on the Desktop only reuses the same port, and the device could only be recovered by a manual kill -9.
    // Fix: after ready, count heartbeat periods and SIGKILL once N consecutive periods pass with no IPC message at all, so the existing exit
    // handling restarts it as a crash. Only periods are counted, not clock time: when the Supervisor itself is suspended the check does not run, so suspended time is not counted as silence.
    if (this.coreLivenessTimer) clearInterval(this.coreLivenessTimer);
    const timer = setInterval(() => {
      if (this.core !== child || this.state !== "ready") return;
      this.coreSilentPeriods += 1;
      if (this.coreSilentPeriods < CORE_UNRESPONSIVE_HEARTBEAT_PERIODS) return;
      clearInterval(timer);
      this.coreLivenessTimer = undefined;
      const silentMs = this.coreSilentPeriods * CORE_HEARTBEAT_INTERVAL_MS;
      this.coreFatalMessage = `core unresponsive: no IPC message for ${silentMs}ms`;
      log.warn("server core unresponsive, sending SIGKILL", {
        pid: child.pid,
        generation: this.generation,
        silentMs,
      });
      child.kill("SIGKILL");
    }, CORE_HEARTBEAT_INTERVAL_MS);
    timer.unref();
    this.coreLivenessTimer = timer;
  }

  private clearCoreScopedStatus(): void {
    if (this.coreLivenessTimer) clearInterval(this.coreLivenessTimer);
    this.coreLivenessTimer = undefined;
    this.coreSilentPeriods = 0;
    this.host = null;
    this.port = null;
    this.startedAt = null;
    this.runningTaskCount = 0;
    this.runningTasks = undefined;
    this.coreVersion = undefined;
    this.coreReleaseId = undefined;
    this.coreFatalMessage = undefined;
  }

  private async handleControl(request: ControlRequest): Promise<unknown> {
    switch (request.command) {
      case "ping":
        return { protocolVersion: SERVER_CLI_PROTOCOL_VERSION };
      case "status":
        return this.status();
      case "running-tasks":
        return this.runningTasks ?? null;
      case "runtime-identity":
        return this.runtimeIdentity();
      case "stop":
        this.startAcknowledgedLifecycleOperation("stop", () =>
          this.stopInternal("control request"),
        );
        return { stopping: true };
      case "prepare-update":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "apply-update":
        return await this.runLifecycleOperation("update", () =>
          this.applyUpdate(request.force === true),
        );
      case "prepare-uninstall":
        return {
          status: this.runningTaskCount ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "confirm-uninstall":
        if (request.confirmation !== "DELETE")
          throw new Error("Uninstall confirmation must be DELETE");
        // Bug fix: the spec requires checking running tasks before uninstall (R2-CLI-10). The old implementation only had
        // prepare-uninstall return blocked, which no caller consumed, so confirm-uninstall
        // stopped the Core and deleted data directly, interrupting running tasks without notice. The guard is enforced here at the last line of defense:
        // when running tasks exist, return a structured error and keep the original state.
        if (this.runningTaskCount > 0) {
          throw new Error(
            `Cannot uninstall while ${this.runningTaskCount} task(s) are running; stop the server first`,
          );
        }
        log.info("uninstall confirmed, stopping server");
        this.startAcknowledgedLifecycleOperation("uninstall", () => this.stopInternal("uninstall"));
        return { uninstalled: true };
    }
  }

  private runLifecycleOperation<T>(
    kind: LifecycleOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertLifecycleOperationCanStart(kind);
    const active = this.lifecycleOperation;
    if (active) {
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(operation);
    this.lifecycleOperation = { kind, promise };
    void promise.then(
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
      () => {
        if (this.lifecycleOperation?.promise === promise) this.lifecycleOperation = undefined;
      },
    );
    return promise;
  }

  private startAcknowledgedLifecycleOperation(
    kind: LifecycleOperationKind,
    operation: () => Promise<unknown>,
  ): void {
    // Ack-style requests must also check the gate before the reply; a background Promise that rejects afterwards would make the client believe
    // stop/uninstall was accepted, while the conflict was actually left only in the Supervisor log.
    this.assertLifecycleOperationCanStart(kind);
    const started = this.runLifecycleOperation(kind, async () => {
      // The control response must be written back on the original socket first; closing the control server directly would deadlock with dispatch.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await operation();
    });
    void started.catch((error: unknown) => {
      log.error(`lifecycle operation ${kind} failed`, error);
    });
  }

  private assertLifecycleOperationCanStart(kind: LifecycleOperationKind): void {
    const active = this.lifecycleOperation;
    if (!active || (kind === "stop" && active.kind === "stop")) return;
    throw new ControlRequestError(
      "operation-in-progress",
      `Lifecycle operation ${active.kind} is already in progress`,
      true,
    );
  }
}
