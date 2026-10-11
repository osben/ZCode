// ============================================================
// Workflow actor model surface (run selection / journal pin -> AgentRuntime model config)
// ============================================================
//
// Persona model tiers (`model?: "main" | "lite"`) have been retired. After the provider refactor,
// the host has no lite-model source; "lite" and "main" already follow the same path by inheriting
// the parent's current model.
//
// This module answers one question: **which model should this actor's session run on?** Four
// sources are ordered by priority: the persona-named model (`agent(…, { model })` in the script,
// resolved through the run-launched binding table; docs/dynamic-workflow/authoring.md, "Choosing a
// model per subagent") > this run's `subagentModel` (`subagent_model` from CreateWorkflow /
// AmendWorkflow, docs/dynamic-workflow/launch.md) > resume pin (model actually used last time,
// stored in journal) > parent session's current model.
//
// 2026-09-26 addendum: the persona model is back, but not as the retired tier—the script names a
// concrete model, launch resolves it against the model catalog into a binding table, and here we
// only look it up ({@link resolveActorPersonaModel}).
// This is a sibling to workflow-actor-tools.ts at the same seam: one supplies the tool surface, the
// other the model surface. Both are expanded by the driver-side runtime factory when it creates AgentRuntime.

import type { ModelSelection } from "@zcode/shared/model-selection";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

/** Host-side facts needed to resolve the model surface. */
interface WorkflowActorModelHost {
  /**
   * Parent session's **current** model selection (`runtime.getSessionModelSelection()`). Used only
   * when there is no run-level selection: compare with the pin to determine whether the pinned
   * model is already the current main model and whether the pin branch must override. Absent if the
   * parent session has no selection yet.
   */
  parentSelection?: ModelSelection | undefined;
  /**
   * This run's subagent model (`subagent_model` from CreateWorkflow/AmendWorkflow, read from the
   * journal's `run-launched` event). The **full selection**, including reasoning tier: if the user
   * requests "subagents run GLM-5.3-Flash$high," the tier is part of the selection and must be preserved.
   *
   * Priority: **highest**. It is the user's explicit choice for this run; when present, the pin and
   * parent model are defaults it replaces (see the function comment below). It affects subagents only, not the main agent.
   */
  runSelection?: ModelSelection | undefined;
  /**
   * The model this actor's persona names, resolved through this run's binding table into a full
   * selection (including reasoning tier; {@link resolveActorPersonaModel}). Priority: **highest**—it
   * is the selection written for this one subagent whose binding the user approved in the
   * confirmation window, more specific than "the run-wide default subagent model."
   */
  actorSelection?: ModelSelection | undefined;
}

/** Model-surface slice of AgentRuntimeConfig. */
interface WorkflowActorModelPolicy {
  /**
   * Overrides spread into AgentRuntimeConfig. **An empty object means "no override"**: the child
   * runtime baseline is the parent session's model selection (script-workflow-child-runtime.ts),
   * so with neither run selection nor pin, write nothing and inherit the parent model.
   */
  configOverrides: {
    modelSelection?: ModelSelection;
  };
}

/**
 * Thrown when the pinned model cannot be constructed. Include the pin itself so troubleshooters
 * know which model the journal pinned instead of guessing from a generic "invalid model reference" message.
 */
export class WorkflowActorPinnedModelError extends Error {
  readonly pinnedModel: string;

