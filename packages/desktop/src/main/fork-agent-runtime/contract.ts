/**
 * desktop-fork-agent-runtime public contract (specs/fork-agent-runtime-selection.md).
 *
 * - primeForkAgentRuntimeSelection: resolve once per app process before the first Host fork;
 *   idempotent (later calls return the first decision); never rejects.
 * - getForkAgentRuntimeSelection: synchronous read of the latched decision; undefined before priming.
 * - buildForkAgentRuntimeHostEnv: pure; removes inherited runtime keys and writes the decided ones.
 */
export {
  buildForkAgentRuntimeHostEnv,
  getForkAgentRuntimeSelection,
  primeForkAgentRuntimeSelection,
  resetForkAgentRuntimeSelectionForTests,
  resolveForkAgentRuntimeSelection,
  resolveRustAgentBinaryCandidates,
  rustAgentBinaryName,
} from "./selection.js";
export type { ForkAgentRuntimeSelection, ForkAgentRuntimeSelectionSource } from "./selection.js";
