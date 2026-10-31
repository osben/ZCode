// ZCode Protocol v4 — draft data model.
//
// Package rule: schema types and pure functions only.
// (coalesce/conflation/apply); runtime concerns (channel buffering, subscription registries, scheduling) do not belong here.
// Coexists with the legacy packages/shared/src/zcode-protocol.
export * from "./core.js";
export * from "../background-bash-output.js";
export * from "./rows.js";
export * from "./toolDisplay.js";
export * from "./create-workflow-display.js";
export * from "./workflow-observation-display.js";
export * from "./snapshot.js";
export * from "./workflow-runs.js";
export * from "./workflow-runs-reducer.js";
export * from "./workflow-runs-holes.js";
// Key-level workflowRuns deltas (diff/apply/canonical key order); the op itself is in delta.js.
export * from "./workflow-runs-delta.js";
// Includes the boundary remnants: rejected-instance counts, entry budgets, step interpretation, eviction when full, and truncation for legacy consumers.
export * from "./workflow-runs-caps.js";
export * from "./workflow-runs-eviction.js";
export * from "./workflow-runs-tables.js";
export * from "./workflow-runs-legacy.js";
export * from "./workflow-artifact.js";
// ⚠ Differs from the previous line by only one s, and the two artifacts have different meanings: singular = the engine-internal "top-level script return value"
// serialization; plural = output published to users by script `artifact.*`. See the header in workflow-artifacts.ts.
export * from "./workflow-artifacts.js";
// Workspace transcript (playback of files.* / git.* / world.run).
export * from "./workflow-workspace.js";
export * from "./attachment-ref.js";
export * from "./attachment-faults.js";
export * from "./delta.js";
export * from "./coalesce.js";
export * from "./profiles.js";
export * from "./apply.js";
export * from "./transport.js";
export * from "./input-prediction/contract.js";
export * from "./session-data/index.js";
export * from "./wire.js";
export * from "./wire-codec.js";
export * from "./wire-reassembly.js";
export * from "./wire-assembler.js";
export * from "./wire-fault.js";
export * from "./sessions-index.js";
export * from "./sessions-index-workflow-activity.js";
export * from "./workspace-config.js";
export * from "./command.js";
export * from "./workflow-run-settings-command.js";
export * from "./shared-context-ref.js";
export * from "./shared-context-import.js";
export * from "./input-intent.js";
export * from "./submission.js";
export * from "./fork.js";
export * from "./telemetry.js";
export * from "./controller.js";
export * from "./workspace-hook-review.js";
export * from "./cuaPermission.js";

export {
  executionOutputPreviewSchema,
  type ExecutionOutputPreview,
} from "../execution-output-preview.js";

export { bashOutputDisplaySchema } from "../bash-output-display.js";
export { modelSelectionSchema, type ModelSelection } from "../model-selection.js";

export * from "../local-ttft/contract.js";
