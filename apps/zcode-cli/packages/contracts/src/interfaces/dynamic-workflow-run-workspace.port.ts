// Dynamic Workflow Run Port: read types for workspace operation records.
// Includes manifest rows and result bodies for `files.*`, `git.*`, and `world.run` calls.
// Re-exported from dynamic-workflow-run.port.ts; consumers use `@zcode/contracts`.

// The structured failure shape stays in the main file, where it is referenced by two fields
// in this group. Import its type here: this creates no runtime dependency, and each file
// describes only its own group.
import type { DynamicWorkflowRunError } from "./dynamic-workflow-run.port.js";

/** Workspace node kinds: the two world values of journal `dwf_node.kind`. */
export type DynamicWorkflowRunWorkspaceNodeKind = "world-read" | "world-run";

/** Node row status, matching the journal's `NodeRecordStatus` (repeated here intentionally, as with lifecycle status). */
export type DynamicWorkflowRunWorkspaceNodeStatus = "running" | "completed" | "failed";

/**
 * **Summary** for one manifest row: counts that can be reported without decoding the body.
 * The storage layer computes these in the query with SQLite JSON functions (`resultBytes` /
 * `resultCount` / `exitCode` / `stdoutBytes` / `stderrBytes`), and the port passes them through
 * unchanged. Fields depend on the op: array bodies (glob / grep / changedFiles) have
 * `resultCount`; `world.run` has `exitCode` and byte counts for both output streams; string
 * bodies have only `resultBytes`.
 */
export interface DynamicWorkflowRunWorkspaceNodeSummary {
  /** UTF-8 byte count of the serialized body. */
  resultBytes: number;
  resultCount?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
}

/**
 * One workspace transcript row: a `files.*` / `git.*` / `world.run` call, **without its body**.
 *
 * `op` / `args` come from `input_json`, added by migration 0030 and recorded at admission
 * (≤ 4 KB). Historical rows from before the upgrade omit both, so the UI falls back to the
 * step label in the static graph. `inputTruncated` means args are per-item string previews,
 * rather than the original values.
 */
export interface DynamicWorkflowRunWorkspaceNode {
  siteId: string;
  ordinal: number;
  kind: DynamicWorkflowRunWorkspaceNodeKind;
  op?: string;
  args?: readonly unknown[];
  inputTruncated?: true;
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  /** Structured failure for a failed row (`code` + `message` from journal `error_json`; other fields stay internal). */
  error?: DynamicWorkflowRunError;
  /** Present only for successfully settled rows. */
  summary?: DynamicWorkflowRunWorkspaceNodeSummary;
  /** Journal row creation / most recent update time (epoch milliseconds); their difference is this step's duration. */
  createdAt: number;
  updatedAt: number;
}

/** Query parameters for {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.readWorkspaceNodeResult}: the body byte limit. */
export interface DynamicWorkflowRunWorkspaceNodeResultQuery {
  /** Required; the port uses this to **bound** the body (truncate instead of reject—this is an audit surface, not a script data-retrieval surface). */
  maxBytes: number;
}

/**
 * Body of one workspace node: a shape-bounded `result`.
 *
 * Truncation **preserves the shape**: strings are cut at the end, arrays lose trailing items,
 * and `world.run` stdout / stderr are each cut at the end. `truncated` indicates whether
 * truncation occurred; `totalBytes` is the byte count before truncation. Running rows have no
 * body; failed rows contain only `error`.
 */
export interface DynamicWorkflowRunWorkspaceNodeResult {
  status: DynamicWorkflowRunWorkspaceNodeStatus;
  result?: unknown;
  error?: DynamicWorkflowRunError;
  truncated: boolean;
  totalBytes: number;
}
