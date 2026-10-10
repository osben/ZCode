// ============================================================
// Read surface for the workspace transcript (implementations of the two workspace methods on DynamicWorkflowRunPort).
// ============================================================
//
// A run's `files.*` / `git.*` / `world.run` calls are `dwf_node` rows with `kind ∈ {world-read,
// world-run}` in the journal: `input_json` (migration 0030) contains the operation and arguments; `result_json` is the body.
// The UI replays them as tool cards: first the manifest (without bodies), then fetches each body when expanded.
//
// Split from dynamic-workflow-run-service.ts (already over its max-lines limit), for the same reason as artifact-read.ts.
//
// **Authorization chain** (same invariant as readArtifact; both queries follow it):
//
//   Caller-provided runId
//        ├─① Does a dwf_run row exist?                              No ⇒ undefined
//        ├─② Does its parent_session_id match this service's parent session? No ⇒ undefined
//        └─③ Only then access node rows
//
// Authorize the manifest as well as the body: the body of `files.read` contains workspace file content, while manifest args already contain paths
// and command lines. Neither should be exposed for a run the caller does not own. Normalize all three rejections to undefined (the gateway maps this to an empty manifest /
// not found), so an unauthorized caller cannot learn which check it guessed correctly.

import type { DwfRunIntrospectionQueries, DwfWorldNodeRow } from "@zcode/adapters/storage";
import type {
  DynamicWorkflowRunError,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunWorkspaceNodeSummary,
} from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";

/** Display length for failure messages (= protocol-side `WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength`). */
const ERROR_MESSAGE_MAX_CHARS = 2000;

/**
 * Journal with the workspace-read surface. The sole source of the signature is adapters' {@link DwfRunIntrospectionQueries}
 * (`import type`, zero runtime dependency). As with the artifact read surface, `listWorldNodes` is not on the engine's
 * {@link JournalStorePort} (the engine never enumerates nodes by kind), so this is connected through capability detection.
 */
interface WorkspaceReadableJournal
  extends JournalStorePort, Pick<DwfRunIntrospectionQueries, "listWorldNodes"> {}

/** Whether the journal provides workspace reads. Deliberately a sibling of `supportsArtifactReads`, not an expansion of it (same rationale). */
function supportsWorkspaceReads(journal: JournalStorePort): journal is WorkspaceReadableJournal {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listWorldNodes === "function";
}

interface WorkflowWorkspaceReadDeps {
  journal: JournalStorePort;
  /** This service's parent session (= this app's session), used for authorization step ②. */
  parentSessionId: string;
}

/** Authorization steps ①②. `getRun` is on the engine port, so no introspection capability detection is needed. */
function authorizeRun(deps: WorkflowWorkspaceReadDeps, runId: string): boolean {
  const run = deps.journal.getRun(runId);
  if (run === undefined) return false;
  // **Do not allow** legacy rows with NULL parent_session_id: "cannot determine" does not mean "authorized."
  return run.parentSessionId !== undefined && run.parentSessionId === deps.parentSessionId;
}

/** Workspace transcript manifest: world rows in insertion order, without their bodies. */
export async function listWorkspaceNodesFrom(
  deps: WorkflowWorkspaceReadDeps,
  runId: string,
): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
  if (!supportsWorkspaceReads(deps.journal)) return undefined;
  if (!authorizeRun(deps, runId)) return undefined;
  return deps.journal.listWorldNodes(runId).map(toWorkspaceNode);
}

