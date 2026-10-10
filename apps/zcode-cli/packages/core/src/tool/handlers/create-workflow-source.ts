// ============================================================
// CreateWorkflow - input validation and normalization
// ============================================================
//
// This module is where **two sources converge into one script**, and the only disk read in the
// entire flow. Keep this convergence point singular: if it moves back into the handler, it will
// become entangled with handler branches, and the next person will naturally add a separate
// "special handling for saved runs" path. Its first casualty will be the confirmation dialog,
// which may start showing different bytes from what will execute.

import {
  CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR,
  CREATE_WORKFLOW_SOURCE_ERROR,
  CreateWorkflowInputSchema,
  type CreateWorkflowInput,
  type ModelCatalogPort,
  type SavedWorkflowArgsDeclaration,
  type SavedWorkflowScope,
} from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionResult } from "../types.js";
import { resolveModelReference } from "./model-reference.js";
import {
  listSavedWorkflows,
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "./saved-workflows/index.js";
import { writeWorkflowDraft } from "./workflow-drafts.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/** Business-failure error codes, matching the existing handler failure convention. */
const CREATE_WORKFLOW_FAILURE_CODE = 400;

function failure(message: string): ToolHandlerFailure {
  return { result: false, errorCode: CREATE_WORKFLOW_FAILURE_CODE, message };
}

/**
 * Exactly one source (plus the rule that `args` is only allowed with `path`), for **model-provided** input only.
 *
 * Do not encode this in zod: after normalization, `script` and `saved`/`path` together are a valid
 * execution state. The schema would reject it during handler parsing and post-hook revalidation,
 * and only on non-inline paths.
 */
export function validateCreateWorkflowSource(
  input: unknown,
): { result: true } | ToolHandlerFailure {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  // The executor already handles schema failures earlier; this only checks XOR.
  if (!parsed.success) return { result: true };
  const sources = [parsed.data.script, parsed.data.saved, parsed.data.path].filter(
    (source) => source !== undefined,
  );
  if (sources.length !== 1) return failure(CREATE_WORKFLOW_SOURCE_ERROR);
  // `args` must appear with `path`: saved arguments use `saved.args`, while inline scripts have no
  // declaration to validate. Silently ignoring them would make the caller think they took effect,
  // while the script sees empty `args`.
  if (parsed.data.args !== undefined && parsed.data.path === undefined) {
    return failure(CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR);
  }
  return { result: true };
}

/**
 * Clamp the concurrency limit to `[1, ceiling]`.
 * Values above the ceiling are **lowered, not rejected**: when the model says "at most 32," the
 * user wants an upper bound, not an error.
 *
 * If the ceiling is unknown (port absent or host port lacks `concurrencyCeiling`), pass the value
 * through unchanged. The port implementation will clamp again; skipping a clamp here only makes
 * the confirmation dialog show a somewhat larger number, while rejecting would break the entire path.
 *
 * CreateWorkflow and AmendWorkflow share this function: clamping the same number differently in
 * two tools would be an inconsistency discovered only when a user changes concurrency.
 */
export function clampWorkflowMaxConcurrency(value: number, ceiling: number | undefined): number {
  // The value already passed schema validation (positive integer), but keep the lower bound here:
  // this helper is shared by two tools, and schema changes must not allow zero or negative values through.
  const atLeastOne = Math.max(1, value);
  return ceiling === undefined ? atLeastOne : Math.min(atLeastOne, Math.max(1, ceiling));
}

/**
 * Normalized subagent-model result: either the resolved canonical form or a business failure.
 *
 * Use `result` as the discriminant rather than inventing `ok`: call sites must be able to return a
 * failure unchanged, and `ToolHandlerFailure` is discriminated by `result: false`.
 */
type SubagentModelResolution = { result: true; canonical?: string } | ToolHandlerFailure;

/**
 * Resolve `subagent_model` to its canonical form (the CreateWorkflow half; AmendWorkflow's
 * three-state handling is in amend-workflow.ts, and both share `resolveModelReference`).
 *
 * If the field is present but the port is absent, **reject explicitly** instead of silently passing
 * it through. A string the host cannot resolve would otherwise fail when the subagent first speaks,
 * long after the user confirms and appearing to be a model problem.
 */
function resolveCreateSubagentModel(
  requested: string | undefined,
  catalog: ModelCatalogPort | undefined,
): SubagentModelResolution {
  if (requested === undefined) return { result: true };
  if (catalog === undefined) return failure(SUBAGENT_MODEL_UNAVAILABLE);
  const resolution = resolveModelReference(requested, catalog.listModels());
  // Failure to resolve fails the whole call: nothing starts and no confirmation dialog opens (same path as "saved definition not found").
  if (!resolution.ok) return failure(resolution.message);
  return { result: true, canonical: resolution.canonical };
}

/** Rejection message when the host has no model catalog (shared with AmendWorkflow, so kept as a constant). */
export const SUBAGENT_MODEL_UNAVAILABLE =
  "This host cannot choose a subagent model; omit subagent_model.";

/**
 * Normalize input into execution facts. Inline source is the **identity function** (no disk I/O);
 * saved source resolves the file, validates args, fills defaults, and writes a working copy,
 * producing `{name, script, saved: {name, args, path, scope, draft}}`; path source reads that file
 * (strips a metadata block and validates args if present), producing
 * `{name, script, path, args?, script_line_offset?}`。
 *
 * After normalization, `script` is always present, so downstream (hooks, permission rules,
 * prepareApproval, handler) uses the same code for all three sources. `saved`/`path` are now only
 * **provenance**: run-label fallback, argument persistence, and script-file recording read them;
 * execution does not read them at all.
 *
 * `ceiling` is this host's concurrency limit (`port.concurrencyCeiling?.()`, absent means no
 * clamping); `catalog` is this host's model catalog (`context.modelCatalogPort`, absent means no
 * model selection). `max_concurrency` and `subagent_model` are top-level fields handled the same
 * way for all three sources.
 */
export async function resolveCreateWorkflowInput(
  input: unknown,
  cwd: string,
  ceiling?: number,
  catalog?: ModelCatalogPort,
): Promise<ToolInputResolutionResult> {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const model: CreateWorkflowInput = parsed.data;
  const requested = model.max_concurrency;

  // Resolve the model before reading from disk: all three sources use the same code, and a call that cannot resolve should not scan the disk first.
  const subagentModel = resolveCreateSubagentModel(model.subagent_model, catalog);
  if (!subagentModel.result) return subagentModel;
  const subagentModelField =
    subagentModel.canonical === undefined ? {} : { subagent_model: subagentModel.canonical };
  const clampedField =
    requested === undefined
      ? {}
      : { max_concurrency: clampWorkflowMaxConcurrency(requested, ceiling) };

  if (model.path !== undefined) {
    return resolvePathSource(model, model.path, cwd, {
      ...clampedField,
      ...subagentModelField,
    });
  }

  // Inline: identity. The inline path must not touch disk at all; this is the testable form of "zero regression."
  if (model.saved === undefined) {
    // Both exceptions rewrite values without reading from disk; otherwise the confirmation dialog
    // would not show what takes effect: an over-ceiling concurrency limit and a model name not yet
    // normalized. If neither changes, preserve the input byte-for-byte.
    const clamped =
      requested === undefined ? undefined : clampWorkflowMaxConcurrency(requested, ceiling);
    // Compare the model name against the **raw** input, not `model.subagent_model`: the schema
    // applies `.trim()`, so a string with surrounding whitespace resolves to the canonical value,
    // but passing through the original would make the confirmation dialog show those spaces.
    const rawSubagentModel = (input as { subagent_model?: unknown } | null)?.subagent_model;
    if (clamped === requested && subagentModel.canonical === rawSubagentModel) {
      return { result: true, input };
    }
    return {
      result: true,
      input: {
        ...model,
        ...(clamped === undefined ? {} : { max_concurrency: clamped }),
        ...subagentModelField,
      } satisfies CreateWorkflowInput,
    };
  }

  const found = resolveSavedWorkflow({ cwd, name: model.saved.name, scope: model.saved.scope });
  if (!found.ok) return describeResolveFailure(model.saved.name, found, cwd, model.saved.scope);

  const validated = validateWorkflowArgs(found.meta.args, model.saved.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for saved workflow '${model.saved.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(`'${found.name}'`, found.meta.args),
      ].join("\n"),
    );
  }

  // Write the working copy immediately after this single read, using **the exact bytes just read**
  // (including the metadata block), so there cannot be a second read that diverges. A run never
  // changes the definition itself; the model edits this copy.
  const draft = await writeWorkflowDraft({
    cwd,
    name: model.name ?? found.name,
    source: found.source,
  });

  return {
    result: true,
    input: {
      // When no display name is specified, use the saved name so runs listed across sessions remain
      // recognizable as a workflow instead of appearing as a bare runId. This preserves the
      // existing `readWorkflowName` behavior (read input.name).
      name: model.name ?? found.name,
      // Preserve the script body exactly. The old desktop's `readWorkflowScript(raw.script)` then
      // **matches by construction**, not through compatibility handling.
      script: found.script,
      saved: {
        name: found.name,
        args: validated.args,
        path: found.path,
        scope: found.scope,
        // If the draft cannot be written, omit the entire field (best-effort), and the model surface falls back to its old message.
        ...(draft === undefined ? {} : { draft: draft.path }),
      },
      // The copy preserves the metadata block byte-for-byte, so diagnostic file lines must skip those block lines.
      ...(found.bodyLineOffset === 0 ? {} : { script_line_offset: found.bodyLineOffset }),
      ...(requested === undefined
        ? {}
        : { max_concurrency: clampWorkflowMaxConcurrency(requested, ceiling) }),
      // The saved branch builds a new input object from scratch, so name every top-level field here
      // or it will be silently dropped. "Dropped only on the saved path" is one of the hardest failures to detect.
      ...subagentModelField,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * Normalize the `path` source.
 *
 * Do not write a draft: the file is already the working copy, and another copy would leave the model unsure which one to edit next.
 *
 * Parse a file with a metadata block as a saved definition and validate `args` against its
 * declaration (including defaults). Without a block, the whole file is the script; supplying
 * `args` is then an error because there is no declaration to validate them. Silently dropping them
 * would make the caller think the arguments took effect.
 */
async function resolvePathSource(
  model: CreateWorkflowInput,
  inputPath: string,
  cwd: string,
  extraFields: { max_concurrency?: number; subagent_model?: string },
): Promise<ToolInputResolutionResult> {
  const read = await readWorkflowScriptFile({ cwd, inputPath });
  if (!read.ok) return failure(read.message);
  const file = read.file;

  if (file.meta === undefined && model.args !== undefined) {
    return failure(
      `The workflow script file ${file.described} declares no arguments (it has no \`/* zcode-workflow\` metadata block), so it takes none. Drop \`args\`, or add a block declaring them.`,
    );
  }

  const validated = validateWorkflowArgs(file.meta?.args, model.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for the workflow script file ${file.described} are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(file.described, file.meta?.args),
      ].join("\n"),
    );
  }

  return {
    result: true,
    input: {
      // Same rule as the saved branch: this builds a new input object from scratch, so name every top-level field.
      ...(model.name === undefined ? {} : { name: model.name }),
      script: file.script,
      path: file.path,
      // When the declaration is empty, arguments are always `{}`; do not create an empty-shell key,
      // keeping the shape consistent with an inline run that has no arguments.
      ...(Object.keys(validated.args).length === 0 ? {} : { args: validated.args }),
      ...(file.bodyLineOffset === 0 ? {} : { script_line_offset: file.bodyLineOffset }),
      ...extraFields,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * Explain a resolution failure. If not found, **list the actually available names** (with scope
 * labels): after guessing a name incorrectly, the most useful next step for the model is the
 * correct list; otherwise it will guess again.
 *
 * Use one of two not-found messages: with `scope`, say it is missing in that scope; without it,
 * say it is missing everywhere. Both messages list names from both scopes so the model can see
 * whether the requested name exists in the other scope.
 */
function describeResolveFailure(
  name: string,
  found: Exclude<ReturnType<typeof resolveSavedWorkflow>, { ok: true }>,
  cwd: string,
  scope: SavedWorkflowScope | undefined,
): ToolHandlerFailure {
  if (found.reason === "invalid_name") {
    return failure(`'${name}' is not a usable workflow name: ${found.detail}`);
  }
  if (found.reason === "parse_error") {
    return failure(
      [
        `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
        "",
        "Its metadata block is malformed — most likely hand-edited. Fix the file, or save the workflow again.",
      ].join("\n"),
    );
  }
  if (found.reason === "read_error") {
    return failure(
      `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
    );
  }

  const headline =
    scope === undefined
      ? `No saved workflow named '${name}' in this project or globally.`
      : `No ${scope} workflow named '${name}'.`;
  return failure(`${headline}\n\n${describeAvailableWorkflows(cwd)}`);
}

/**
 * Names actually available in both catalogs, each with a scope label. Scan each scope directly
 * (without shadowing) so global definitions hidden by project-scope names still appear in the
 * list; the model can then request them with `scope: "global"`.
 */
function describeAvailableWorkflows(cwd: string): string {
  const project = listSavedWorkflows({ cwd, scope: "project" }).entries;
  const global = listSavedWorkflows({ cwd, scope: "global" }).entries;
  const tagged = [
    ...project.map((entry) => `${entry.name} (project)`),
    ...global.map((entry) => `${entry.name} (global)`),
  ];
  if (tagged.length === 0) {
    return "There are no saved workflows yet, in this project or globally. Use SaveWorkflow to create one, or pass an inline `script` instead.";
  }
  return `Available saved workflows: ${tagged.join(", ")}. Use ListSavedWorkflows for their descriptions.`;
}

/** Compact restatement of the argument declaration, appended to validation failures so the model can fix it in one try. */
function describeArgsDeclaration(
  label: string,
  args: SavedWorkflowArgsDeclaration | undefined,
): string {
  const declared = Object.entries(args ?? {});
  if (declared.length === 0) return `${label} declares no arguments.`;
  return [
    `${label} declares:`,
    ...declared.map(([key, spec]) => {
      const notes = [
        spec.type,
        spec.required === true ? "required" : "optional",
        spec.default === undefined ? undefined : `default ${JSON.stringify(spec.default)}`,
      ].filter((note) => note !== undefined);
      return `- ${key} (${notes.join(", ")})${spec.description === undefined ? "" : `: ${spec.description}`}`;
    }),
  ].join("\n");
}
