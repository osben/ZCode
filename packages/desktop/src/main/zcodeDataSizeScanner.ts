import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

export type ZCodeDataSizePartialReason = "file_limit" | "io_error" | "time_limit";

export type ZCodeDataSizeScanResult = {
  bytes: number;
  directoriesScanned: number;
  durationMs: number;
  filesScanned: number;
  scanErrorCount: number;
} & (
  | { status: "complete"; partialReason?: never }
  | { status: "partial"; partialReason: ZCodeDataSizePartialReason }
);

export interface ZCodeDataSizeScanRequest {
  rootPath: string;
  maxDurationMs: number;
  maxFiles: number;
}

interface ZCodeDataSizeScanOptions extends ZCodeDataSizeScanRequest {
  signal?: AbortSignal;
  /** Used only to set a time limit in focused tests; not included in Worker messages. */
  now?: () => number;
}

function createAbortError(): DOMException {
  return new DOMException("ZCode data size scan aborted", "AbortError");
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Asynchronously count the logical bytes in regular files under the data root. Callers must run this
 * in a Worker. Do not follow symlinks, to avoid cycles or traversing outside the user-selected data root.
 */
export async function scanZCodeDataDirectory(
  options: ZCodeDataSizeScanOptions,
): Promise<ZCodeDataSizeScanResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const directories = [options.rootPath];
  let bytes = 0;
  let directoriesScanned = 0;
  let filesScanned = 0;
  let scanErrorCount = 0;
  let terminalPartialReason: Exclude<ZCodeDataSizePartialReason, "io_error"> | null = null;

  const elapsed = () => Math.max(0, now() - startedAt);
  const ensureWithinLimits = (): boolean => {
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    if (elapsed() >= Math.max(0, options.maxDurationMs)) {
      terminalPartialReason = "time_limit";
      return false;
    }
    return true;
  };

  if (!ensureWithinLimits()) {
    return {
      bytes,
      directoriesScanned,
      durationMs: elapsed(),
      filesScanned,
      partialReason: "time_limit",
      scanErrorCount,
      status: "partial",
    };
  }

  while (directories.length > 0 && terminalPartialReason == null) {
    if (!ensureWithinLimits()) {
      break;
    }
    const directoryPath = directories.pop();
    if (!directoryPath) {
      continue;
    }

    let directory;
    try {
      directory = await opendir(directoryPath);
      directoriesScanned += 1;
    } catch (error) {
      if (directoriesScanned === 0 && isMissingPathError(error)) {
        return {
          bytes: 0,
          directoriesScanned: 0,
          durationMs: elapsed(),
          filesScanned: 0,
          scanErrorCount: 0,
          status: "complete",
        };
      }
      scanErrorCount += 1;
      continue;
    }

    try {
      for await (const entry of directory) {
        if (!ensureWithinLimits()) {
          break;
        }
        if (filesScanned >= Math.max(0, options.maxFiles)) {
          terminalPartialReason = "file_limit";
          break;
        }

        const entryPath = join(directoryPath, entry.name);
        try {
          const metadata = await lstat(entryPath);
          if (metadata.isSymbolicLink()) {
            continue;
          }
          if (metadata.isDirectory()) {
            directories.push(entryPath);
            continue;
          }
          if (metadata.isFile()) {
            bytes += metadata.size;
            filesScanned += 1;
          }
        } catch {
          // Files may be deleted by the Agent or log rotation during a scan. A local error must not
          // fail the entire low-frequency telemetry run, but mark the result partial so a lower bound
          // is not mistaken for a complete value.
          scanErrorCount += 1;
        }
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }

  const durationMs = elapsed();
  const partialReason = terminalPartialReason ?? (scanErrorCount > 0 ? "io_error" : null);
  if (partialReason) {
    return {
      bytes,
      directoriesScanned,
      durationMs,
      filesScanned,
      partialReason,
      scanErrorCount,
      status: "partial",
    };
  }
  return {
    bytes,
    directoriesScanned,
    durationMs,
    filesScanned,
    scanErrorCount,
    status: "complete",
  };
}

export function isZCodeDataSizeScanResult(value: unknown): value is ZCodeDataSizeScanResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ZCodeDataSizeScanResult>;
  const finiteNumbers = [
    candidate.bytes,
    candidate.directoriesScanned,
    candidate.durationMs,
    candidate.filesScanned,
    candidate.scanErrorCount,
  ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
  if (!finiteNumbers) {
    return false;
  }
  if (candidate.status === "complete") {
    return candidate.partialReason === undefined;
  }
  return (
    candidate.status === "partial" &&
    ["file_limit", "io_error", "time_limit"].includes(candidate.partialReason ?? "")
  );
}
