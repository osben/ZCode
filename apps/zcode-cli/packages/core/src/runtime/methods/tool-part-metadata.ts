import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  type CompletedToolPartMetadata,
  type ToolExecutionResult,
} from "../deps.js";
import { createMcpToolDisplay } from "../../tool/executor/result-display.js";

export function mcpToolPartMetadata(
  presentation:
    | { serverName: string; toolName: string; description?: string }
    | undefined,
): CompletedToolPartMetadata | undefined {
  const display = createMcpToolDisplay(presentation);
  return display
    ? { schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION, display }
    : undefined;
}

export function completedToolPartMetadata(
  result: ToolExecutionResult,
): CompletedToolPartMetadata {
  const serialization = result.serialization
    ? {
        truncated: result.serialization.truncated,
        originalBytes: result.serialization.originalBytes,
        returnedBytes: result.serialization.returnedBytes,
        budgetStrategy: result.serialization.budgetStrategy,
        ...(result.serialization.artifactPath
          ? { artifactPath: result.serialization.artifactPath }
          : {}),
      }
    : undefined;
  return {
    schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
    ...(result.display ? { display: result.display } : {}),
    ...(serialization ? { serialization } : {}),
    // Resume must restore the file snapshot the model actually read. Depending only on tool_result text
    // would tie the main path to provider display formatting, so persist read-state structurally in the new session.
    ...(result.readFileStateMetadata ? { readFileState: result.readFileStateMetadata } : {}),
  };
}