function toWorkspaceNode(row: DwfWorldNodeRow): DynamicWorkflowRunWorkspaceNode {
  const summary = summaryOf(row);
  return {
    siteId: row.siteId,
    ordinal: row.ordinal,
    kind: row.kind === "world-run" ? "world-run" : "world-read",
    ...(row.input === undefined
      ? {}
      : {
          op: row.input.op,
          args: row.input.args,
          ...(row.input.truncated === true ? { inputTruncated: true as const } : {}),
        }),
    status: row.status,
    ...(row.error === undefined ? {} : { error: toRunError(row.error) }),
    ...(summary === undefined ? {} : { summary }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/** Convert the summary computed in storage into the port shape; only successfully settled rows (with a body) have one. */
function summaryOf(row: DwfWorldNodeRow): DynamicWorkflowRunWorkspaceNodeSummary | undefined {
  if (row.status !== "completed" || row.resultBytes === undefined) return undefined;
  return {
    resultBytes: row.resultBytes,
    ...(row.resultCount === undefined ? {} : { resultCount: row.resultCount }),
    ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
    ...(row.stdoutBytes === undefined ? {} : { stdoutBytes: row.stdoutBytes }),
    ...(row.stderrBytes === undefined ? {} : { stderrBytes: row.stderrBytes }),
  };
}

/** Convert journal `WorkflowErrorJson` into the port's code + message (other fields stay internal; truncate the message at the end). */
function toRunError(error: { code: string; message: string }): DynamicWorkflowRunError {
  const message =
    error.message.length > ERROR_MESSAGE_MAX_CHARS
      ? `${error.message.slice(0, ERROR_MESSAGE_MAX_CHARS - 1)}…`
      : error.message;
  return { code: error.code, message };
}

/** One node body, shape-preserving and bounded by `query.maxBytes`. */
export async function readWorkspaceNodeResultFrom(
  deps: WorkflowWorkspaceReadDeps,
  runId: string,
  siteId: string,
  ordinal: number,
  query: DynamicWorkflowRunWorkspaceNodeResultQuery,
): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
  if (!authorizeRun(deps, runId)) return undefined;
  const node = deps.journal.getNode(runId, siteId, ordinal);
  if (node === undefined) return undefined;
  if (node.kind !== "world-read" && node.kind !== "world-run") return undefined;
  return toNodeResult(node, query.maxBytes);
}

function toNodeResult(node: NodeRecord, maxBytes: number): DynamicWorkflowRunWorkspaceNodeResult {
  if (node.status === "failed") {
    return {
      status: "failed",
      ...(node.error === undefined ? {} : { error: toRunError(node.error) }),
      truncated: false,
      totalBytes: 0,
    };
  }
  if (node.status !== "completed" || !("result" in node)) {
    return { status: node.status, truncated: false, totalBytes: 0 };
  }
  const bounded = boundWorkspaceResult(node.result, maxBytes);
  return {
    status: "completed",
    result: bounded.result,
    truncated: bounded.truncated,
    totalBytes: bounded.totalBytes,
  };
}

// ── Shape-preserving bounds ─────────────────────────────────────────────────
// The engine-side `WORLD_READ_CAPS` policy is "reject on overflow; never truncate and add a flag"—that is the script's data surface,
// where half a grep result could lead it to a wrong decision. This is the audit surface: a card needs to show what ran and the first few hundred lines.
// Truncating and **indicating** truncation (`truncated` + `totalBytes`) is more useful than saying the result is too large to read.

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncate a string to ≤ maxBytes UTF-8 bytes without splitting a surrogate pair. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes));
  // Remove an incomplete trailing multibyte sequence: decode would replace it with U+FFFD, so we prefer to omit one character.
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  if (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1100_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Bound content according to its shape:
 * - Strings (read / diff / status): truncate the end.
 * - Arrays (glob / grep / changedFiles / log): add items in order and drop those that do not fit.
 * - `world.run`'s `{exitCode, stdout, stderr}`: always preserve exitCode and split the remaining budget evenly between both output streams.
 * - Other values: return unchanged if serialization fits; otherwise fall back to truncated JSON text (the shape can no longer be preserved).
 */
function boundWorkspaceResult(
  result: unknown,
  maxBytes: number,
): { result: unknown; truncated: boolean; totalBytes: number } {
  const serialized = JSON.stringify(result) ?? "null";
  const totalBytes = utf8ByteLength(serialized);
  if (totalBytes <= maxBytes) return { result, truncated: false, totalBytes };

  if (typeof result === "string") {
    return { result: truncateUtf8(result, maxBytes), truncated: true, totalBytes };
  }
  if (Array.isArray(result)) {
    const kept: unknown[] = [];
    let used = 2; // Square brackets.
    for (const item of result) {
      const itemBytes = utf8ByteLength(JSON.stringify(item) ?? "null") + 1;
      if (used + itemBytes > maxBytes) break;
      kept.push(item);
      used += itemBytes;
    }
    return { result: kept, truncated: true, totalBytes };
  }
  if (isRunResult(result)) {
    const overhead = utf8ByteLength(JSON.stringify({ ...result, stdout: "", stderr: "" }));
    const budget = Math.max(0, maxBytes - overhead);
    const stderrWant = utf8ByteLength(result.stderr);
    const stdoutWant = utf8ByteLength(result.stdout);
    // Split the budget evenly; let the other stream use any remainder.
    const stderrBudget = Math.min(stderrWant, Math.max(budget >> 1, budget - stdoutWant));
    const stdoutBudget = Math.max(0, budget - stderrBudget);
    return {
      result: {
        ...result,
        stdout: truncateUtf8(result.stdout, stdoutBudget),
        stderr: truncateUtf8(result.stderr, stderrBudget),
      },
      truncated: true,
      totalBytes,
    };
  }
  return { result: truncateUtf8(serialized, maxBytes), truncated: true, totalBytes };
}

function isRunResult(
  value: unknown,
): value is { exitCode: number; stdout: string; stderr: string } & Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.exitCode === "number" &&
    typeof fields.stdout === "string" &&
    typeof fields.stderr === "string"
  );
}
