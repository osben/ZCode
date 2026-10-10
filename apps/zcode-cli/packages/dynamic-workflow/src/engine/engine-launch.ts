// ============================================================
// run-launched: host metadata for the run invocation → event
// ============================================================
// The engine does not read this metadata (anchor, phase table, parallelism table, subagent model);
// it transcribes it verbatim once after the first `run-started` event when the run is created
// (engine.ts). Keeping the construction in a separate module lets both engine.ts and types.ts
// remain under the 400-line lint limit; both files grow from this data.

import type { RunEvent } from "./types.js";

/**
 * Host metadata shipped with `run-launched` for the run invocation (EngineConfig.launch): anchor
 * `inputId`, script-declared phase table `phaseNames`, positionally aligned `phaseAlongside`, the
 * subagent model choice for this run `subagentModel`, and the script source file `scriptPath`. The
 * engine reads none of these five values; see the `run-launched` comment in types.ts for field
 * semantics.
 */
export interface RunLaunchConfig {
  inputId: string;
  phaseNames?: string[];
  subagentModel?: string;
  /** Absolute path to this run's script file. */
  scriptPath?: string;
  phaseAlongside?: number[][];
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
  const { inputId, phaseNames, subagentModel, scriptPath, phaseAlongside } = launch;
  return {
    type: "run-launched",
    inputId,
    ...(origin.toolCallId === undefined ? {} : { toolCallId: origin.toolCallId }),
    ...(origin.parentSessionId === undefined ? {} : { parentSessionId: origin.parentSessionId }),
    ...(phaseNames === undefined ? {} : { phaseNames }),
    ...(subagentModel === undefined ? {} : { subagentModel }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
  };
}
