/**
 * Process transport: spawn, NDJSON framing, stderr tail.
 *
 * The child runs with `shell: false`; on POSIX it is detached into its own
 * process group so the whole tree can be signalled on teardown.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { AcpSpawnError } from "./errors.js";

export const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STDERR_TAIL_CHARS = 64 * 1024;

export interface SpawnedAcpProcess {
  readonly child: ChildProcess;
  readonly stream: Stream;
  /** Rejects when the child fails to spawn (e.g. ENOENT); consumed by racing handshake steps. */
  readonly spawnFailure: Promise<never>;
  /** Resolves once the child exits. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Collected tail of the child's stderr. */
  stderrTail(): string;
}

export interface SpawnAcpProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly maxFrameBytes?: number;
}

export function spawnAcpProcess(input: SpawnAcpProcessInput): SpawnedAcpProcess {
  let child: ChildProcess;
  try {
    child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    throw new AcpSpawnError(`Failed to spawn ${input.command}`, { cause: error });
  }
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    throw new AcpSpawnError(`Failed to spawn ${input.command}: stdio pipes are unavailable`);
  }

  const spawnFailure = new Promise<never>((_, reject) => {
    child.once("error", (error: Error) => {
      reject(
        new AcpSpawnError(`Failed to spawn ${input.command}: ${error.message}`, { cause: error }),
      );
    });
  });
  // Callers race this against handshake steps; keep a handler so an early
  // failure never surfaces as an unhandled rejection.
  spawnFailure.catch(() => {});

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("close", () => resolve({ code: child.exitCode, signal: child.signalCode }));
    // A failed spawn emits `error` (usually without an `exit`); resolve so
    // teardown never waits on a process that never started.
    child.once("error", () => resolve({ code: child.exitCode, signal: child.signalCode }));
  });

  const stderrTail = createStderrTail(stderr, DEFAULT_STDERR_TAIL_CHARS);
  const stream = ndJsonStream(
    Writable.toWeb(stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>,
    { maxMessageBytes: input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES },
  );

  return { child, stream, spawnFailure, exited, stderrTail };
}

export const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

/** `taskkill /T` walks the tree; `/F` forces it on the SIGKILL escalation stage. */
export function buildWindowsTaskkillArgs(pid: number, signal: NodeJS.Signals): readonly string[] {
  return ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
}

async function runWindowsTaskkill(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn("taskkill", [...buildWindowsTaskkillArgs(pid, signal)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(false);
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/**
 * Sends a signal to the whole process tree; resolves once a Windows `taskkill`
 * run finished. On POSIX the group signal (or the direct child as fallback) is
 * synchronous; Windows has no process groups (`detached` is unavailable), so
 * the tree is terminated by pid with the system `taskkill` — the same strategy
 * as `packages/services/src/process/processTreeTerminator.ts`. The base
 * package cannot import that module (services depends on it, not vice versa),
 * so the equivalent logic lives here.
 */
export async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const terminated = await runWindowsTaskkill(pid, signal);
    if (!terminated) {
      try {
        child.kill(signal);
      } catch {
        // The process is already gone.
      }
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

function createStderrTail(stderr: NodeJS.ReadableStream, maxChars: number): () => string {
  let tail = "";
  stderr.on("data", (chunk: Buffer | string) => {
    tail += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (tail.length > maxChars) tail = tail.slice(-maxChars);
  });
  return () => tail;
}
