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
 * Transcript-row segments (excluding the "Settings changed" prefix and trailing timestamp): include only changed settings, model first and limit second.
 * If the limit `to` is absent or not below the ceiling, interpret it as "limit restored to local default".
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
    const atCeiling = to === undefined || (amend.ceiling !== undefined && to >= amend.ceiling);
    segments.push(
      atCeiling
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.limitCeiling" })
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
 * from → to rows in the details-page history. Show the default at a missing endpoint: "Session model" for the model and local limit for concurrency
 * (include the ceiling when known, e.g. "13 (local limit) → 4").
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
    const ceiling = amend.ceiling;
    const end = (bound: number | undefined) =>
      bound !== undefined && (ceiling === undefined || bound < ceiling)
        ? String(bound)
        : ceiling === undefined
          ? formatMessage({ id: "chat.workflowLaunch.settings.machineLimit" })
          : formatMessage({ id: "chat.workflowLaunch.settings.machineLimitValue" }, { n: ceiling });
    rows.push({
      key: "limit",
      label: formatMessage({ id: "chat.workflowLaunch.settings.limit" }),
      value: `${end(amend.maxConcurrency.from)} → ${end(amend.maxConcurrency.to)}`,
    });
  }
  return rows;
}
