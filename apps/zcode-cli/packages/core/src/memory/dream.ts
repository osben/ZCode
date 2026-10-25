import type { ModelToolCall } from "@zcode/contracts";
import { DEFAULT_MEMORY_DREAM_PROMPT, renderSystemPromptTemplate } from "@zcode/shared";

import { analyzeBashCommand } from "../tool/handlers/bash-command-parser.js";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";

export {
  acquireDreamLock,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
  writeDreamConsolidatedAt,
  type DreamLockLease,
} from "./dream-lock.js";
const AUTO_DREAM_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_DREAM_SCAN_THROTTLE_MS = 10 * 60 * 1000;

export type AutoDreamTimingDecision =
  | { decision: "scan" }
  | { decision: "skip"; reason: "minimum-interval" | "scan-throttled" };

export function evaluateAutoDreamTiming(input: {
  lastConsolidatedAtMs: number;
  lastScanAtMs: number;
  nowMs: number;
}): AutoDreamTimingDecision {
  if (input.nowMs - input.lastConsolidatedAtMs < AUTO_DREAM_MINIMUM_INTERVAL_MS) {
    return { decision: "skip", reason: "minimum-interval" };
  }
  if (input.nowMs - input.lastScanAtMs < AUTO_DREAM_SCAN_THROTTLE_MS) {
    return { decision: "skip", reason: "scan-throttled" };
  }
  return { decision: "scan" };
}

export function buildMemoryDreamPrompt(input: {
  memoryRoot: string;
  /** `memory-dream` system-prompt override; blank keeps the default body. */
  override?: string;
  sessionIds: readonly string[];
  transcriptRoot: string;
}): string {
  const sessionLines = input.sessionIds.map((sessionId) => `- ${sessionId}`).join("\n");
  const body = renderSystemPromptTemplate(
    input.override?.trim() || DEFAULT_MEMORY_DREAM_PROMPT,
    { memoryRoot: input.memoryRoot, transcriptRoot: input.transcriptRoot },
  );
  // The tail mirrors the restricted execution policy and the gate's session selection, so it
  // stays runtime-owned even when the `memory-dream` override replaces the body.
  return `${body}\n\n## Additional context



**Tool constraints for this run:** Shell access is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar) plus deleting \`.md\` paths inside the memory directory. Anything else that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind — no need to probe.

Sessions since last consolidation (${input.sessionIds.length}):
${sessionLines}`;
}

export function collectDreamTouchedPaths(
  paths: Set<string>,
  input: {
    rootDir: string;
    toolCall: ModelToolCall;
    workingDirectory: string;
    workspaceRoot: string;
  },
): void {
  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    const filePath = stringProperty(input.toolCall.input, "file_path");
    const resolved = filePath ? resolveTouchedPath(filePath, input) : undefined;
    if (resolved) paths.add(resolved);
    return;
  }
  if (input.toolCall.name !== "Bash") return;
  const command = stringProperty(input.toolCall.input, "command");
  if (!command) return;
  const analysis = analyzeBashCommand(command);
  for (const invocation of analysis.commands) {
    if (invocation.argv[0] !== "rm") continue;
    for (const argument of invocation.argv.slice(1)) {
      if (argument === "--" || argument.startsWith("-")) continue;
      const resolved = resolveTouchedPath(argument, input);
      if (resolved) paths.add(resolved);
    }
  }
}

function resolveTouchedPath(
  filePath: string,
  input: Pick<
    Parameters<typeof collectDreamTouchedPaths>[1],
    "rootDir" | "workingDirectory" | "workspaceRoot"
  >,
): string | undefined {
  if (!filePath.endsWith(".md")) return undefined;
  try {
    return resolveContainedMemoryFilePath({
      filePath,
      rootDir: input.rootDir,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return undefined;
  }
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}
