// ============================================================
// Resolve a model reference (`subagent_model` string → a selection)
// ============================================================
//
// Pure function, no I/O: host facts are passed in through `ModelCatalogPort` (contracts' `interfaces/model-catalog.port.ts`), while
// resolution stays in core. The reason to separate them is **testability**: the three matching tiers, case handling, tier validation,
// and unresolved-name messaging are the parts most likely to change, and mixing them with the port would require integration tests.
//
// There is one call site: `resolveInput` for `CreateWorkflow` / `AmendWorkflow`. Resolve **before** confirmation so the dialog shows
// the model that will actually be used; an unresolved call should not open a dialog at all.

import type { ModelCatalogEntry, ModelSelection } from "@zcode/contracts";
import {
  ZCODE_MODEL_REASONING_SEPARATOR,
  formatModelPickerValue,
  parseModelPickerValue,
} from "@zcode/shared/model-selection";

/**
 * Resolution result. Every failure includes `candidates`: after guessing a model name incorrectly, the most useful next step is seeing
 * what is available; otherwise the model may simply guess another spelling.
 */
type ModelReferenceResolution =
  | { ok: true; selection: ModelSelection; entry: ModelCatalogEntry; canonical: string }
  | {
      ok: false;
      reason: "not_found" | "ambiguous" | "disabled" | "reasoning_level_unknown";
      message: string;
      candidates: ModelCatalogEntry[];
    };

/**
 * Maximum number of rows in the `not_found` list. A catalog with dozens of providers may have hundreds of rows, and this text goes
 * directly into model context. Replace excess rows with “call ListModels for the rest,” which is a way to get **all** entries; silent
 * truncation is not.
 */
const MODEL_REFERENCE_CANDIDATE_LINES = 40;

/**
 * Resolve a model name from the user into a selection. Three tiers, from most to least specific (the order is part of the spec):
 *
 *   1. Exact full `providerId/modelId` match;
 *   2. Bare `modelId` belongs to exactly one provider;
 *   3. Bare `modelId` belongs to multiple providers → choose **the current session's provider** if present; otherwise `ambiguous`.
 *
 * Compare case-insensitively. The registry has no display name distinct from `modelId`, so there is no additional “search by label”
 * tier; a user's model name differs from its ID only by case and provider prefix.
 *
 * **Never silently match** a disabled entry: if only disabled entries match, return `disabled` with their reasons. Silently skipping
 * it to choose another model gives the user a model they did not request; silently selecting it delays failure until the subagent first speaks.
 *
 * When `$level` is present, it must be valid for that model (otherwise `reasoning_level_unknown`). When absent, use the registry's
 * default tier (omit options if the model has no tiers). `canonical` uses the registry's spelling in picker format; it flows unchanged
 * into the journal's `run-launched` event, both readers, and the confirmation dialog.
 */
export function resolveModelReference(
  text: string,
  entries: ModelCatalogEntry[],
): ModelReferenceResolution {
  const { reference, level } = splitReasoningLevel(text.trim());
  const matches = matchEntries(reference, entries);
  if (matches.length === 0) return notFoundResolution(text, entries);

  const enabled = matches.filter((entry) => entry.disabledReason === undefined);
  if (enabled.length === 0) return disabledResolution(text, matches);

  // Tier 3. Full names also pass through here: if the same provider/model appears twice in the catalog, that is a host issue, and
  // silently choosing the first would leave “which one did I select?” unanswered.
  const entry = enabled.length === 1 ? enabled[0]! : enabled.find((candidate) => candidate.current);
  if (entry === undefined) return ambiguousResolution(text, enabled);

  const options = resolveReasoningOptions(entry, level);
  if (options === undefined) {
    // `resolveReasoningOptions` returns undefined only when a supplied tier does not match, so `level` must be present here.
    return reasoningLevelUnknownResolution(text, entry, level ?? "");
  }

  const selection: ModelSelection = {
    // Use the registry's spelling, not the user's, so `canonical` can be passed verbatim to the next call.
    providerId: entry.providerId,
    modelId: entry.modelId,
    ...options,
  };
  return { ok: true, selection, entry, canonical: formatModelPickerValue(selection) };
}

/**
 * Convert normalized `subagent_model` into a structured selection. **Use only in the handler**: the string has already been resolved
 * by `resolveInput`, so failure means a caller bypassed normalization. Report a wiring fault instead of silently dropping the user's
 * requested model (the subagent would quietly use the session model).
 */
export function parseWorkflowSubagentModel(canonical: string | undefined): ModelSelection | undefined {
  if (canonical === undefined) return undefined;
  try {
    return parseModelPickerValue(canonical);
  } catch (cause) {
    throw new Error(
      `workflow subagent_model reached the handler un-canonicalised: ${canonical}`,
      { cause },
    );
  }
}

/**
 * One sentence in the result describing the effective subagent model (shared by `CreateWorkflow` and `AmendWorkflow`, following the
 * shape of `describeWorkflowConcurrencyLimit`). **Include only when a model was selected**: a run using the session model has nothing
 * to report, and an extra sentence could make the model think it selected something.
 *
 * The parenthetical is for the model: it may mistake “the subagent uses a different model” for “I changed models too,” then report a
 * false current model to the user on the next turn.
 */
export function describeWorkflowSubagentModel(canonical: string | undefined): string {
  if (canonical === undefined) return "";
  return ` Subagents run on ${canonical} (the main agent stays on the session model).`;
}

