// ============================================================
// Workflow analysis → display - the only projection from static analysis to display graph/result card
// ============================================================
//
// The display graph combines **three** analyzer projections: the causal graph supplies stations and lanes, the control-flow graph
// supplies phases and phase edges, and the handoff graph supplies each phase's subagent cards and handoff edges. Omitting any one
// silently drops a layer—the run details side pane for a directly started workflow had no timeline or subagents because the launch path
// passed only the causal graph. Build “analysis result → bounded display graph” here once; CreateWorkflow's handler, confirmation gate,
// and direct-launch path all call this function instead of assembling `boundCausalityGraph(...)` arguments themselves.

import {
  CREATE_WORKFLOW_TOOL_NAME,
  type CreateWorkflowCausalityGraph,
  type CreateWorkflowOutput,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import type { AnalyzeResult } from "@zcode/dynamic-workflow";
import { createCreateWorkflowDisplay } from "../executor/result-display.js";
import { boundCausalityGraph } from "./create-workflow-graph-bounds.js";

/** Bounded display graph from analysis; absent when no station could be analyzed (compilation fails before causal graph creation). */
export function boundGraphOfAnalysis(
  analysis: AnalyzeResult,
): CreateWorkflowCausalityGraph | undefined {
  return analysis.causality === undefined
    ? undefined
    : boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff);
}

/**
 * `create_workflow` display from analysis (confirmation dialog and launch-turn metadata). The model-facing `response` is not used by
 * these readers; the display projection itself does not read it. AmendWorkflow passes its own tool name: both launch tools share the
 * same display kind.
 */
export function displayOfAnalysis(
  analysis: AnalyzeResult,
  toolName: string = CREATE_WORKFLOW_TOOL_NAME,
): ToolResultDisplayPayload | undefined {
  const causalityGraph = boundGraphOfAnalysis(analysis);
  return createCreateWorkflowDisplay(toolName, {
    diagnostics: analysis.diagnostics,
    ok: analysis.ok,
    response: "",
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput);
}
