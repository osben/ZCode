/**
 * Process transport: spawn, NDJSON framing, stderr tail.
 *
 * The child runs with `shell: false`; on POSIX it is detached into its own
 * process group so the whole tree can be signalled on teardown.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type AnyMessage, type Stream } from "@agentclientprotocol/sdk";
import { AcpSpawnError, AcpStreamClosedError } from "./errors.js";
import type { AcpFrameDirection, AcpFrameObserver, AcpRawFrame } from "./types.js";

export const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STDERR_TAIL_CHARS = 64 * 1024;
/** Longest NDJSON line (in bytes) a frame observer receives before truncation. */
export const DEFAULT_MAX_OBSERVED_FRAME_CHARS = 16 * 1024;

/** Observed raw frames above this size are truncated (spec: 16 KiB cap). */
export const FRAME_OBSERVER_MAX_BYTES = 16 * 1024;
/** Marker appended to `AcpRawFrame.text` when the line exceeded the cap. */
export const FRAME_OBSERVER_TRUNCATION_MARKER = "…[truncated]";

export interface SpawnedAcpProcess {
  readonly ownedProcessStartedAtMs: number;
  readonly resolveOwnedProcessExitedAtMs: () => number | undefined;
  readonly child: ChildProcess;
  readonly stream: Stream;
  /** Rejects when the child fails to spawn (e.g. ENOENT); consumed by racing handshake steps. */
  readonly spawnFailure: Promise<never>;
  /**
   * Rejects when the NDJSON framing stream fails (e.g. an oversized frame) or
   * the child's stdout closes. Both leave the SDK connection unusable while
   * the child itself may stay alive; consumed by the runtime to run the same
   * teardown transition as a child exit.
   */
  readonly streamFailure: Promise<never>;
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
  /** Raw NDJSON frame observer; see `AcpRawFrame`. */
  readonly onFrame?: AcpFrameObserver;
}

export function spawnAcpProcess(input: SpawnAcpProcessInput): SpawnedAcpProcess {
  const ownedProcessStartedAtMs = Date.now();
  let ownedProcessExitedAtMs: number | undefined;
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
    child.once("exit", (code, signal) => {
      ownedProcessExitedAtMs = Date.now();
      resolve({ code, signal });
    });
    child.once("close", () => resolve({ code: child.exitCode, signal: child.signalCode }));
    // A failed spawn emits `error` (usually without an `exit`); resolve so
    // teardown never waits on a process that never started.
    child.once("error", () => resolve({ code: child.exitCode, signal: child.signalCode }));
  });

  const stderrTail = createStderrTail(stderr, DEFAULT_STDERR_TAIL_CHARS);
  const framed = ndJsonStream(
    tapOutboundStream(
      Writable.toWeb(stdin) as unknown as WritableStream<Uint8Array>,
      createFrameTap(input.onFrame, "outbound"),
    ),
    tapInboundStream(
      Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>,
      createFrameTap(input.onFrame, "inbound"),
    ),
    { maxMessageBytes: input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES },
  );
  const guarded = guardStreamFailure(framed);

  return {
    ownedProcessStartedAtMs,
    resolveOwnedProcessExitedAtMs: () => ownedProcessExitedAtMs,
    child,
    stream: guarded.stream,
    spawnFailure,
    streamFailure: guarded.failure,
    exited,
    stderrTail,
  };
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
  // Decode as UTF-8 at the stream level: decoding chunk-by-chunk can split a
  // multibyte character across chunks and corrupt the tail (U+FFFD).
  stderr.setEncoding("utf8");
  let tail = "";
  stderr.on("data", (chunk: string) => {
    tail += chunk;
    if (tail.length > maxChars) tail = tail.slice(-maxChars);
  });
  return () => tail;
}

/**
 * Builds the per-direction line callback for `onFrame`; `undefined` when no
 * observer is configured so the taps stay pass-through. Observer exceptions
 * are swallowed: a faulty observer must never affect the runtime.
 */
function createFrameTap(
  observer: AcpFrameObserver | undefined,
  direction: AcpFrameDirection,
): ((line: Uint8Array) => void) | undefined {
  if (!observer) return undefined;
  return (line) => {
    if (line.byteLength === 0) return;
    try {
      observer(toObservedFrame(direction, line));
    } catch {
      // Spec: observer isolation.
    }
  };
}