  constructor(pinnedModel: string, cause?: unknown) {
    super(`Cannot construct the model pinned for this subagent: ${pinnedModel}`);
    this.name = "WorkflowActorPinnedModelError";
    this.pinnedModel = pinnedModel;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * The persona names a model that is absent from this run's binding table. Only a type assertion
 * bypassing compiler rule 9010 can reach here (the compile step guarantees the name set is closed
 * and launch resolves the whole table); include the name and the names the table does have so a
 * troubleshooter knows which script line is off and by what. Fail loudly: silently falling back to
 * the run's subagent model would run a model the user never approved.
 */
export class WorkflowActorModelUnboundError extends Error {
  readonly modelName: string;

  constructor(modelName: string, bound: readonly string[]) {
    super(
      `This subagent's persona names the model "${modelName}", which the run did not resolve at launch` +
        (bound.length === 0
          ? " (the script named no models)."
          : ` (it resolved: ${bound.map((name) => `"${name}"`).join(", ")}).`),
    );
    this.name = "WorkflowActorModelUnboundError";
    this.modelName = modelName;
  }
}

/**
 * Persona model name → full selection (docs/dynamic-workflow/launch.md, "Models the script
 * names"). Pure function.
 *
 * Names are looked up **verbatim**: lowering erases `model("x")` to `"x"`, the persona carries the
 * exact string the script wrote, and that string is also the table's key. When the persona names no
 * model, return undefined (deferring to run selection / pin / parent model).
 */
export function resolveActorPersonaModel(
  personaModel: string | undefined,
  bindings: Readonly<Record<string, string>> | undefined,
): ModelSelection | undefined {
  if (personaModel === undefined) return undefined;
  const canonical = bindings?.[personaModel];
  if (canonical === undefined) {
    throw new WorkflowActorModelUnboundError(personaModel, Object.keys(bindings ?? {}));
  }
  return parseModelPickerValue(canonical);
}

/**
 * Map the persona model, run selection, and journal pin to AgentRuntime model config. Pure function.
 *
 * `pinnedModel` is this actor's `resolvedModel` (`providerId/modelId`) recorded in the journal;
 * only resume includes it (including amend-resume seeds inherited from a predecessor).
 *
 * Priority: **persona-named model > this run's `subagentModel` > resume pin > parent session's current model**.
 *
 * | Run selection | Pin | Resolution |
 * |---|---|---|
 * | Present | Any (including malformed; do not parse) | Override with run selection (full selection, including reasoning tier) |
 * | Absent | Absent | No override (parent session's current model) |
 * | Absent | = parent session's current model | No override (the pin is already the current main model) |
 * | Absent | != parent session's current model | Override with selection parsed from pin |
 * | Absent | Malformed (missing provider segment) | {@link WorkflowActorPinnedModelError} |
 *
 * **Omission means inherit; an explicit value means replace.** `resolveInput` for resume/amend
 * already follows this rule for `subagentModel` and `max_concurrency`; the pin applies it to an
 * **implicit default**. For a run without `subagentModel`, a subagent's default is not "the parent
 * session's model now" but "the model this subagent actually used last time." Once the run has a
 * `subagentModel`, there is no default to inherit, so the pin does not apply. Thus the pin is below
 * the run selection: it prevents silent drift, while `AmendWorkflow` with `subagent_model` is the
 * explicit user-visible decision (the confirmation dialog and tool output both say "Subagents run
 * on …"). Previously the pin outranked the run selection, causing every resumed subagent with live
 * work to keep using the predecessor's model while `run-launched` and the confirmation dialog said
 * otherwise. Model-change history is preserved: the new run's `dwf_actor` row records its new
 * selection, while the predecessor row retains the old model, showing which run changed it.
 *
 * Why have a pin? It is **the persisted half of the frozen-persona invariant**: persona freezes at
 * `agent()`, while resume reconstructs actors from the journal. Without a pin, if the parent session
 * changes its main model between runs, a frozen identity would **silently change mid-transcript**:
 * asks in the first half come from model X, and asks after resume from model Y, with no record of the change.
 *
 * **v1 pin-miss policy (without a run selection): fail rather than silently switch models.** If
 * the host can no longer construct the pinned model (provider removed, model retired), this
 * function does **not fall back** to the parent model—that would be the silent identity change the
 * pin exists to prevent. A malformed pin fails here with {@link WorkflowActorPinnedModelError}. A
 * well-formed model no longer available to the host cannot be detected while creating the session
 * (querying the host Registry is intentionally outside this pure function); it surfaces as a
 * node-level error on the model call of the **first ask**. This is intentional: a later loud failure
 * is better than silently continuing with a different model. To change models on resume, use the
 * sole route: pass `subagent_model` to `AmendWorkflow`, the run-selection branch.
 *
 * This function does **not produce** the fact "which model actually ran": that belongs in the
 * journal, and the authority is the constructed child runtime itself
 * (`runtime.getSessionModelSelection()`). Letting the runtime report it avoids discrepancies where
 * policy thinks it selected A but runtime actually runs B. See `journalActorResolvedModel` in
 * dynamic-workflow-run-launch.ts for persistence.
 */
export function workflowActorModelPolicy(
  host: WorkflowActorModelHost,
  pinnedModel?: string,
): WorkflowActorModelPolicy {
  // The persona names a model: it is this subagent's explicit choice, and the run selection and
  // pin are merely defaults it replaces.
  if (host.actorSelection !== undefined) {
    return { configOverrides: { modelSelection: host.actorSelection } };
  }
  // Run selection is present: replace the whole selection and do not even parse the pin; it is only the default this run replaces.
  if (host.runSelection !== undefined) {
    return { configOverrides: { modelSelection: host.runSelection } };
  }
  if (pinnedModel === undefined) return { configOverrides: {} };
  const pinned = parsePinnedModel(pinnedModel);
  // The pin matches the parent session's current model; let the child runtime baseline express
  // that. "No override" is a **stronger** expression: the baseline inherits reasoning options too,
  // while an identity-only override would replace them with an equivalent selection missing options.
  if (host.parentSelection !== undefined && sameModelIdentity(pinned, host.parentSelection)) {
    return { configOverrides: {} };
  }
  // The parent session changed its main model between runs. Keep the pin: silent model switching is
  // exactly what it prevents. To change, use AmendWorkflow's subagent_model (the branch above).
  // Do not recompute reasoning options on this path: the pin protects **model identity**
  // (providerId/modelId), and the journal records only those two segments.
  return { configOverrides: { modelSelection: pinned } };
}

/** Compare pins by the two identity segments only: journal records `providerId/modelId`; options are not identity. */
function sameModelIdentity(a: ModelSelection, b: ModelSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * Parse a pin from the journal. **No default provider**: pins are written locally as
 * `providerId/modelId`, so a missing provider segment means the record was not written in this
 * format (or was modified). Filling it from the parent session's provider would guess a new
 * identity—the very thing the pin prevents. Fail loudly instead.
 */
function parsePinnedModel(pinnedModel: string): ModelSelection {
  const parsed = parseProviderQualifiedModelSelection(pinnedModel);
  if (parsed === undefined) throw new WorkflowActorPinnedModelError(pinnedModel);
  return parsed;
}
