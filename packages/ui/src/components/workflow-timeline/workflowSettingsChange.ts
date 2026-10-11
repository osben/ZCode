// ============================================================
// Two text surfaces for a settings turn
// ============================================================
// One Configure action leaves a record in two places: a transcript line above the run card ("Settings changed · subagents now use X · up to N
// running at once") and from → to rows under "You changed settings" in the details-page history. Both read the same `amend` metadata,
// so wording rules live here once. Pure function with injected formatMessage/providerName, matching subagent-model-label's convention.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import {
  describeWorkflowSubagentModel,
  type WorkflowSubagentModelDeps,
} from "./subagent-model-label.js";

/** Model name shown on screen: name only (level remains in the tooltip), using the same label as the model section on run cards. */
function modelName(canonical: string, deps: WorkflowSubagentModelDeps): string {
  return describeWorkflowSubagentModel(canonical, deps).name;
}

/**
 * Segments for the transcript row (excluding the “Settings updated” prefix and trailing time): show
 * only changed settings, model first and ceiling second. If the ceiling's `to` is absent or equals
 * default concurrency (`ceiling`, a key predating the default-concurrency concept), read it as
 * “ceiling restored to default”; report all other values as-is, including values above default.
 */
export function workflowSettingsChangeSegments(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): string[] {
  const { formatMessage } = deps;
  const segments: string[] = [];
  if (amend.subagentModel !== undefined) {
    const to = amend.subagentModel.to;
    segments.push(
      to === undefined
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.modelSession" })
        : formatMessage(
            { id: "chat.toolCall.workflow.settingsChange.model" },
            { model: modelName(to, deps) },
          ),
    );
  }
  if (amend.maxConcurrency !== undefined) {
    const to = amend.maxConcurrency.to;
    const atDefault = to === undefined || to === amend.ceiling;
    segments.push(
      atDefault
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.limitDefault" })
        : formatMessage({ id: "chat.toolCall.workflow.settingsChange.limit" }, { n: to }),
    );
  }
  return segments;
}

export interface WorkflowSettingsProvenanceRow {
  key: "model" | "limit";
  label: string;
  /** 「{from} → {to}」。 */
  value: string;
}

/**
 * from → to row in the detail-page history block. For a missing endpoint, use the default: “Session
 * model” for model and “Default” for the ceiling (include the value when default concurrency is
 * known, e.g. “Default 13 → 4”). An endpoint equal to default also reads as default; one above default is shown numerically.
 */
export function workflowSettingsProvenanceRows(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): WorkflowSettingsProvenanceRow[] {
  const { formatMessage } = deps;
  const rows: WorkflowSettingsProvenanceRow[] = [];
  if (amend.subagentModel !== undefined) {
    const end = (canonical: string | undefined) =>
      canonical === undefined
        ? formatMessage({ id: "chat.workflowLaunch.settings.sessionModel" })
        : modelName(canonical, deps);
    rows.push({
      key: "model",
      label: formatMessage({ id: "chat.workflowLaunch.settings.model" }),
      value: `${end(amend.subagentModel.from)} → ${end(amend.subagentModel.to)}`,
    });
  }
  if (amend.maxConcurrency !== undefined) {
    const defaultConcurrency = amend.ceiling;
    const end = (bound: number | undefined) =>
      bound !== undefined && bound !== defaultConcurrency
        ? String(bound)
        : defaultConcurrency === undefined
          ? formatMessage({ id: "chat.workflowLaunch.settings.defaultLimit" })
          : formatMessage(
              { id: "chat.workflowLaunch.settings.defaultLimitValue" },
              { n: defaultConcurrency },
            );
    rows.push({
      key: "limit",
      label: formatMessage({ id: "chat.workflowLaunch.settings.limit" }),
      value: `${end(amend.maxConcurrency.from)} → ${end(amend.maxConcurrency.to)}`,
    });
  }
  return rows;
}