/** Decodes a raw line for the observer, truncating past the 16 KiB cap. */
function toObservedFrame(direction: AcpFrameDirection, line: Uint8Array): AcpRawFrame {
  if (line.byteLength <= FRAME_OBSERVER_MAX_BYTES) {
    return { direction, text: new TextDecoder().decode(line), truncated: false };
  }
  // Cut at a UTF-8 code-point boundary so the marker never follows a broken
  // character (continuation bytes are 0b10xxxxxx).
  let end = FRAME_OBSERVER_MAX_BYTES;
  while (end > 0) {
    const byte = line[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return {
    direction,
    text: new TextDecoder().decode(line.subarray(0, end)) + FRAME_OBSERVER_TRUNCATION_MARKER,
    truncated: true,
  };
}

function concatChunks(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/**
 * Incrementally splits NDJSON wire bytes into LF-separated lines and hands
 * each to `onLine` in arrival order; a trailing unterminated line is emitted
 * by `flush`, mirroring the SDK's framing.
 */
function createLineSplitter(onLine: (line: Uint8Array) => void): {
  push(chunk: Uint8Array): void;
  flush(): void;
} {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  return {
    push(chunk: Uint8Array): void {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline === -1) break;
        if (pending.length === 0) {
          onLine(chunk.subarray(start, newline));
        } else {
          pending.push(chunk.subarray(start, newline));
          onLine(concatChunks(pending, pendingBytes + newline - start));
          pending = [];
          pendingBytes = 0;
        }
        start = newline + 1;
      }
      if (start < chunk.byteLength) {
        const tail = chunk.subarray(start);
        pending.push(tail);
        pendingBytes += tail.byteLength;
      }
    },
    flush(): void {
      if (pending.length > 0) onLine(concatChunks(pending, pendingBytes));
      pending = [];
      pendingBytes = 0;
    },
  };
}

/**
 * Wraps the child's stdout so raw inbound lines are observed in wire order
 * before the SDK parses them. Byte chunks are forwarded untouched; read
 * errors propagate to the SDK connection.
 */
function tapInboundStream(
  input: ReadableStream<Uint8Array>,
  onLine: ((line: Uint8Array) => void) | undefined,
): ReadableStream<Uint8Array> {
  if (!onLine) return input;
  const splitter = createLineSplitter(onLine);
  const reader = input.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          splitter.flush();
          controller.close();
          return;
        }
        splitter.push(value);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Wraps the child's stdin so raw outbound lines are observed in wire order
 * as the SDK writes them. `WritableStream` runs sink writes one at a time in
 * order, so the observer sees the exact wire sequence.
 */
function tapOutboundStream(
  output: WritableStream<Uint8Array>,
  onLine: ((line: Uint8Array) => void) | undefined,
): WritableStream<Uint8Array> {
  if (!onLine) return output;
  const splitter = createLineSplitter(onLine);
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      splitter.push(chunk);
      const writer = output.getWriter();
      try {
        await writer.write(chunk);
      } finally {
        writer.releaseLock();
      }
    },
    abort(reason) {
      return output.abort?.(reason);
    },
    close() {
      splitter.flush();
      return output.close();
    },
  });
}

/**
 * Watches the framed stream's readable so its failures are surfaced to the
 * runtime: an error (e.g. `MessageTooLargeError` from the oversized-frame
 * check) rejects `failure` with the original error, a plain EOF rejects it
 * with `AcpStreamClosedError`. The SDK connection reads the wrapped stream
 * unchanged.
 */
function guardStreamFailure(stream: Stream): {
  stream: Stream;
  failure: Promise<never>;
} {
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  // Consumers may attach late or never; keep an early failure from surfacing
  // as an unhandled rejection (same pattern as `spawnFailure`).
  failure.catch(() => {});
  const reader = stream.readable.getReader();
  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          rejectFailure(new AcpStreamClosedError("ACP agent output stream closed"));
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        rejectFailure(error instanceof Error ? error : new Error(String(error)));
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream: { readable, writable: stream.writable }, failure };
}
