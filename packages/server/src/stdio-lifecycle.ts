import type { Readable } from "node:stream";

const TERMINATION_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
const DEFAULT_RPC_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS = 3_500;

type StdioShutdownPhase = "rpc-stop" | "service-dispose";

interface StdioProcessSignalSource {
  on(signal: (typeof TERMINATION_SIGNALS)[number], listener: () => void): unknown;
}

interface StdioProcessLifecycleOptions {
  stdin: Readable;
  signalSource: StdioProcessSignalSource;
  log: (...args: unknown[]) => void;
  stopRpc: () => Promise<void>;
  dispose: () => Promise<void>;
  exit: (code: number) => never | void;
  shutdownTimeoutMs?: number;
  rpcStopTimeoutMs?: number;
  serviceDisposeTimeoutMs?: number;
}

export function registerStdioProcessLifecycle(options: StdioProcessLifecycleOptions): void {
  const { stdin, signalSource, log, stopRpc, dispose, exit } = options;
  const rpcStopTimeoutMs = Math.max(
    options.rpcStopTimeoutMs ?? options.shutdownTimeoutMs ?? DEFAULT_RPC_STOP_TIMEOUT_MS,
    0,
  );
  const serviceDisposeTimeoutMs = Math.max(
    options.serviceDisposeTimeoutMs ??
      options.shutdownTimeoutMs ??
      DEFAULT_SERVICE_DISPOSE_TIMEOUT_MS,
    0,
  );
  let shutdownStarted = false;
  let requestedExitCode = 0;

  const requestShutdown = (exitCode: number): void => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    void (async () => {
      const runPhase = async (
        phase: StdioShutdownPhase,
        operation: () => Promise<void>,
        failureMessage: string,
        timeoutMs: number,
      ): Promise<boolean> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const operationResult = operation().then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        const timedOut = new Promise<{ kind: "timed-out" }>((resolve) => {
          // Do not unref the timer; if an external Promise stays pending forever, the timer must still guarantee shutdown.
          timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
        });
        const result = await Promise.race([operationResult, timedOut]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result.kind === "timed-out") {
          log("stdio shutdown timed out", { phase, timeoutMs });
          return false;
        }
        if (result.kind === "failed") {
          log(failureMessage, result.error);
          return false;
        }
        return true;
      };

      // Do not put the entire cleanup behind one race; if stopRpc times out and exits immediately,
      // service disposal never gets a chance to close Agent child processes. Bound and advance the two external async boundaries independently.
      if (
        !(await runPhase("rpc-stop", stopRpc, "stdio shutdown RPC stop failed", rpcStopTimeoutMs))
      ) {
        requestedExitCode = 1;
      }
      if (
        !(await runPhase(
          "service-dispose",
          dispose,
          "stdio shutdown cleanup failed",
          serviceDisposeTimeoutMs,
        ))
      ) {
        requestedExitCode = 1;
      }
      log("stdio shutdown completed", { exitCode: requestedExitCode });
      exit(requestedExitCode);
    })();
  };

  // An idle remote project may have no client-to-server RPC input for a long time while its window remains open.
  // Do not exit based on idle time; stop the remote server only when stdio closes explicitly or errors,
  // so the remote connection lifetime follows the user closing the project/app or the underlying SSH disconnect.
  stdin.on("end", () => {
    log("stdin closed, shutting down");
    requestShutdown(0);
  });
  stdin.on("error", (error) => {
    log("stdin error, shutting down", error);
    requestShutdown(1);
  });
  for (const signal of TERMINATION_SIGNALS) {
    signalSource.on(signal, () => {
      // SSH disconnects may appear as stdin EOF on some sshd/shell combinations, or as a signal sent to the foreground process on others.
      // Both entry points must use the same idempotent cleanup path, or a detached Agent can outlive its parent as an orphan.
      log("termination signal received, shutting down", signal);
      requestShutdown(1);
    });
  }
}
