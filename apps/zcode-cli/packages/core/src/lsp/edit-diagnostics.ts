// ============================================================
// Post-edit diagnostics: pending edits and the attachment report (spec §6)
// ============================================================
// Owner: EditDiagnosticsTracker holds files mutated since the last model request.
// An entry is recorded synchronously when the mutation is published, so a model request
// that starts right after a tool result cannot miss it.

import type { LspDiagnostic } from "@zcode/contracts";
import {
  diagnosticsNotInBaseline,
  formatDiagnosticLocation,
  isReportableSeverity,
  overlapsChangedRange,
  severityRank,
} from "./diagnostics.js";
import { toModelPath } from "./operation-output.js";

export interface ChangedRange {
  startLine: number;
  endLine: number;
}

export interface PendingEdit {
  path: string;
  uri: string;
  serverId: string;
  changedRange?: ChangedRange;
  /** True while the didOpen/didChange for this mutation is still being sent. */
  syncing: boolean;
  /** True when the server was not ready; the edit is synced when the server becomes ready. */
  needsSync: boolean;
  /** Decided once by the first sync: undefined baseline means "no fresh result before the edit". */
  baselineDecided: boolean;
  baseline?: LspDiagnostic[];
  carriedRounds: number;
  mutatedAt: number;
}

export class EditDiagnosticsTracker {
  private readonly pending = new Map<string, PendingEdit>();
  private lastMutationAt: number | undefined;

  get size(): number {
    return this.pending.size;
  }

  get lastMutation(): number | undefined {
    return this.lastMutationAt;
  }

  entries(): PendingEdit[] {
    return [...this.pending.values()];
  }

  get(path: string): PendingEdit | undefined {
    return this.pending.get(path);
  }

  /** Records a mutation that is about to be synced. Repeated edits of one file merge their ranges. */
  recordSyncing(input: {
    path: string;
    uri: string;
    serverId: string;
    changedRange?: ChangedRange;
    at: number;
  }): void {
    const existing = this.pending.get(input.path);
    if (existing) {
      existing.changedRange = mergeRanges(existing.changedRange, input.changedRange);
      existing.syncing = true;
      existing.carriedRounds = 0;
      existing.mutatedAt = input.at;
    } else {
      this.pending.set(input.path, {
        path: input.path,
        uri: input.uri,
        serverId: input.serverId,
        changedRange: input.changedRange,
        syncing: true,
        needsSync: false,
        baselineDecided: false,
        carriedRounds: 0,
        mutatedAt: input.at,
      });
    }
    this.lastMutationAt = input.at;
  }

  /** The server was not ready; the sync happens on its ready event. */
  markNeedsSync(path: string): void {
    const entry = this.pending.get(path);
    if (!entry) return;
    entry.syncing = false;
    entry.needsSync = true;
  }

  /** The sync finished. The first decided baseline is kept for the whole pending period. */
  settle(path: string, baseline: LspDiagnostic[] | undefined): void {
    const entry = this.pending.get(path);
    if (!entry) return;
    entry.syncing = false;
    entry.needsSync = false;
    if (!entry.baselineDecided) {
      entry.baselineDecided = true;
      entry.baseline = baseline;
    }
  }

  remove(path: string): void {
    this.pending.delete(path);
  }

  clear(): void {
    this.pending.clear();
  }
}

export interface ResolvedEdit {
  entry: PendingEdit;
  current: LspDiagnostic[];
}

export interface EditReport {
  body?: string;
  newIssueCount: number;
  errorCount: number;
  warningCount: number;
  fileCount: number;
  noBaseline: boolean;
  serverIds: string[];
}

/**
 * Builds the attachment body for files whose diagnostics are fresh, plus a pending notice for
 * files that are still not fresh. Only errors and warnings are reported, errors first.
 */
export function buildEditReport(input: {
  resolved: readonly ResolvedEdit[];
  pendingCount: number;
  workspacePath: string;
  maxItems: number;
}): EditReport {
  const issues: { diagnostic: LspDiagnostic; path: string }[] = [];
  let noBaseline = false;
  const serverIds = new Set<string>();

  for (const { entry, current } of input.resolved) {
    serverIds.add(entry.serverId);
    if (entry.baseline === undefined) noBaseline = true;
    const added =
      entry.baseline !== undefined
        ? diagnosticsNotInBaseline(current, entry.baseline)
        : entry.changedRange !== undefined
          ? current.filter((diagnostic) => overlapsChangedRange(diagnostic, entry.changedRange!))
          : [];
    for (const diagnostic of added) {
      if (isReportableSeverity(diagnostic.severity)) {
        issues.push({ diagnostic, path: entry.path });
      }
    }
  }

  issues.sort(
    (left, right) =>
      severityRank(left.diagnostic.severity) - severityRank(right.diagnostic.severity) ||
      left.path.localeCompare(right.path) ||
      left.diagnostic.line - right.diagnostic.line ||
      left.diagnostic.character - right.diagnostic.character,
  );

  const errorCount = issues.filter((item) => item.diagnostic.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const fileCount = new Set(issues.map((item) => item.path)).size;
  const lines: string[] = [];
  if (issues.length > 0) {
    lines.push(`Found ${issues.length} new diagnostic issues in ${fileCount} files`);
    for (const { diagnostic, path } of issues.slice(0, input.maxItems)) {
      lines.push(formatDiagnosticLocation(diagnostic, toModelPath(path, input.workspacePath)));
    }
    if (issues.length > input.maxItems) {
      lines.push(`... and ${issues.length - input.maxItems} more`);
    }
  }
  if (input.pendingCount > 0) {
    lines.push(`Diagnostics pending for ${input.pendingCount} files`);
  }

  return {
    body: lines.length > 0 ? lines.join("\n") : undefined,
    newIssueCount: issues.length,
    errorCount,
    warningCount,
    fileCount,
    noBaseline,
    serverIds: [...serverIds],
  };
}

function mergeRanges(
  left: ChangedRange | undefined,
  right: ChangedRange | undefined,
): ChangedRange | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    startLine: Math.min(left.startLine, right.startLine),
    endLine: Math.max(left.endLine, right.endLine),
  };
}
