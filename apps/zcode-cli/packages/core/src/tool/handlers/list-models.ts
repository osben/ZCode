// ============================================================
// ListModels Tool Handler
// ============================================================
// List models configured on this host.
//
// This tool has one purpose: let the primary agent choose a subagent model (`subagent_model`) for a workflow run. It is **not a model
// switch** and cannot change the session's own model. The description must say so clearly, or the model may treat it as a way to
// “switch my own model” and tell the user a change happened when it did not.
//
// This and the resolver (model-reference.ts) are complementary paths: the resolver is passive (the user names a model, and if it
// cannot resolve it, returns the candidates); this tool is proactive (“which models are available?”). Both read the same **live**
// catalog—the port reads the registry view on every call and never returns a frozen construction-time copy.

import {
  LIST_MODELS_TOOL_NAME,
  ListModelsInputJsonSchema,
  ListModelsInputSchema,
  ListModelsOutputJsonSchema,
  ListModelsOutputSchema,
  type ListModelsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";
import { formatModelCatalogId } from "./model-reference.js";

const LIST_MODELS_TIMEOUT_MS = 10_000;
/** As with ListSavedWorkflows, keep the catalog lightweight (answered from one in-memory read); 24k is enough for dozens of rows with room to spare. */
const LIST_MODELS_MODEL_BYTES = 24_000;

/**
 * Business failure code. The number is only for logs (the executor projects it as `code: "N"`); the discriminator is the message
 * prefix. Start at 31 to avoid visual collisions with workflow introspection codes (1/2), ResumeWorkflowRun (11–15), and AmendWorkflow (21–23).
 */
const LIST_MODELS_ERROR_CODE = { CATALOG_UNAVAILABLE: 31 } as const;

const LIST_MODELS_DESCRIPTION = [
  "Lists the models this host has configured, so a dynamic workflow's subagents can be pointed at one.",
  "",
  "- Each row's `id` (`providerId/modelId`) pastes verbatim into the `subagent_model` field of CreateWorkflow or AmendWorkflow. Append `$<level>` to pick a reasoning level from that row's `reasoningLevels`.",
  "- This tool does NOT change the model you are running on. The session model is the user's choice and only the user changes it; `subagent_model` only moves the workflow's subagents.",
  "- The model the session is on right now is marked `[current]` — setting the subagents to that one is the same as omitting the field.",
  "- A row marked `disabled` cannot be used (no API key, disabled by policy). Resolve that with the user rather than picking around it silently.",
].join("\n");

/**
 * “This session has no model catalog.” **Never** silently return an empty list: that would conflate “no models configured on this
 * machine” with “this session cannot read the catalog” (same reason as `workflow_introspection_unavailable`), leading the model to
 * tell the user there are no models even though one is in use.
 */
function modelCatalogUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: LIST_MODELS_ERROR_CODE.CATALOG_UNAVAILABLE,
    message:
      "model_catalog_unavailable: this session cannot list models — the host did not provide a model catalog. This is a capability gap, not an empty configuration. Omit `subagent_model` on CreateWorkflow and AmendWorkflow; the workflow's subagents will run on the session model.",
  };
}

const listModelsHandler: ToolHandler = async (input, context) => {
  ListModelsInputSchema.parse(input);

  const port = context.modelCatalogPort;
  if (port === undefined) return modelCatalogUnavailableFailure();

  const entries = port.listModels();
  const current = entries.find((entry) => entry.current);

  return {
    // Omit when no catalog entry is marked current (allowed by the port contract: the session selection may point to a deleted
    // provider). An empty string would make the model read “no current model” as “the current model is named empty.”
    ...(current === undefined ? {} : { current: formatModelCatalogId(current) }),
    models: entries.map((entry) => ({
      id: formatModelCatalogId(entry),
      providerId: entry.providerId,
      modelId: entry.modelId,
      ...(entry.providerLabel === undefined ? {} : { providerLabel: entry.providerLabel }),
      // Use an empty array for a model with no tiers rather than omitting it: readers can tell that appending `$` is invalid, while
      // omission would look like “this row did not say.”
      reasoningLevels: [...entry.reasoningLevels],
      ...(entry.defaultReasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: entry.defaultReasoningLevel }),
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      ...(entry.disabledReason === undefined ? {} : { disabledReason: entry.disabledReason }),
    })),
  } satisfies ListModelsOutput;
};

/**
 * Model-facing format: one row per model.
 *
 * Intentionally differs from ListSavedWorkflows' **multi-line block** format (each saved workflow needs a description, usage context,
 * and argument table). Model rows are low-information, high-cardinality entities: dozens look alike, and the model only needs to copy
 * a row's `id` into `subagent_model`. One line per model is sufficient and keeps the full catalog within the 24k budget.
 */
function formatListModelsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListModelsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListModels returned an invalid result.";
  const { current, models } = parsed.data;

  if (models.length === 0) {
    // Explicitly say when none are configured; an empty container can look like the tool failed to answer.
    return [
      '<models count="0">',
      "No models are configured on this host. Omit `subagent_model`: the workflow's subagents run on the session model.",
      "</models>",
    ].join("\n");
  }

  const lines = models.map((model) => {
    const parts = [model.id];
    if (model.providerLabel !== undefined) parts.push(` — ${model.providerLabel}`);
    if (model.reasoningLevels.length > 0) {
      const levels = model.reasoningLevels.join(",");
      const fallback =
        model.defaultReasoningLevel === undefined ? "" : ` (default ${model.defaultReasoningLevel})`;
      parts.push(`; levels: ${levels}${fallback}`);
    }
    // Put current and disabled at the end of each row, each in brackets: the model uses them to **exclude** a row, and a longer tier
    // list in the middle could push them out of view.
    if (model.id === current) parts.push(" [current]");
    if (model.disabledReason !== undefined) parts.push(` [disabled: ${model.disabledReason}]`);
    return parts.join("");
  });

  return [`<models count="${models.length}">`, ...lines, "</models>"].join("\n");
}

export const listModelsToolEntry: ToolEntry = {
  capability: "List the models this host has configured, for choosing a workflow's subagent model",
  metadata: {
    shouldDefer: true,
    name: LIST_MODELS_TOOL_NAME,
    description: LIST_MODELS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_MODELS_TIMEOUT_MS,
    maxOutputBytes: LIST_MODELS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listModelsHandler,
  inputSchema: ListModelsInputJsonSchema,
  outputSchema: ListModelsOutputJsonSchema,
  runtimeInputSchema: ListModelsInputSchema,
  runtimeOutputSchema: ListModelsOutputSchema,
  formatModelContent: formatListModelsModelContent,
  permission: {
    permission: "listModels",
    reason: "ListModels reads the host's configured model catalog",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // Input is an empty object, so match only by tool name (same as ListSavedWorkflows).
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Intentionally **do not** inherit CreateWorkflow's alwaysAsk: that gate exists because it executes a full code block, which does
    // not apply to reading the configured model list.
  },
  resultBudget: {
    maxInlineBytes: LIST_MODELS_MODEL_BYTES,
    maxModelBytes: LIST_MODELS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_MODELS_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_MODELS_TIMEOUT_MS,
    maxMs: LIST_MODELS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ListModels reads the in-memory model catalog and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
