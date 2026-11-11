import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Session } from "node:inspector";
import { getHeapStatistics } from "node:v8";
import { CLI_MEMORY_DIAGNOSTICS_DIR_NAME, ZCODE_COMMIT, ZCODE_VERSION } from "@zcode/shared";
import {
  createMemoryDiagnosticRecorder,
  CLI_MEMORY_PROFILE_SAMPLING_INTERVAL_BYTES,
  CLI_MEMORY_RECORDER_TICK_MS,
  type CliMemoryProfilerPort,
  type CliMemoryReading,
  type HeapProfileNode,
} from "./recorder.js";
import { writeMemoryDiagnostic } from "./writer.js";

/** Bundles above this size are not hashed; the record keeps an empty bundleSha256. */
const MAX_BUNDLE_HASH_BYTES = 128 * 1024 * 1024;
/** Maximum frames captured per sampled allocation stack. */
const PROFILE_STACK_DEPTH = 16;

export interface StartCliMemoryDiagnosticsOptions {
  /** Overrides the directory; tests must set it so no real ~/.zcode data is written. */
  directory?: string;
}

/** Inspector-backed heap sampling profiler; the session is created per start and disposed with the recorder. */
function createHeapSamplingProfiler(): CliMemoryProfilerPort {
  const session = new Session();
  const post = <T = unknown>(method: string, params: object = {}): Promise<T> =>
    new Promise((resolvePost, rejectPost) => {
      session.post(method, params, (error, result) => {
        if (error) rejectPost(error);
        else resolvePost(result as T);
      });
    });
  const startSampling = () =>
    post("HeapProfiler.startSampling", {
      samplingInterval: CLI_MEMORY_PROFILE_SAMPLING_INTERVAL_BYTES,
      stackDepth: PROFILE_STACK_DEPTH,
      includeObjectsCollectedByMajorGC: false,
      includeObjectsCollectedByMinorGC: false,
    });
  return {
    async start() {
      session.connect();
      await startSampling();
    },
    async read() {
      const result = await post<{ profile: { head: HeapProfileNode } }>(
        "HeapProfiler.getSamplingProfile",
      );
      return result.profile;
    },
    async reset() {
      await post("HeapProfiler.disable");
      await startSampling();
    },
    dispose() {
      session.disconnect();
    },
  };
}

/** SHA-256 of the running bundle, or "" when the file is missing, too large, or changes while being read. */
async function hashBundle(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_BUNDLE_HASH_BYTES) return "";
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    total += chunk.length;
    if (total > MAX_BUNDLE_HASH_BYTES) return "";
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Starts the CLI profile recorder for this process. Always on for the protocol agent: a 15 s tick takes a heap
 * reading, reads the sampling profile within budget, and writes one record file. `readCounters` should be
 * `collectMemoryDiagnostics({ includeEventStats: false })` so ticks stay cheap.
 */
export function startCliMemoryDiagnostics(
  readCounters: () => Record<string, number>,
  options: StartCliMemoryDiagnosticsOptions = {},
): { stop(): void } {
  let bundlePath = resolve(process.argv[1] ?? "");
  const metadata = {
    instanceId: randomUUID(),
    pid: process.pid,
    version: ZCODE_VERSION,
    commit: ZCODE_COMMIT,
    node: process.versions.node,
    v8: process.versions.v8,
    bundleSha256: "",
  };
  const directory =
    options.directory ?? join(homedir(), ".zcode", "cli", CLI_MEMORY_DIAGNOSTICS_DIR_NAME);
  const recorder = createMemoryDiagnosticRecorder({
    get bundlePath() {
      return bundlePath;
    },
    metadata: () => metadata,
    readCounters,
    profiler: createHeapSamplingProfiler(),
    readMemory: (): CliMemoryReading => ({
      ...process.memoryUsage(),
      heapLimit: getHeapStatistics().heap_size_limit,
    }),
    write: (record) => writeMemoryDiagnostic(directory, record),
  });

  // The hash reads the path as resolved at start; realpath only updates the path used for frame attribution later.
  realpath(bundlePath).then(
    (resolved) => {
      bundlePath = resolved;
    },
    () => {},
  );
  hashBundle(bundlePath).then(
    (hash) => {
      metadata.bundleSha256 = hash;
    },
    () => {},
  );

  void recorder.start();
  const timer = setInterval(() => {
    void recorder.sample();
  }, CLI_MEMORY_RECORDER_TICK_MS);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      recorder.stop();
    },
  };
}
