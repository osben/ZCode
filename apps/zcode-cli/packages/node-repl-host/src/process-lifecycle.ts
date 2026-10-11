const processGuardInstalled = new WeakSet<object>();
const OUTPUT_CLOSED_ERROR_CODES = new Set([
  "EPIPE",
  "EIO",
  "ENXIO",
  "EBADF",
  "ERR_STREAM_DESTROYED",
]);

/**
 * NodeReplSession handles synchronous errors from a REPL cell, but fire-and-forget
 * asynchronous errors (such as an unawaited tab.* call rejected when a turn is
 * interrupted) can terminate the entire server process under Node's default policy.
 * Once the child process dies, Browser Use is unavailable for the session. Downgrade
 * asynchronous errors to stderr logs here, preserving runtime state without affecting
 * protocol stdout.
 *
 * After the parent exits, stderr reports EPIPE. The old handler wrote the EPIPE stack
 * back to the same stderr, creating an infinite EPIPE -> uncaughtException ->
 * stderr.write -> EPIPE loop. A closed output pipe means the MCP client is unreachable;
 * shut down immediately instead of continuing to write diagnostics.
 */
export function installNodeReplProcessGuards(input: {
  onOutputClosed: (error: Error) => void;
  process: Pick<NodeJS.Process, "on">;
  writeStderr: (text: string) => void;
}): void {
  if (processGuardInstalled.has(input.process)) return;
  processGuardInstalled.add(input.process);

  let outputClosed = false;
  const describe = (reason: unknown): string =>
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  const report = (kind: "uncaughtException" | "unhandledRejection", reason: unknown): void => {
    if (outputClosed) return;
    if (isOutputClosedError(reason)) {
      outputClosed = true;
      input.onOutputClosed(reason);
      return;
    }

    try {
      input.writeStderr(`node_repl ${kind} (process kept alive): ${describe(reason)}\n`);
    } catch (error) {
      if (!isOutputClosedError(error)) throw error;
      outputClosed = true;
      input.onOutputClosed(error);
    }
  };
  input.process.on("unhandledRejection", (reason) => {
    report("unhandledRejection", reason);
  });
  input.process.on("uncaughtException", (error) => {
    report("uncaughtException", error);
  });
}

function isOutputClosedError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && OUTPUT_CLOSED_ERROR_CODES.has(code);
}

export function installNodeReplShutdownTriggers(input: {
  process: Pick<NodeJS.Process, "once">;
  shutdown: () => void;
  stdin: Pick<NodeJS.ReadStream, "once">;
}): void {
  let shutdownStarted = false;
  const shutdownOnce = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    input.shutdown();
  };

  // The MCP SDK stdio transport does not listen for stdin end/close. If the parent exits
  // unexpectedly, the runtime otherwise never receives a lifecycle end and becomes an orphan.
  input.stdin.once("end", shutdownOnce);
  input.stdin.once("close", shutdownOnce);
  input.process.once("SIGINT", shutdownOnce);
  input.process.once("SIGTERM", shutdownOnce);
}

export async function isDirectMcpEntrypoint(
  importMetaUrl: string,
  argvPath: string | undefined,
): Promise<boolean> {
  if (!argvPath) return false;
  try {
    // On macOS, paths such as /tmp and /var resolve to /private/...; comparing file URLs
    // directly makes the stdio child process incorrectly detect itself as imported, so
    // main never starts and it exits without an error. Async realpath also supports
    // symlinked install directories and avoids synchronous file I/O during module evaluation.
    const [modulePath, executablePath] = await Promise.all([
      realpath(fileURLToPath(importMetaUrl)),
      realpath(argvPath),
    ]);
    return modulePath === executablePath;
  } catch {
    return false;
  }
}
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
