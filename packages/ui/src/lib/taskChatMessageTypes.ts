// Re-home these types to prepare for removing zcodeChatMessages, following the pattern in zcode-task-types-core.
// This file owns the load-bearing types from the legacy message-conversion layer (zcodeChatMessages/zcodeChatMessageHelpers)
// that are still consumed as types by the active stack. These include TaskChatMessage / TaskChatToolCall / TaskChatMessagePart.
// Consumers: ToolCallBlocks(toolCallTree) / PermissionDialog / taskChangeSummary /
// treemappingActivity / codeViewer / toolDisplay / toolError / app-shell test injection channel.
// After deleting the legacy message assembly runtime (zcodeChatMessages.ts), this is the sole source of these types.
import type {
  ZCodeAssistantMessagePart,
  ZCodeAssistantMessageFeedback,
  ZCodePromptAttachment,
  ZCodeTimelineMeta,
  ZCodeTaskSnapshotBodyRef,
  ZCodeTaskSnapshotToolFieldRef,
  ZCodeTaskSnapshotToolSlice,
} from "@zcode/shared";

export interface TaskChatToolCall {
  toolId: string;
  /** Parent toolCallId; null means the main agent, non-null means a Task/Agent child tool. */
  parentToolUseId?: string | null;
  /** Fixed ZCode tool name; keep kind for compatibility with older ZCode Agent snapshots and UI aggregation. */
  toolName?: string;
  kind: string;
  title?: string;
  input: unknown;
  status: string;
  /** Child-agent body output belonging to parentToolUseId. */
  content?: string;
  /** Child-agent reasoning output belonging to parentToolUseId. */
  thought?: string;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** Reference to large tool fields trimmed by the snapshot budget; used to lazily fetch the full input/output/raw values for this tool. */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
  /** Local time when the tool call first entered the current message stream; used only to identify long-running tool calls. */
  startedAt?: number;
  /** Wall-clock span of a finished aggregate stage (Explore/Execute), derived from projected row timestamps. */
  durationMs?: number;
}

export type TaskChatMessagePart = ZCodeAssistantMessagePart;

export interface TaskModelChangeUiTimeline {
  type: "model_change";
  fromModelLabel: string;
  toModelLabel: string;
}

export type TaskUiTimelineMeta = TaskModelChangeUiTimeline;

export interface TaskChatMessage {
  id: string;
  /** Stable protocol messageId from the session snapshot; a live stream ID may be only a temporary display identity. */
  protocolMessageId?: string;
  /** Original messageId set retained after merging assistant messages from a snapshot, so timeline anchors can match pre-merge child messages. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Legacy goal display iteration owned by the assistant; used only for historical-area status text, not verifier-turn decisions. */
  goalIteration?: number;
  /** UI-only streaming group; separates continuation of a model-only goal and does not affect goal-turn semantics. */
  streamGroupId?: string;
  mailboxMessage?: {
    content: string;
    createdAt?: string;
    fromSessionId: string;
    messageId: string;
  };
  /** Final elapsed time for an assistant message; written only after the turn ends to avoid re-estimating it every time the UI restores. */
  durationMs?: number;
  /** Whether the assistant ended through an explicit stop/interruption; prevents the UI from misclassifying the latest area as “naturally completed.” */
  interrupted?: boolean;
  /** Local user feedback for an assistant response; display/persistence only and not included in subsequent model context. */
  feedback?: ZCodeAssistantMessageFeedback;
  attachments?: ZCodePromptAttachment[];
  toolCalls?: TaskChatToolCall[];
  thought?: string;
  /** Previously, assistant messages rendered only aggregated thought/tool/content fields, so if one turn contained both body text and tool calls the UI could only place “tools above, body below.” Store the true arrival order of streaming events here so the renderer can replay by event order instead of hard-grouping by fields. */
  parts?: TaskChatMessagePart[];
  /** Conversation turn containing this message, used to associate per-turn file-change summaries and rollback. */
  turnIndex?: number;
  /** Full-body reference for the first-screen preview of a large message. When present, the UI must treat the body as incompletely loaded. */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** Cursor data when tools are returned in slices; used to fetch more tool calls. */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** Whether output is still streaming; used only to restore the current runtime UI and not persisted. */
  streaming?: boolean;
  /** Synthetic timeline message from the ZCode Agent; excluded from assistant body, tool calls, and fork. */
  syntheticTimeline?: ZCodeTimelineMeta;
  /** UI-only synthetic timeline message, not included in protocol snapshots or local history. */
  uiTimeline?: TaskUiTimelineMeta;
  /** ZCode CLI turn-steering state marker, used only for displaying the user message. */
  turnSteer?: {
    status: "guided";
  };
}
