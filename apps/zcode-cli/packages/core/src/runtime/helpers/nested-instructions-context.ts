// ============================================================
// Runtime adapter for nested AGENTS.md discovery
// ============================================================

import { incognitoExcludes } from "@zcode/shared";
import { readNestedInstructionHistory } from "../../context/nested-instructions/history.js";
import type { NestedInstructionContext } from "../../tool/executor/types.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Built per executor creation; undefined when the frozen incognito profile excludes project instructions. Getters read the
 * runtime at call time because the startup snapshot may not exist yet when the executor is created, and the root
 * exclusions must reflect the snapshot that is actually in effect.
 */
export function createRuntimeNestedInstructionContext(
  runtime: AgentRuntimeInternal,
): NestedInstructionContext | undefined {
  if (incognitoExcludes(runtime.config.incognito, "projectInstructions")) return undefined;
  return {
    get priorityFiles() {
      return runtime.config.userInstructions?.priorityFiles ?? ["AGENTS.md"];
    },
    get rootSourcePaths() {
      return [
        ...(runtime.contextSourceSnapshot?.userInstructions?.sources ?? []),
        ...(runtime.config.subagentContext?.userInstructions?.sources ?? []),
      ].map((source) => source.filePath);
    },
    readHistory: () =>
      readNestedInstructionHistory(
        runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
        process.platform,
      ),
    tracker: runtime.nestedInstructionTracker,
  };
}
