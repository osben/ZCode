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
import type { AcpFrameEvent, AcpFrameObserver } from "./types.js";

export const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STDERR_TAIL_CHARS = 64 * 1024;
/** Longest NDJSON line (in bytes) a frame observer receives before truncation. */
export const DEFAULT_MAX_OBSERVED_FRAME_CHARS = 16 * 1024;

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
  /**
   * Optional observer for raw NDJSON frames in both directions. Observer
   * exceptions are swallowed and never propagate into the session.
   */
  readonly onFrame?: AcpFrameObserver;
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
  const outBase = Writable.toWeb(stdin) as unknown as WritableStream<Uint8Array>;
  const inBase = Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>;
  const observer = input.onFrame;
  const stream = ndJsonStream(
    observer ? tapWritableFrames(outBase, observer, "out") : outBase,
    observer ? tapReadableFrames(inBase, observer, "in") : inBase,
    { maxMessageBytes: input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES },
  );

  return { child, stream, spawnFailure, exited, stderrTail };
}

/** Sends a signal to the whole process group on POSIX, or the child alone on Windows. */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
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

/**
 * Splits a byte stream into NDJSON lines and hands each line to the observer.
 * Never backpressures: the wrapped stream keeps flowing at full speed, and
 * oversized lines are truncated (first `maxFrameBytes` bytes kept, remainder
 * counted) instead of buffered without bound.
 */
function tapWritableFrames(
  base: WritableStream<Uint8Array>,
  observer: AcpFrameObserver,
  direction: AcpFrameEvent["direction"],
): WritableStream<Uint8Array> {
  const writer = base.getWriter();
  const splitter = createFrameLineSplitter(observer, direction);
  return new WritableStream<Uint8Array>({
    write(chunk) {
      splitter.push(chunk);
      return writer.write(chunk);
    },
    close() {
      splitter.flush();
      return writer.close();
    },
    abort(reason) {
      splitter.flush();
      return writer.abort(reason);
    },
  });
}

/** Readable-side counterpart of {@link tapWritableFrames}. */
function tapReadableFrames(
  base: ReadableStream<Uint8Array>,
  observer: AcpFrameObserver,
  direction: AcpFrameEvent["direction"],
): ReadableStream<Uint8Array> {
  const reader = base.getReader();
  const splitter = createFrameLineSplitter(observer, direction);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        splitter.flush();
        controller.close();
        return;
      }
      splitter.push(value);
      controller.enqueue(value);
    },
    cancel(reason) {
      splitter.flush();
      return reader.cancel(reason);
    },
  });
}

interface FrameLineSplitter {
  push(chunk: Uint8Array): void;
  flush(): void;
}

function createFrameLineSplitter(
  observer: AcpFrameObserver,
  direction: AcpFrameEvent["direction"],
  maxFrameBytes = DEFAULT_MAX_OBSERVED_FRAME_CHARS,
): FrameLineSplitter {
  let parts: Buffer[] = [];
  let length = 0;
  let discardedBytes = 0;

  const emit = (): void => {
    let text = Buffer.concat(parts, length).toString("utf8");
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (discardedBytes > 0) text += `…[truncated ${discardedBytes} bytes]`;
    parts = [];
    length = 0;
    discardedBytes = 0;
    if (text.length === 0) return;
    try {
      observer({ direction, text, at: Date.now() });
    } catch {
      // Observer failures must never affect the session.
    }
  };

  const append = (bytes: Uint8Array): void => {
    if (bytes.length === 0) return;
    if (length >= maxFrameBytes) {
      discardedBytes += bytes.length;
      return;
    }
    const room = maxFrameBytes - length;
    const kept = bytes.length <= room ? bytes : bytes.subarray(0, room);
    discardedBytes += bytes.length - kept.length;
    parts.push(Buffer.from(kept));
    length += kept.length;
  };

  return {
    push(chunk) {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline === -1) {
          append(buffer.subarray(start));
          return;
        }
        append(buffer.subarray(start, newline));
        emit();
        start = newline + 1;
      }
    },
    flush() {
      if (length > 0 || discardedBytes > 0) emit();
    },
  };
}
