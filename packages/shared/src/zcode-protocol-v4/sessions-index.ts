// sessions-index topic: live data source for the list; conflated latest state that never overflows.
import { z } from "zod";
import { zcodeExecutionWorktreeSchema } from "../zcode-protocol/index.js";
import { timestampSchema } from "./core.js";
import { sessionWorkflowActivitySchema } from "./sessions-index-workflow-activity.js";
import {
  goalStateSchema,
  interactionAutoResolutionSchema,
  sessionMetaStateSchema,
  sessionPhaseSchema,
} from "./snapshot.js";

export const sessionPendingInteractionSummarySchema = z.object({
  interactionId: z.string(),
  kind: z.enum(["permission", "userInput"]),
  // Sends only lightweight tool identity so the sidebar can distinguish AskUserQuestion from other blocking confirmations; includes no question or answer.
  toolName: z.string().optional(),
  autoResolution: interactionAutoResolutionSchema.optional(),
});
export type SessionPendingInteractionSummary = z.infer<
  typeof sessionPendingInteractionSummarySchema
>;

export const pendingInteractionSummarySchema = z.object({
  permissionCount: z.number().int().nonnegative(),
  userInputCount: z.number().int().nonnegative(),
});
export type PendingInteractionSummary = z.infer<typeof pendingInteractionSummarySchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  // Fork tree.
  parentSessionId: z.string().optional(),
  title: z.string(),
  // custom = explicitly renamed by the user; default/generated are not manual titles in product semantics.
  // optional preserves compatibility with old sessions-index frames and persisted summaries.
  titleSource: sessionMetaStateSchema.shape.titleSource.optional(),
  phase: sessionPhaseSchema,
  sessionEnded: z.boolean(),
  // Used by the list indicator (keep it boolean here so the sidebar does not have to subscribe to all of backgroundWorks).
  hasBackgroundWork: z.boolean(),
  // Sidebar workflow run rows: bounded run summaries,
  // with only the fields needed to draw the mini track; absent when the session has no runs. optional preserves compatibility with old frames/CLI.
  workflowActivity: sessionWorkflowActivitySchema.optional(),
  pendingInteraction: sessionPendingInteractionSummarySchema.optional(),
  // The sidebar needs only kind/count; do not send sensitive payloads such as questions, commands, or answers.
  // optional preserves compatibility with old sessions-index frames and stored summaries.
  pendingInteractionSummary: pendingInteractionSummarySchema.optional(),
  goalStatus: goalStateSchema.shape.status.optional(),
  // Unread state is derived by comparing the client's locally stored lastSeenActivityAt (not seq, since the epoch resets).
  lastActivityAt: timestampSchema,
  // ≤120 characters.
  lastAssistantPreview: z.string().optional(),
  // Execution worktree (session runs in a linked worktree while listed under workspaceId): drives the
  // sidebar worktree badge and the header/file-tree "open in IDE/folder" target. optional preserves
  // compatibility with old sessions-index frames and stored summaries.
  executionWorktree: zcodeExecutionWorktreeSchema.optional(),
  // True when the worktree directory was absent when this summary was derived (host-side stat).
  // Top-level on purpose: old parsers strip unknown summary keys but the nested worktree schema is
  // strict, so a nested flag would fault whole frames on older clients (spec: execution-worktree-missing-handling.md §3).
  executionWorktreeMissing: z.boolean().optional(),
  createdAt: timestampSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionsIndexSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: z.string(),
  // Host-level list log generation (independent of each session's logEpoch).
  logEpoch: z.string(),
  // Unordered; sorting is client display logic.
  sessions: z.array(sessionSummarySchema),
});
export type SessionsIndexSnapshot = z.infer<typeof sessionsIndexSnapshotSchema>;

export const sessionsIndexDeltaSchema = z.discriminatedUnion("op", [
  // conflation key = sessionId.
  z.object({ op: z.literal("session.upserted"), session: sessionSummarySchema }),
  z.object({ op: z.literal("session.removed"), sessionId: z.string() }),
]);
export type SessionsIndexDelta = z.infer<typeof sessionsIndexDeltaSchema>;

/** Constructs a sessions-index topic key (the counterpart to parseSessionsIndexTopic). */
export function sessionsIndexTopic(workspaceId: string): string {
  return `sessions-index/${workspaceId}`;
}

/** Parse a sessions-index topic key ("sessions-index/<workspaceId>"). */
export function parseSessionsIndexTopic(topic: string): string | null {
  if (!topic.startsWith("sessions-index/")) return null;
  const workspaceId = topic.slice("sessions-index/".length);
  return workspaceId.length > 0 ? workspaceId : null;
}
