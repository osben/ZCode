import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { applyBashSourcesToExecutionRequest } from "./bash-startup-script.js";
import { createBashResourceTelemetry } from "./bash-resource-telemetry.js";
import { createCwdCapturePlan } from "./cwd-capture.js";
import {
  applyResolvedShellCommand,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
import { NodeExecutionAdapterResults } from "./node-execution-adapter-results.js";
import { createExecutionOutputStreamDecoder } from "./outputEncoding.js";
import type { OutputCollector } from "./output-collector.js";
import {
  BASH_SIGTERM_TO_SIGKILL_MS,
  signalPosixProcessTree,
  terminateGenericPosixProcessGroup,
} from "./process-tree.js";
import {
  revalidateShellInitSnapshotForExecution,
  supportsShellInitSnapshot,
} from "./shell-init-snapshot.js";
import {
  IO_DRAIN_TIMEOUT_MS,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
  waitForPromise,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedChildSpawn,
} from "./execution-adapter-types.js";
import type { ExecutionRequest, ExecutionRunOptions } from "@zcode/contracts";

export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {
  protected trackBashResources(
    child: ChildProcess,
    isBash: boolean,
    stopState: () => { timedOut: boolean; killed: boolean },
  ): (state: ExitState) => void {
    if (!isBash || !this.options.onToolExecResource) return () => {};
    const telemetry = createBashResourceTelemetry({
      platform: this.platform,
      processGroupId: child.pid,
      onComplete: this.options.onToolExecResource,
    });
    return (state) => {
      const stop = stopState();
      telemetry.finish(
        stop.timedOut
          ? "timeout"
          : stop.killed || state.signal
            ? "killed"
            : state.error
              ? "error"
              : "completed",
      );
    };
  }

  protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {
    const env = buildExecutionEnv(request.env, {
      network: this.options.network,
      platform: this.platform,
      processEnv: this.processEnv,
    });
    const resolvedCommand = resolveExecutionCommand(request.command, {
      cwd: request.cwd,
      env,
      platform: this.platform,
    });
    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const snapshotEnv = resolvedCommand.envOverlay
      ? { ...env, ...resolvedCommand.envOverlay }
      : env;
    const shellInitSnapshot =
      request.command.mode === "shell" &&
      request.command.shellProfile === "posix-bash" &&
      resolvedCommand.shell === false &&
      supportsShellInitSnapshot(resolvedCommand.cwdDialect)
        ? await revalidateShellInitSnapshotForExecution(
            await this.shellInitSnapshots.getOrCreate({
              env: snapshotEnv,
              rootDir,
              shellDialect: resolvedCommand.cwdDialect,
              shellPath: resolvedCommand.file,
            }),
          )
        : undefined;
    const useLoginShell = shellInitSnapshot ? false : true;
    const resolvedShell = setResolvedShellLoginMode(resolvedCommand, useLoginShell);
    const requestWithSources = applyBashSourcesToExecutionRequest(request, {
      leadingSources: shellInitSnapshot
        ? [
            {
              optional: true,
              path: shellInitSnapshot.path,
              shellPath: shellInitSnapshot.shellPath,
            },
          ]
        : [],
      rootDir,
      sessionId,
      shellDialect: resolvedCommand.cwdDialect,
    });
    const capturePlan = createCwdCapturePlan(requestWithSources, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
    const command =
      capturePlan.command === requestWithSources.command
        ? requestWithSources.command.mode === "shell"
          ? applyResolvedShellCommand(resolvedShell, requestWithSources.command.command)
          : resolvedShell
        : resolveExecutionCommand(capturePlan.command, {
            cwd: request.cwd,
            env,
            platform: this.platform,
            resolvedShell,
          });
    const spawnEnv = command.envOverlay ? { ...env, ...command.envOverlay } : env;
    const baseOptions = {
      cwd: request.cwd,
      detached: this.platform !== "win32",
      env: spawnEnv,
      shell: command.shell,
      stdio: [
        request.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ] satisfies StdioOptions,
      windowsHide: true,
    };

    return {
      command,
      cwdDialect: command.cwdDialect,
      cwdFilePath: capturePlan.cwdFilePath,
      spawnOptions: baseOptions,
    };
  }

  protected terminateProcessTree(child: ChildProcess, useBashProcessTreeStop: boolean): void {
    if (!child.pid) {
      child.kill("SIGTERM");
      return;
    }

    if (this.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const completion = new Promise<void>((resolve) => {
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
        killer.once("close", () => resolve());
      });
      if (useBashProcessTreeStop) {
        // Direct writes no longer wait for pipe EOF, so shutdown must explicitly wait for taskkill
        // to finish before releasing resources.
        this.pendingBashProcessTreeKills.set(completion, killer);
        void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
      }
      return;
    }

    if (!useBashProcessTreeStop) {
      // PPID descendant enumeration only fixes cross-PGID cleanup for Bash job control. Generic
      // hooks, shells, and argv execution must retain their existing process-group boundaries so
      // this fix does not affect other callers.
      terminateGenericPosixProcessGroup(child);
      return;
    }

    const rootPid = child.pid;
    // Bash job control, pipelines, xargs, and PTYs can place workers in different PGIDs.
    // Each cleanup phase snapshots PPID descendants at that time instead of remembering process
    // identities across phases.
    void signalPosixProcessTree(rootPid, "SIGTERM");
    let timer!: NodeJS.Timeout;
    const escalation = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // A direct force group kill is best effort; the full process-tree kill still runs afterward.
        }
        // Shutdown waits for the lookup and signal delivery to finish; cleanup ownership must not be
        // released as soon as the asynchronous tree kill starts.
        void signalPosixProcessTree(rootPid, "SIGKILL").then(resolve);
      }, BASH_SIGTERM_TO_SIGKILL_MS);
      timer.unref?.();
    });
    this.pendingBashProcessTreeKills.set(escalation, timer);
    void escalation.finally(() => {
      this.pendingBashProcessTreeKills.delete(escalation);
    });
  }

  protected destroyChildOutputStreams(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  protected attachPipedOutput(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    encoding: string | null,
    options: ExecutionRunOptions,
  ): void {
    for (const [name, collector] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = child[name];
      const decoder = createExecutionOutputStreamDecoder(encoding);
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        collector.append(buffer, stream);
        this.emit(options, {
          type: name,
          chunk: buffer,
          text: decoder.write(buffer),
          timestamp: new Date(),
        });
      });
    }
  }

  protected writeChildInput(
    child: ChildProcess,
    input: ExecutionRequest["stdin"],
  ): () => Error | undefined {
    let failure: Error | undefined;
    if (input !== undefined && child.stdin) {
      const capture = (error: Error) => {
        failure ??= error;
      };
      // A hook can close stdin early; listen for asynchronous EPIPE so it cannot crash the Agent.
      child.stdin.on("error", capture);
      try {
        child.stdin.end(input);
      } catch (error) {
        capture(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return () => failure;
  }

  protected async drainChildOutput(
    child: ChildProcess,
    closed: Promise<void>,
    options: InternalExecutionRunOptions,
    terminationRequested: boolean,
  ): Promise<void> {
    if (await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS)) return;
    // Generic argv/hooks retain ownership of pipe EOF; Bash direct-to-file writes do not use this path.
    if (options.shouldRetainExecutionAfterRootExit?.() === true) {
      await closed;
      return;
    }
    if (!terminationRequested) this.terminateProcessTree(child, false);
    if (!(await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS))) this.destroyChildOutputStreams(child);
  }
}
