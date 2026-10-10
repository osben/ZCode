import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";

/**
 * The subagent model **label**: a run stores the canonical string
 * `providerId/modelId[$reasoningLevel]`, intended for machine round-tripping rather than people. A team-plan
 * providerId is a UUID, so showing it directly puts a hexadecimal string in front of the user.
 *
 * The three surfaces (confirmation dialog, run card, details pane) therefore share this pure function. Name formatting reuses the model-menu rule
 * (`formatProviderModelLabel`: built-in families show only the model name, custom providers show "provider/model"); reasoning levels reuse the
 * vocabulary from the thinking control. The canonical string appears only in the tooltip.
 *
 * Pure function with injected formatMessage/providerName, following the timeline-summary convention; this file does not access the store.
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface WorkflowSubagentModelLabel {
  /** Model name shown on screen; **never includes providerId**. */
  name: string;
  /** Localized reasoning-level label; absent when the canonical string has no `$level`. */
  level?: string;
  /** Trimmed canonical string, used only in the tooltip. */
  canonical: string;
}

export interface WorkflowSubagentModelDeps {
  formatMessage: FormatMessage;
  /**
   * providerId → provider name from the session model catalog. If absent or not found, fall back to the bare modelId.
   * This is **intentional**: never expose providerId even when its name cannot be resolved.
   */
  providerName?: (providerId: string) => string | undefined;
}

/** Fallback name when the structure cannot be parsed: remove the `providerId/` prefix and `$level` suffix, leaving the readable part. */
function fallbackName(canonical: string): string {
  const separatorIndex = canonical.indexOf("/");
  const rest = separatorIndex > 0 ? canonical.slice(separatorIndex + 1) : canonical;
  const levelIndex = rest.indexOf("$");
  const name = levelIndex > 0 ? rest.slice(0, levelIndex) : rest;
  return name.length > 0 ? name : canonical;
}

/**
 * Canonical string → label shown on screen. Parsing failure (missing provider segment or schema mismatch) does not throw:
 * UI is not a second parser, so it falls back to the bare modelId when the format is uncertain.
 */
export function describeWorkflowSubagentModel(
  canonical: string,
  deps: WorkflowSubagentModelDeps,
): WorkflowSubagentModelLabel {
  const trimmed = canonical.trim();
  let parsed: ReturnType<typeof parseModelPickerValue> | undefined;
  try {
    parsed = parseModelPickerValue(trimmed);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { canonical: trimmed, name: fallbackName(trimmed) };
  }

  // If providerName is not found in the session catalog, zcodeSessionSettingsToConfigOptions falls back to providerId itself.
  // That "name" is exactly what we must hide, so treat it as unresolved.
  const resolvedName = deps.providerName?.(parsed.providerId)?.trim();
  const providerName =
    resolvedName === undefined || resolvedName === parsed.providerId ? undefined : resolvedName;
  const name = formatProviderModelLabel(parsed.providerId, providerName, parsed.modelId);

  const rawLevel = parsed.options?.reasoningLevel;
  if (rawLevel === undefined) {
    return { canonical: trimmed, name };
  }
  // Reasoning labels use the same table as the thinking control; show values as-is when the table has no entry (custom provider levels).
  const labelId = thoughtLevelLabelId(rawLevel);
  return {
    canonical: trimmed,
    level: labelId === undefined ? rawLevel : deps.formatMessage({ id: labelId }),
    name,
  };
}

/** One-line model and reasoning label; without a level, use the model name itself (shared by confirmation dialog and tooltip). */
export function workflowSubagentModelText(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  return label.level === undefined
    ? label.name
    : formatMessage(
        { id: "chat.toolCall.workflow.subagentModel.withLevel" },
        { level: label.level, model: label.name },
      );
}

/**
 * Tooltip shared by all three surfaces: one explanatory line (where the subagent runs and that the main agent is unchanged),
 * a newline, then the canonical string. The string is for machine round-tripping and should appear only here.
 */
export function workflowSubagentModelTooltip(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  const explained = formatMessage(
    { id: "chat.toolCall.workflow.subagentModel.tooltip" },
    { model: workflowSubagentModelText(formatMessage, label) },
  );
  return `${explained}\n${label.canonical}`;
}

/**
 * The two values needed by cards and side panes: the name shown on screen (name only; level stays in the tooltip) and the tooltip.
 * Absent when the run did not specify a model; following the session model is the normal case and needs no label.
 */
export function workflowSubagentModelCardLabel(
  canonical: string | undefined,
  deps: WorkflowSubagentModelDeps,
): { name: string; title: string } | undefined {
  if (canonical === undefined) {
    return undefined;
  }
  const label = describeWorkflowSubagentModel(canonical, deps);
  return { name: label.name, title: workflowSubagentModelTooltip(deps.formatMessage, label) };
}
