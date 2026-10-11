// ============================================================
// Workflow script analysis - shared entry point with a single-slot memo
// ============================================================
//
// The approval gate analyzes the script before execution, and the handler analyzes it again afterward, so one approved call would run
// the TypeScript program twice. A single-slot memo keyed by the exact script bytes collapses this pair into one compilation. It is
// intentionally not a general-purpose cache; this adjacent pair is the only repeated work worth consolidating.
//
// Extracted into this module because **two** tools share it: CreateWorkflow compiles before running a script, and SaveWorkflow
// compiles before saving one. They must use the same checker; “it saves but cannot run” is one of the hardest failures to explain.

import { analyzeWorkflowScript, type AnalyzeResult } from "@zcode/dynamic-workflow";

let lastAnalysis: { script: string; result: AnalyzeResult } | null = null;

/** Compile and analyze a workflow script; adjacent duplicate calls hit the memo slot. */
export function analyzeScript(script: string): AnalyzeResult {
  if (lastAnalysis?.script === script) return lastAnalysis.result;
  const result = analyzeWorkflowScript(script);
  lastAnalysis = { script, result };
  return result;
}
