// ============================================================
// run-launched: host metadata for the run invocation → event
// ============================================================
// The engine does not read this metadata (anchor, phase table, parallelism table, subagent model);
// it transcribes it verbatim once after the first `run-started` event when the run is created
// (engine.ts). Keeping the construction in a separate module lets both engine.ts and types.ts
// remain under the 400-line lint limit; both files grow from this data.

import type { RunEvent } from "./types.js";

/**
 * Host metadata that accompanies `run-launched` in the turn that starts a run (EngineConfig.launch): anchor `inputId`,
 * script-declared phase table `phaseNames`, positional `phaseAlongside`, this run's subagent model `subagentModel` and permission mode `subagentPermissionMode`,
 * binding table `modelBindings` for models named by the script, source file `scriptPath`, and hole-index table `holes`. The engine reads none of these eight values—see the
 * `run-launched` comment in types.ts for their semantics.
 */
export interface RunLaunchConfig {
  inputId: string;
  phaseNames?: string[];
  subagentModel?: string;
  /** Model name written literally in the script → canonical ID (docs/dynamic-workflow/launch.md, “Models the script names”). */
  modelBindings?: Record<string, string>;
  /**
   * Permission mode for this run's subagents (docs/dynamic-workflow/launch.md, “Permissions inside a run”):
   * the initiating session's permission-mode name. The engine stores it as an opaque string without reading it; the host validates it when reading it back.
   */
  subagentPermissionMode?: string;
  /** Absolute path to this run's script file (docs/dynamic-workflow/launch.md, “Script files”). */
  scriptPath?: string;
  phaseAlongside?: number[][];
  /** Indices of unfilled holes in `phaseNames` (docs/execution-engine.md, “Holes”), stored alongside the launch event. */
  holes?: number[];
}

/**
 * Transcribe launch metadata into `run-launched`. Unset keys are **omitted** rather than written
 * with undefined values: readers (AmendWorkflow's tri-state and projections) distinguish “unset”
 * from “set to empty.”
 */
export function runLaunchedEvent(
  launch: RunLaunchConfig,
  origin: { toolCallId?: string | undefined; parentSessionId?: string | undefined },
): RunEvent {
  const {
    inputId,
    phaseNames,
    subagentModel,
    subagentPermissionMode,
    modelBindings,
    scriptPath,
    phaseAlongside,
    holes,
  } = launch;
  return {
    type: "run-launched",
    inputId,
    ...(origin.toolCallId === undefined ? {} : { toolCallId: origin.toolCallId }),
    ...(origin.parentSessionId === undefined ? {} : { parentSessionId: origin.parentSessionId }),
    ...(phaseNames === undefined ? {} : { phaseNames }),
    ...(subagentModel === undefined ? {} : { subagentModel }),
    ...(subagentPermissionMode === undefined ? {} : { subagentPermissionMode }),
    ...(modelBindings === undefined ? {} : { modelBindings }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
    ...(holes === undefined ? {} : { holes }),
  };
}
