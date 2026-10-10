// GUI hub for saved workflows: workspace-level methods that do not require a session.
//
// Follows the skills/referenceCatalog pattern: no sessionId, and scan the directory on each call.
// A mount-time snapshot would miss files edited by the user or just written by the model through SaveWorkflow.
// Use only @zcode/core for parsing and serialization; do not parse frontmatter or assemble YAML here.
//
// Global scope: all five methods accept an optional `scope` in params (default `project`). In
// `global` scope, operate on the local global root (`~/.zcode/workflows/`); `workspace` is only a
// **carrier** and handlers do not read its path for global workflows. `workflows/move` moves a global
// workflow back into the `workspace` project (one-way only).
import { unlink, writeFile } from "node:fs/promises";
import { SavedWorkflowMetaSchema, isValidSavedWorkflowName } from "@zcode/contracts";
import {
  listSavedWorkflows,
  moveSavedWorkflow,
  resolveSavedWorkflow,
  savedWorkflowPath,
  savedWorkflowRoot,
  serializeSavedWorkflow,
  type SavedWorkflowResolveFailure,
} from "@zcode/core";
import {
  ZCODE_WORKFLOWS_RUNS_MAX_LIMIT,
  zcodeWorkflowsDeleteParamsSchema,
  zcodeWorkflowsGetParamsSchema,
  zcodeWorkflowsListParamsSchema,
  zcodeWorkflowsMoveParamsSchema,
  zcodeWorkflowsRunsParamsSchema,
  zcodeWorkflowsUpdateMetaParamsSchema,
  type ZCodeSavedWorkflowRun,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkflowsDeleteResult,
  type ZCodeWorkflowsGetResult,
  type ZCodeWorkflowsListResult,
  type ZCodeWorkflowsMoveResult,
  type ZCodeWorkflowsRunsResult,
  type ZCodeWorkflowsUpdateMetaResult,
} from "@zcode/shared";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { artifactsOf } from "../app/dynamic-workflow-run-observation.js";
import {
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
} from "../app/dynamic-workflow-run-service.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

// Default to `project`: legacy GUI calls and project workflows without a scope continue using the
// project root unchanged (version-skew compatibility).
function scopeOf(params: { scope?: ZCodeSavedWorkflowScope }): ZCodeSavedWorkflowScope {
  return params.scope ?? "project";
}

export async function listSavedWorkflowsOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsListResult> {
  const params = parseParams(zcodeWorkflowsListParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const scope = scopeOf(params);
  // The hub's PROJECT group lists only this project's workflows, and the global group only global
  // workflows. **Always** pass an explicit scope; never use the unscoped variant (first-wins across
  // both roots would mix global workflows into PROJECT and hide shadowed global entries from the global group).
  const listed = listSavedWorkflows({ cwd, scope });
  // Return directories that were scanned (even if they do not exist); the GUI file watcher uses them.
  return {
    workflows: listed.entries,
    invalid: listed.invalid,
    dir: savedWorkflowRoot(cwd, scope).dir,
  };
}

export async function getSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsGetResult> {
  const params = parseParams(zcodeWorkflowsGetParamsSchema, rawParams);
  // Explicit scope: `global` searches only the global root and does not apply shadowing; the hub's
  // global group must include entries shadowed by project workflows.
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  return {
    ok: true,
    name: resolved.name,
    path: resolved.path,
    scope: resolved.scope,
    meta: resolved.meta,
    script: resolved.script,
  };
}

/**
 * Rewrite only the metadata at the top of the file: read the existing script body, then overwrite
 * the whole file with `serialize(newMeta, script)`. Perform read-modify-write in one call; no
 * three-way merge is needed (small local file, edited by the user).
 */
export async function updateSavedWorkflowMetaOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsUpdateMetaResult> {
  const params = parseParams(zcodeWorkflowsUpdateMetaParamsSchema, rawParams);
  // The shared and contracts meta schemas are aligned, but the serializer uses the contracts type.
  // Validate again so schema drift fails here with -32602 instead of writing a file that cannot be read back.
  const meta = SavedWorkflowMetaSchema.parse(params.meta);
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  await writeFile(resolved.path, serializeSavedWorkflow(meta, resolved.script), "utf8");
  return { ok: true, path: resolved.path };
}

/**
 * Delete by name only: run `isValidSavedWorkflowName` before constructing a path; that ordering is
 * the path-traversal defense itself (same rationale as store.ts). The protocol accepts no paths or
 * `..`. Select the root by scope (do not hardcode roots[0]); `global` deletes from the local global
 * root. A same-named legacy `.workflow.js` belongs to another parser and is out of scope.
 */
export async function deleteSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsDeleteResult> {
  const params = parseParams(zcodeWorkflowsDeleteParamsSchema, rawParams);
  if (!isValidSavedWorkflowName(params.name)) {
    return { ok: false, reason: "invalid_name" };
  }
  const root = savedWorkflowRoot(params.workspace.workspacePath, scopeOf(params));
  const path = savedWorkflowPath(root, params.name);
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "read_error", detail: describeError(error) };
  }
  return { ok: true, path };
}