/** Canonical catalog entry ID (without tier): same format as `ListModels`'s `id` and the corresponding failure-list row. */
export function formatModelCatalogId(entry: ModelCatalogEntry): string {
  return `${entry.providerId}/${entry.modelId}`;
}

/**
 * Split off `$level`. Start searching after the provider separator (same as `parseModelPickerValue`): provider IDs do not contain `$`,
 * but searching the whole string as a model name would split malformed input like `a$b/c` at the wrong position.
 */
function splitReasoningLevel(text: string): { reference: string; level?: string } {
  const providerSeparatorIndex = text.indexOf("/");
  const searchFrom = providerSeparatorIndex + 1;
  const index = text.indexOf(ZCODE_MODEL_REASONING_SEPARATOR, searchFrom);
  // An empty side (`$high`, `glm$`) is not a tier; it is malformed input, so let not_found return the catalog.
  if (index <= searchFrom || index >= text.length - 1) return { reference: text };
  return { reference: text.slice(0, index), level: text.slice(index + 1) };
}

/** Candidates for tiers 1 and 2: compare full names when `/` is present, bare `modelId` otherwise. */
function matchEntries(reference: string, entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const providerSeparatorIndex = reference.indexOf("/");
  if (providerSeparatorIndex > 0) {
    const providerId = reference.slice(0, providerSeparatorIndex);
    const modelId = reference.slice(providerSeparatorIndex + 1);
    return entries.filter(
      (entry) => sameToken(entry.providerId, providerId) && sameToken(entry.modelId, modelId),
    );
  }
  return entries.filter((entry) => sameToken(entry.modelId, reference));
}

/**
 * Select a tier. Return `undefined` when the supplied tier is invalid (the caller returns `reasoning_level_unknown`); return `{}` when
 * the model has no tiers. These are different from an empty-string tier, so do not use nullish coalescing.
 */
function resolveReasoningOptions(
  entry: ModelCatalogEntry,
  level: string | undefined,
): { options?: { reasoningLevel: string } } | undefined {
  if (level !== undefined) {
    // Prefer the registry's spelling: a user-provided `HIGH` must become catalog `high`, or canonical changes on the next round trip.
    const matched = entry.reasoningLevels.find((candidate) => sameToken(candidate, level));
    return matched === undefined ? undefined : { options: { reasoningLevel: matched } };
  }
  if (entry.reasoningLevels.length === 0 || entry.defaultReasoningLevel === undefined) return {};
  return { options: { reasoningLevel: entry.defaultReasoningLevel } };
}

/**
 * Not found: list **available** IDs. Exclude disabled entries; letting the model choose one it cannot use would only cause a second
 * failure. Mark the current session's model as `[current]`: it is equivalent to “leave this unset,” and the marker lets the model know
 * that selecting it means no change.
 */
function notFoundResolution(text: string, entries: ModelCatalogEntry[]): ModelReferenceResolution {
  const candidates = entries.filter((entry) => entry.disabledReason === undefined);
  const shown = candidates.slice(0, MODEL_REFERENCE_CANDIDATE_LINES);
  const overflow = candidates.length - shown.length;
  const lines = shown.map(
    (entry) => `${formatModelCatalogId(entry)}${entry.current ? " [current]" : ""}`,
  );
  if (overflow > 0) lines.push(`… and ${overflow} more.`);
  const body =
    candidates.length === 0
      ? "No models are configured on this host."
      : ["Available models:", ...lines].join("\n");
  return {
    ok: false,
    reason: "not_found",
    message: `No configured model matches \`${text}\`. ${body}\n\nPass one of these ids, or call ListModels.`,
    candidates,
  };
}

/** Same name appears under multiple providers, and none is the current session's model: the caller must specify a full name. */
function ambiguousResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map((entry) => formatModelCatalogId(entry));
  return {
    ok: false,
    reason: "ambiguous",
    message: `\`${text}\` is configured under more than one provider:\n${lines.join("\n")}\n\nPass the full \`providerId/modelId\` of the one you want.`,
    candidates,
  };
}

/** Only disabled entries matched: include the reason, or the user will see “model does not exist” even though it is listed. */
function disabledResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map(
    (entry) => `${formatModelCatalogId(entry)} — ${entry.disabledReason}`,
  );
  return {
    ok: false,
    reason: "disabled",
    message: `\`${text}\` matches a model that cannot be used on this host:\n${lines.join("\n")}\n\nResolve that with the user, or call ListModels and pick another id.`,
    candidates,
  };
}

/** Invalid tier: the model was resolved, but the tier was wrong, so list tiers for **this model**, not the whole catalog. */
function reasoningLevelUnknownResolution(
  text: string,
  entry: ModelCatalogEntry,
  level: string,
): ModelReferenceResolution {
  const id = formatModelCatalogId(entry);
  const levels =
    entry.reasoningLevels.length === 0
      ? `${id} has no reasoning levels — drop the \`$\` suffix.`
      : `Its levels are: ${entry.reasoningLevels.join(", ")}.${
          entry.defaultReasoningLevel === undefined
            ? ""
            : ` Omit the suffix to use ${entry.defaultReasoningLevel}.`
        }`;
  return {
    ok: false,
    reason: "reasoning_level_unknown",
    message: `\`${level}\` is not a reasoning level of ${id}. ${levels}`,
    candidates: [entry],
  };
}

/** ID comparison: trim both sides and compare case-insensitively. Registry IDs are identifiers, not free text. */
function sameToken(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
