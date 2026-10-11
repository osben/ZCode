// ============================================================
// ListModels Tool - list models configured by this host
// ============================================================
//
// Read-only, side-effect-free discovery surface for one purpose: the main agent needs to select
// a subagent model for a workflow run (`subagent_model` in `CreateWorkflow` / `AmendWorkflow`).
// This is not a model-selection switch; the tool cannot change the session's own model, and
// the main agent always remains on the model selected by the user.
//
// This and the resolver are **complementary paths**: first pass the name supplied by the user;
// if it cannot be resolved, the tool returns the candidates too. This tool is the proactive
// path ("Which models are available?"). Both read the same live catalog
// ({@link import("../interfaces/model-catalog.port.js").ModelCatalogPort}).

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_MODELS_TOOL_NAME = "ListModels";

export const ListModelsInputSchema = z
  .object({})
  // Same constraint as ListSavedWorkflows: no inputs. Do not add filtering, pagination, or
  // fuzzy search; the catalog is only a few dozen rows, and each extra control gives the model
  // another reason to think the list is incomplete.
  .strict();

export type ListModelsInput = z.infer<typeof ListModelsInputSchema>;

export const ListModelsInputJsonSchema = toToolJsonSchema(ListModelsInputSchema);

/** One catalog row. `id` is the canonical form that can be copied **verbatim** into `subagent_model`. */
export const ListModelsEntrySchema = z
  .object({
    /** Canonical form `providerId/modelId` (without a reasoning level; append `$level` to select one). */
    id: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    /** Human-readable provider name; omitted when the registry does not supply one. */
    providerLabel: z.string().optional(),
    /** Valid `$level` values. Models without levels have an empty array, which tells readers that appending `$` is invalid. */
    reasoningLevels: z.array(z.string()),
    /** Level used when no `$level` is appended; omitted when `reasoningLevels` is empty. */
    defaultReasoningLevel: z.string().optional(),
    contextWindow: z.number().optional(),
    /** Why it cannot be selected; omitted (rather than an empty string) when selectable. */
    disabledReason: z.string().optional(),
  })
  .strict();

export type ListModelsEntry = z.infer<typeof ListModelsEntrySchema>;

export const ListModelsOutputSchema = z
  .object({
    /**
     * Model currently used by the session (canonical form). **A reference point, not a
     * recommendation**: a subagent uses it when `subagent_model` is omitted, so "set the
     * subagent to this one" would do nothing. Omitted if it does not match any catalog entry.
     */
    current: z.string().optional(),
    models: z.array(ListModelsEntrySchema),
  })
  .strict();

export type ListModelsOutput = z.infer<typeof ListModelsOutputSchema>;

export const ListModelsOutputJsonSchema = toToolJsonSchema(ListModelsOutputSchema);
