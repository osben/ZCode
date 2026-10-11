import { readdir, readFile } from "node:fs/promises";
import { readDarwinProcessGroup, readDarwinProcessTable } from "./process-probe-darwin.js";
import {
  sampleLinuxProcessGroup,
  sampleLinuxProcessTrees,
  type LinuxProcReaders,
} from "./process-probe-linux.js";
import {
  defaultProbeExecFile,
  groupProcessTrees,
  isSamplablePid,
  toSample,
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";
import { readWindowsProcessMemory } from "./process-probe-windows.js";

export {
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
  type ProcessProbeCommandResult,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/** Actual process-tree sample coverage: Windows tasklist has no ppid, so only direct processes are available. */
export type ProcessTreeScope = "direct_process" | "process_tree";

/**
 * Generic process probe: given a list of pids or a process-group id, return each process's RSS and cumulative CPU time.
 * MCP five-minute sampling and Bash slow-command sampling share this module.
 *
 * Performance constraints for this module:
 * - The only allowed external processes are macOS `ps` and Windows `tasklist`, with at most one call per sample.
 * - Linux always reads `/proc` and starts no processes.
 * - Each sample has a one-second timeout. A timeout or failure means “no sample this time”; do not retry or queue it.
 * - After 3 consecutive failures, disable this instance until the caller explicitly calls `reset()` in the next reporting window.
 *
 * The failure budget belongs to a probe instance: each sampling scenario (MCP, Bash command) in a CLI process
 * owns a long-lived instance. Scenarios do not affect each other; the caller invokes `reset()` when the window changes.
 */
export interface ProcessProbe {
  /**
   * Sample the full tree for each root pid (including the root), returning root pid → samples for processes in that tree.
   * Roots that no longer exist at sample time are omitted; `undefined` means no sample this time.
   */
  sampleProcessTrees(
    rootPids: readonly number[],
  ): Promise<ReadonlyMap<number, readonly ProcessProbeSample[]> | undefined>;
  /** Sample by process-group id; Windows has no process-group semantics, so this always returns no sample and starts no process. */
  sampleProcessGroup(processGroupId: number): Promise<readonly ProcessProbeSample[] | undefined>;
  /** Clear the consecutive failure count when the reporting window changes, re-enabling a probe disabled in the previous window. */
  reset(): void;
  /** This platform's `sampleProcessTrees` coverage, so callers can label the sample scope without detecting the platform themselves. */
  readonly treeScope: ProcessTreeScope;
}

export interface CreateProcessProbeOptions {
  execFile?: ProcessProbeExecFile;
  /** List entries under `/proc`; Linux only. */
  listProcDirectory?: () => Promise<readonly string[]>;
  /** Reason for each sample failure (including timeout); callers add it to their debug logs, and the probe performs no I/O. */
  onSampleFailed?: (reason: string) => void;
  platform?: NodeJS.Platform;
  /** Read `/proc/<pid>/stat` and `/proc/<pid>/status`; Linux only. */
  readProcFile?: (path: string) => Promise<string>;
}

export const PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES = 3;

const PROBE_TIMED_OUT = Symbol("process-probe-timed-out");

export function createProcessProbe(options: CreateProcessProbeOptions = {}): ProcessProbe {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? defaultProbeExecFile;
  const listProcDirectory = options.listProcDirectory ?? (() => readdir("/proc"));
  const readProcFile = options.readProcFile ?? ((path: string) => readFile(path, "utf8"));
  let consecutiveFailures = 0;

  const reportFailure = (reason: string): undefined => {
    consecutiveFailures += 1;
    try {
      options.onSampleFailed?.(reason);
    } catch {
// An observer callback throwing must not affect sampling or application behavior.
    }
    return undefined;
  };

  /** Common finalization for a sample: timeout, exception, and command failure all mean “no sample,” and consume the failure budget. */
  const sampleWithinBudget = async <T>(
    collect: (readers: LinuxProcReaders) => Promise<T>,
  ): Promise<T | undefined> => {
    if (consecutiveFailures >= PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES) return undefined;
    const deadline = Date.now() + PROCESS_PROBE_SAMPLE_TIMEOUT_MS;
    let outcome: T | typeof PROBE_TIMED_OUT;
    try {
      outcome = await raceProbeTimeout(
        collect({
          isExpired: () => Date.now() >= deadline,
          listProcDirectory,
          readProcFile,
        }),
      );
    } catch (error) {
      return reportFailure(error instanceof Error ? error.message : String(error));
    }
    if (outcome === PROBE_TIMED_OUT) {
      return reportFailure(`采样超过 ${PROCESS_PROBE_SAMPLE_TIMEOUT_MS} 毫秒`);
    }
    consecutiveFailures = 0;
    return outcome;
  };

  return {
    treeScope: platform === "win32" ? "direct_process" : "process_tree",
    async sampleProcessTrees(rootPids) {
      const roots = [...new Set(rootPids.filter(isSamplablePid))];
      if (roots.length === 0) return new Map();
      if (platform === "win32") {
        const samples = await sampleWithinBudget(() => readWindowsProcessMemory(execFile, roots));
        if (!samples) return undefined;
        // tasklist has no ppid, so on Windows “process tree” can only mean the root process itself; see treeScope.
        return new Map(samples.map((sample) => [sample.pid, [sample]]));
      }
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessTrees(readers, roots)
          : groupProcessTrees(await readDarwinProcessTable(execFile), roots),
      );
    },
    async sampleProcessGroup(processGroupId) {
      if (!isSamplablePid(processGroupId)) return undefined;
      // Windows has no process-group semantics or zero-cost process-tree data source, so skip this sample.
      if (platform === "win32") return undefined;
      return await sampleWithinBudget(async (readers) =>
        platform === "linux"
          ? await sampleLinuxProcessGroup(readers, processGroupId)
          : (await readDarwinProcessGroup(execFile, processGroupId)).map(toSample),
      );
    },
    reset() {
      consecutiveFailures = 0;
    },
  };
}

/**
 * One-second hard timeout: execFile's timeout actually kills `ps`/`tasklist`;
 * `/proc` reads cannot be cancelled, so readers.isExpired stops them at batch boundaries and this layer only returns the timeout result.
 */
async function raceProbeTimeout<T>(work: Promise<T>): Promise<T | typeof PROBE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof PROBE_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(PROBE_TIMED_OUT), PROCESS_PROBE_SAMPLE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
