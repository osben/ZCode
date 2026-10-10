import type { MessageSemantics, MessageVisibility, SyntheticUserMessageSource } from "../deps.js";
import { runtimeMetadataForSyntheticUserMessageSource } from "../helpers/index.js";

export function buildSyntheticUserNoticePartMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...metadata,
    runtimeMessage:
      metadata?.runtimeMessage ?? runtimeMetadataForSyntheticUserMessageSource(source),
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeMessageMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.runtimeMessage;
  return {
    ...next,
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeSemantics(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
): MessageSemantics {
  if (source === "shared_context") {
    return {
      origin: "import",
      kind: "shared_context",
      source,
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    };
  }
  const providerVisible = visibility === "model-only";
  return {
    origin: "agent_runtime",
    kind: syntheticUserNoticeKind(source),
    source,
    uiVisibility: providerVisible ? "hidden" : "visible",
    providerVisibility: providerVisible ? "visible" : "hidden",
    // Provider-visible user-role runtime context is not user transcript.
    // If synthetic notices for fork/goal/background are marked transcript-visible,
    // v4 hydration will mistake them for real user turns.
    transcriptVisibility: providerVisible ? "hidden" : "visible",
  };
}

function syntheticUserNoticeKind(source: SyntheticUserMessageSource): MessageSemantics["kind"] {
  switch (source) {
    case "background_task":
      return "background_notification";
    case "fork":
      return "fork_notice";
    // goal_state_change is a runtime injection source added by the trajectory branch (goal-change notification in target.ts),
    // with the same system-reminder semantics as goal-continuation.
    case "goal_state_change":
      return "system_reminder";
    case "goal-continuation":
      return "system_reminder";
    case "plugin_reference":
      return "system_reminder";
    case "rewind":
      return "rewind_notice";
    case "selection_side_chat":
      return "system_reminder";
    case "subagent":
      return "subagent_notification";
    case "subagent_message":
      // Model-only runtime carrier from child to parent.
      // If it is not enumerated here as well, persisted messages get kind=undefined and cannot retain equivalent semantics after cold recovery.
      return "subagent_notification";
    case "todo_reminder":
      return "todo_reminder";
    // The directly started launch turn does not use this synthetic-notice factory (it requires origin=real_user, kind=user_prompt,
    // written directly by the dedicated persistence path in message-persistence). Register the same kind here only for exhaustive completeness.
    case "workflow_launch":
      return "user_prompt";
    case "shared_context":
      return "shared_context";
  }
}