/**
 * Run history, grouped by workflow using `dwf_run.name`. Read only from the journal: the hub exists
 * outside any session and cannot see the registry gap where "submit returned but the row is not yet
 * written." The next refresh fills that microtask-sized gap; it is not worth binding the hub to a session.
 * If the journal is unavailable (injected test store or an implementation without introspection),
 * return an empty page instead of throwing; the hub then shows "not run yet."
 *
 * `project` (default): query only `dwf_run.cwd === workspacePath`. `global`: **do not** filter by cwd;
 * retrieve that workflow's run history across all projects (global workflows can run anywhere, so
 * their history spans cwd values). Return `cwd` on each row so the GUI can label the project.
 */
export async function listSavedWorkflowRunsOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsRunsResult> {
  const params = parseParams(zcodeWorkflowsRunsParamsSchema, rawParams);
  const journal = resolveDynamicWorkflowJournalStore(context.deps.sessionStore);
  if (journal === undefined || !supportsRunIntrospection(journal)) return { runs: [] };
  const limit = Math.min(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT, params.limit);
  const global = scopeOf(params) === "global";
  // Fetch one extra row **only to determine truncation** (same convention as run service and v4 event pagination).
  // The global variant omits the cwd predicate (journal cwd is optional, meaning across all projects);
  // the project variant passes cwd unchanged.
  const rows = journal.listRuns({
    ...(global ? {} : { cwd: params.workspace.workspacePath }),
    limit: limit + 1,
    ...(params.name === undefined ? {} : { name: params.name }),
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  // Artifact summary: one `listArtifactRows` query per row (the journal is its persistence source),
  // only when the capability exists; otherwise the whole field is absent and the hub draws no chips.
  // Fetch only for rows on this page, so cost scales with page size (≤ 50).
  const artifactsByRun = savedWorkflowRunArtifacts(journal, page);
  const runs: ZCodeSavedWorkflowRun[] = page.map((row) => ({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    status: row.status,
    ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
    spentTokens: row.spentTokens,
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    ...(row.args === undefined ? {} : { args: row.args }),
    // Actual project directory for the run: the global variant uses it to label each row; in the
    // project variant it is always workspacePath and has no effect.
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    ...(artifactsByRun.get(row.runId) === undefined
      ? {}
      : { artifacts: artifactsByRun.get(row.runId)! }),
  }));
  return { runs, ...(truncated ? { truncated: true } : {}) };
}

/** Maximum number of kind icons that fit in one hub chip row (same as the protocol schema's `.max(8)`). */
const SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT = 8;

/**
 * One page of run rows → **user-facing artifact** summaries for each row.
 *
 * ⚠ Terminology: artifact here means outputs the script publishes for users through `artifact.*`,
 * not the script's top-level return value (the engine-internal `RunSettlement.artifact`).
 *
 * Fetch through {@link artifactsOf}, using the **same merge rule** as snapshots / `GetWorkflowRun`
 * (completed rows only, versions ascending per id, top-level fields from the latest version). A
 * separate implementation here could make the same run's artifacts differ between the hub and sidebar.
 * `listArtifactRows` is not on the engine port, so `artifactsOf` performs capability detection:
 * absent capability ⇒ no rows for each run ⇒ the entire field is absent (unchanged for older CLIs /
 * injected test stores).
 *
 * Runs with zero artifacts are omitted from the table; callers use that to omit the entire field
 * instead of sending an empty array.
 */
function savedWorkflowRunArtifacts(
  journal: JournalStorePort,
  page: readonly { runId: string }[],
): Map<string, ZCodeSavedWorkflowRun["artifacts"]> {
  const byRun = new Map<string, ZCodeSavedWorkflowRun["artifacts"]>();
  for (const row of page) {
    const { artifacts } = artifactsOf(row.runId, journal);
    if (artifacts === undefined || artifacts.length === 0) continue;
    byRun.set(
      row.runId,
      artifacts.slice(0, SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT).map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        ...(artifact.title === undefined ? {} : { title: artifact.title }),
        version: artifact.version,
        ...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
      })),
    );
  }
  return byRun;
}

/**
 * Move the same-named file from the local global root to the `workspace` project root (one way only:
 * project → global is the model's conceptual "promote to global," not a file move). Copy byte-for-byte
 * (frontmatter stores no scope) and do not overwrite (reject if the destination exists, invariant 7).
 * Validate the name before constructing paths. `workspace` is both carrier and target project; core
 * derives both roots from its cwd and local home directory.
 */
export async function moveSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsMoveResult> {
  const params = parseParams(zcodeWorkflowsMoveParamsSchema, rawParams);
  const result = moveSavedWorkflow({ cwd: params.workspace.workspacePath, name: params.name });
  if (result.ok) {
    return { ok: true, from: result.from, to: result.to };
  }
  // Keep core failure branches aligned with the protocol result; pass path / detail through unchanged
  // when present (omit the keys when absent).
  switch (result.reason) {
    case "invalid_name":
      return { ok: false, reason: "invalid_name", detail: result.detail };
    case "not_found":
      return { ok: false, reason: "not_found" };
    case "target_exists":
      return { ok: false, reason: "target_exists", path: result.path };
    case "read_error":
    case "write_error":
      return { ok: false, reason: result.reason, path: result.path, detail: result.detail };
  }
}

function toFailure(failure: SavedWorkflowResolveFailure) {
  switch (failure.reason) {
    case "invalid_name":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
    case "not_found":
      return { ok: false as const, reason: failure.reason };
    case "parse_error":
    case "read_error":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
