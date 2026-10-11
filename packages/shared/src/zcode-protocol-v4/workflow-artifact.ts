/**
 * Convert **any script value** in a workflow run (a top-level returned artifact or an item from
 * `report(item)`) into text for the model or reader. Rules: preserve strings; otherwise use
 * `JSON.stringify(v, null, 2)`; if stringify returns undefined or throws, fall back to `String(v)`;
 * `undefined` returns `undefined` so callers can omit the entire field.
 *
 * It originally lived in contracts (dynamic-workflow-run.port.ts) because its three cross-package
 * consumers needed byte-identical text: completion-notification `<result>` / `<reports>` (core),
 * runtime task-entry `resultText` (core, the only source for TaskOutput), and
 * `workflowRuns.reports[].preview` (V4 projection, the line in the details page's Results section).
 * It moved here when a fourth consumer appeared: `reports[].preview` reduction moved into this package
 * with the shared reducer (workflow-runs-reducer.ts), and dependencies flow contracts → shared, so this
 * package cannot import contracts. Contracts keeps its re-export and core consumers remain unchanged.
 *
 * Similarly, there is no length limit here: notifications truncate at 120k, TaskOutput has an artifact
 * budget, and the projection has `maxReportPreviewLength`. Each boundary owns its own limit.
 *
 * Artifact shape is unconstrained: records, arrays, strings, numbers, and null are all valid, so there is
 * no `isRecord` gate here. The previous implementation read `output.response` from the legacy
 * `Workflow` shape, which caused the desktop bug observed in testing.
 */
export function serializeWorkflowArtifact(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    // JSON.stringify returns undefined for undefined/function/symbol and throws on circular references.
    // Fall back to String(value) in both cases so the value is never dropped entirely.
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
