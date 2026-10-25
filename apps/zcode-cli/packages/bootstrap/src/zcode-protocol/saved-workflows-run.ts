// Two methods that start from a single run (docs/dynamic-workflow/transcript-and-notifications.md
// "Saving the run, and running it again"): saving the script this run executed as a definition, and answering
// "which saved workflow does this run correspond to".
//
// Same discipline as saved-workflows.ts (parser, serializer, name rules, and type checker all come only from @zcode/core,
// invariant 3); the separate file exists only to keep the 400-line gate.
//
// Why saving **takes no script**, only a runId: the text to write down is the one this run actually executed,
// and it lives in the journal (`scriptText`). Routing through the caller breaks in two ways: a revised run should save
// **the one that settled it**, and in old conversations where the tool-call input was trimmed to a preview by the snapshot,
// the caller simply does not have the full script.
import {
  SavedWorkflowMetaSchema,
  isValidSavedWorkflowName,
  type SavedWorkflowScope,
} from "@zcode/contracts";
import {
  analyzeScript,
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowPath,
  savedWorkflowRoot,
  type ResolvedSavedWorkflow,
} from "@zcode/core";
import {
  zcodeWorkflowsForRunParamsSchema,
  zcodeWorkflowsSaveParamsSchema,
  type ZCodeSavedWorkflowEntry,
  type ZCodeWorkflowsForRunResult,
  type ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import type { RunRecord } from "@zcode/dynamic-workflow";
import { resolveDynamicWorkflowJournalStore } from "../app/dynamic-workflow-run-service.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Upper bound for diagnostics returned to the GUI: the popup only fits the first few entries; the full diagnostics belong on the model path. */
const SAVE_DIAGNOSTICS_MAX_LINES = 5;
const SAVE_DIAGNOSTICS_MAX_CHARS = 1_000;

/**
 * Upper bound on files scanned for script comparison. A project's definitions are in the single-to-double-digit
 * range; the constant exists only so an anomalous directory (someone dumping thousands of files into `.zcode/workflows/`)
 * cannot turn one query into a full read of everything.
 */
const SCRIPT_MATCH_SCAN_LIMIT = 50;

function scopeOf(params: { scope?: SavedWorkflowScope }): SavedWorkflowScope {
  return params.scope ?? "project";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDiagnostics(
  diagnostics: readonly { line: number; column: number; message: string }[],
): string {
  const text = diagnostics
    .slice(0, SAVE_DIAGNOSTICS_MAX_LINES)
    .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
    .join("\n");
  return text.length > SAVE_DIAGNOSTICS_MAX_CHARS
    ? `${text.slice(0, SAVE_DIAGNOSTICS_MAX_CHARS)}…`
    : text;
}

/** Resolution result → protocol entry (same shape as the `workflows/list` row, without the script text). */
function entryOf(resolved: ResolvedSavedWorkflow): ZCodeSavedWorkflowEntry {
  return {
    name: resolved.name,
    description: resolved.meta.description,
    ...(resolved.meta.whenToUse === undefined ? {} : { whenToUse: resolved.meta.whenToUse }),
    ...(resolved.meta.args === undefined ? {} : { args: resolved.meta.args }),
    scope: resolved.scope,
    path: resolved.path,
  };
}

function runRecordOf(
  context: ZCodeProtocolAgentServerContext,
  runId: string,
): RunRecord | undefined {
  const journal = resolveDynamicWorkflowJournalStore(context.deps.sessionStore);
  return journal?.getRun(runId);
}

/**
 * The completion card's "save directly": fetch the script by runId, persist it under the same rules as SaveWorkflow.
 *
 * The order deliberately mirrors the tool: name validity → script available → overwrite decision → type check → write.
 * Overwrite comes before the type check because "one with the same name already exists" is a question the caller must answer
 * first, and a failed compilation would not write a single byte anyway.
 */
export async function saveSavedWorkflowFromRunOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsSaveResult> {
  const params = parseParams(zcodeWorkflowsSaveParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const scope = scopeOf(params);
  // Validate the name before building the path: this order is itself the defense against path traversal (same argument as store.ts).
  if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
  // shared's and contracts' meta schemas are aligned verbatim, but the serializer trusts contracts' copy; run it through again
  // so "the two sides drift" blows up here instead of writing a file we cannot read back (same rule as updateMeta).
  const meta = SavedWorkflowMetaSchema.parse(params.meta);

  const record = runRecordOf(context, params.runId);
  if (record === undefined) return { ok: false, reason: "run_not_found" };
  const script = record.scriptText;
  // scriptText persistence started with workflow-live-run; older records carry no savable script text.
  if (script === undefined) return { ok: false, reason: "script_missing" };

  const path = savedWorkflowPath(savedWorkflowRoot(cwd, scope), params.name);
  // Overwriting is the user's decision, not a side effect of saving: refuse unless overwrite was asked for, and let the caller present the warning and retry.
  if (params.overwrite !== true && savedWorkflowExists({ cwd, name: params.name, scope })) {
    return { ok: false, reason: "target_exists", path };
  }

  const analysis = analyzeScript(script);
  if (!analysis.ok) {
    return {
      ok: false,
      reason: "compile_failed",
      path,
      detail: boundedDiagnostics(analysis.diagnostics),
    };
  }

  const shadowing = findSavedWorkflowShadowing({ cwd, name: params.name, scope });
  try {
    const written = saveSavedWorkflow({ cwd, name: params.name, meta, script, scope });
    return {
      ok: true,
      name: params.name,
      scope: written.scope,
      path: written.path,
      // Re-decide at the moment of writing; do not copy the input back (same reason as the SaveWorkflow handler).
      overwritten: written.overwritten,
      ...(shadowing === undefined ? {} : { shadowing }),
    };
  } catch (error) {
    // Write failure (read-only mount, permissions) is a business branch, not a protocol error: the GUI needs to render it in the popup.
    return { ok: false, reason: "write_error", path, detail: describeError(error) };
  }
}

/**
 * "Which saved workflow does this run correspond to". Three rules, returned on the first hit in order (spec's same order):
 *
 * 1. **What the conversation says**: the model saved via SaveWorkflow and claimed this run (input `run_id`), and the
 *    caller transcribed the name as a candidate. It must still be resolved here — if the user deleted that file since,
 *    it is no longer a fact.
 * 2. **What the run ran**: some definition's body is byte-identical to the script saved from this run. The GUI's "save
 *    directly" lands on this rule by construction, and it keeps holding even after the conversation is gone.
 * 3. **What the run is named**: some definition's name equals the run name — the hub uses exactly this rule to attribute
 *    run history to a workflow, so a run launched from the hub is "saved" by nature.
 *
 * When the run record cannot be found, only rules 2 and 3 are skipped (candidates still count): one unfindable run
 * must not fail the whole query.
 */
export async function findSavedWorkflowForRunOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsForRunResult> {
  const params = parseParams(zcodeWorkflowsForRunParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const record = runRecordOf(context, params.runId);
  // runArgs is independent of whether anything matches: it serves the "run again" argument-window prefill; if the run exists, provide it.
  const runArgs = record?.args === undefined ? {} : { runArgs: record.args };

  for (const candidate of params.candidates ?? []) {
    if (!isValidSavedWorkflowName(candidate.name)) continue;
    const resolved = resolveSavedWorkflow({
      cwd,
      name: candidate.name,
      ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
    });
    if (resolved.ok) return { entry: entryOf(resolved), match: "candidate", ...runArgs };
  }

  const script = record?.scriptText;
  if (script !== undefined) {
    // Project scope before global scope: same-name shadowing points this way, and with identical content the project copy should be reported.
    for (const scope of ["project", "global"] as const) {
      const listed = listSavedWorkflows({ cwd, scope });
      for (const entry of listed.entries.slice(0, SCRIPT_MATCH_SCAN_LIMIT)) {
        const resolved = resolveSavedWorkflow({ cwd, name: entry.name, scope });
        if (resolved.ok && resolved.script === script) {
          return { entry: entryOf(resolved), match: "script", ...runArgs };
        }
      }
    }
  }

  const name = record?.name;
  if (name !== undefined && isValidSavedWorkflowName(name)) {
    // Not scoped: project scope first-wins, the same rule as every by-name lookup outside the hub.
    const resolved = resolveSavedWorkflow({ cwd, name });
    if (resolved.ok) return { entry: entryOf(resolved), match: "name", ...runArgs };
  }

  return { ...runArgs };
}
