// CLI-side reducer for the sessions-index topic: derive SessionSummary values from each workspace session's
// ConversationSnapshot, maintain the conflated latest state, and produce upsert/remove deltas.
// This reducer is pure and performs no I/O; the publisher (sessions-index-publisher) tracks sequence numbers and builds frames,
// while the gateway (v4-gateway) owns event subscriptions and flush scheduling.
import {
  deriveSessionWorkflowActivity,
  type ConversationSnapshot,
  type SessionSummary,
  type SessionsIndexDelta,
  type SessionsIndexSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/** Session metadata outside the snapshot needed to derive a summary (from the session-store record / event time). */
export interface SessionSummaryDeriveExtra {
  workspaceId: string;
  createdAt: number;
  lastActivityAt: number;
  parentSessionId?: string;
}

const MAX_PREVIEW_CHARS = 120;

/** Derive SessionSummary from ConversationSnapshot + session metadata (a pure function, covered by golden tests). */
export function deriveSessionSummary(
  snapshot: ConversationSnapshot,
  extra: SessionSummaryDeriveExtra,
): SessionSummary {
  // Use the text of the final assistantText row as the preview (≤120 characters).
  let lastAssistantPreview: string | undefined;
  const rows = snapshot.rows.window;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (
      !lastAssistantPreview &&
      row &&
      row.kind === "assistantText" &&
      row.text.trim().length > 0
    ) {
      lastAssistantPreview = row.text.slice(0, MAX_PREVIEW_CHARS);
    }
    if (lastAssistantPreview) break;
  }
  const hasBackgroundWork = snapshot.backgroundWorks.some((work) => work.status === "running");
  // Data for workflow-run rows in the sidebar:
  // derive it from workflowRuns + backgroundWorks in the same snapshot so the sidebar need not subscribe to run progress.
  const workflowActivity = deriveSessionWorkflowActivity({
    workflowRuns: snapshot.workflowRuns,
    backgroundWorks: snapshot.backgroundWorks,
  });
  // workspaceHookReview is shown in Hooks Settings; do not map it to a permission/userInput sidebar badge.
  const pending = snapshot.pendingInteractions.find(
    (interaction) => interaction.kind === "permission" || interaction.kind === "userInput",
  );
  const permissionCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "permission",
  ).length;
  const userInputCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "userInput",
  ).length;
  // Support reduced snapshots built by recovery migrations or reducer tests: adding the lightweight toolName projection
  // must not block the entire task list when an older pending interaction lacks a payload.
  const pendingPayload = pending?.payload;
  const pendingToolName =
    pendingPayload && "toolName" in pendingPayload ? pendingPayload.toolName : undefined;
  const pendingInteraction =
    pending &&
    pendingPayload &&
    (pendingPayload.kind === "permission" || pendingPayload.kind === "userInput")
      ? {
          interactionId: pending.interactionId,
          kind: pendingPayload.kind,
          ...(pendingToolName ? { toolName: pendingToolName } : {}),
          ...(pending.autoResolution ? { autoResolution: pending.autoResolution } : {}),
        }
      : undefined;
  return {
    sessionId: snapshot.sessionId,
    workspaceId: extra.workspaceId,
    ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}),
    title: snapshot.meta.title,
    titleSource: snapshot.meta.titleSource,
    phase: snapshot.control.phase,
    // Pass control.sessionEnded through unchanged (it becomes true after a successful turn settles and does not mean the session was deleted).
    sessionEnded: snapshot.control.sessionEnded,
    hasBackgroundWork,
    ...(workflowActivity === undefined ? {} : { workflowActivity }),
    ...(pendingInteraction ? { pendingInteraction } : {}),
    ...(permissionCount > 0 || userInputCount > 0
      ? {
          pendingInteractionSummary: {
            permissionCount,
            userInputCount,
          },
        }
      : {}),
    ...(snapshot.goal ? { goalStatus: snapshot.goal.status } : {}),
    lastActivityAt: extra.lastActivityAt,
    ...(lastAssistantPreview ? { lastAssistantPreview } : {}),
    createdAt: extra.createdAt,
  };
}

/** Whether two summaries are equivalent (conflation produces no delta when they are). */
function summariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.workspaceId === b.workspaceId &&
    a.parentSessionId === b.parentSessionId &&
    a.title === b.title &&
    a.titleSource === b.titleSource &&
    a.phase === b.phase &&
    a.sessionEnded === b.sessionEnded &&
    a.hasBackgroundWork === b.hasBackgroundWork &&
    // Conflation must never discard phase changes, settlement, or changes to running-subagent counts. Node-only changes compare equal here
    // (in the real system, advancing lastActivityAt still produces a frame; that reflects activity without changing these semantics).
    JSON.stringify(a.workflowActivity ?? null) === JSON.stringify(b.workflowActivity ?? null) &&
    JSON.stringify(a.pendingInteraction ?? null) === JSON.stringify(b.pendingInteraction ?? null) &&
    a.pendingInteractionSummary?.permissionCount === b.pendingInteractionSummary?.permissionCount &&
    a.pendingInteractionSummary?.userInputCount === b.pendingInteractionSummary?.userInputCount &&
    a.goalStatus === b.goalStatus &&
    a.lastActivityAt === b.lastActivityAt &&
    a.lastAssistantPreview === b.lastAssistantPreview &&
    a.createdAt === b.createdAt
  );
}

/**
 * Reducer state for one workspace's sessions-index: Map<sessionId, SessionSummary> +
 * upsert/remove delta generation (conflation key = sessionId).
 */
export class SessionsIndexProjection {
  private readonly summaries = new Map<string, SessionSummary>();

  constructor(
    readonly workspaceId: string,
    readonly logEpoch: string,
  ) {}

  /** Update a session summary from its latest snapshot; return an upsert delta if it changed, otherwise none. */
  upsertFromConversation(
    snapshot: ConversationSnapshot,
    extra: Omit<SessionSummaryDeriveExtra, "workspaceId">,
  ): SessionsIndexDelta[] {
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: this.workspaceId,
      ...extra,
    });
    const prev = this.summaries.get(summary.sessionId);
    // Guard against downgrade during the stored→live transition: before hydration fills in metadata, a cold-restored live projection may have an empty title and record times may have been reset by resume. Do not overwrite stable fields from the store seed with downgraded values (otherwise the sidebar appears to lose the original session and show a new task).
    if (prev) {
      // The sessions-index reader must distinguish the physical title in storage/protocol from an explicit user rename.
      // Before hydration completes, a cold-restored live projection may have only a default/generated title; if the old seed is already
      // custom, do not downgrade it to that automatic title or the sidebar will briefly revert the user's title to a generated one.
      if (prev.titleSource === "custom" && summary.titleSource !== "custom") {
        summary.title = prev.title;
        summary.titleSource = prev.titleSource;
      } else if (!summary.title && prev.title) {
        summary.title = prev.title;
        // The old store seed may omit titleSource; the cold projection's default is temporary. Preserve the field's absence when preserving the title,
        // or summariesEqual will emit an upsert frame with no user-visible change.
        if (prev.titleSource === undefined) {
          delete summary.titleSource;
        } else {
          summary.titleSource = prev.titleSource;
        }
      }
      if (prev.createdAt > 0 && summary.createdAt > prev.createdAt) {
        summary.createdAt = prev.createdAt;
      }
      if (!summary.lastAssistantPreview && prev.lastAssistantPreview) {
        summary.lastAssistantPreview = prev.lastAssistantPreview;
      }
      // Before hydration finishes, a cold-restored live projection has the initial draft phase.
      // A session with real content cannot return to draft; overwriting a non-draft baseline would broadcast a downgraded
      // `completedSuccess→draft` delta when opening a historical task, clear its UI row state, and refetch the whole workspace list
      // (making the task list appear to reload when a task is opened).
      // phase/sessionEnded/goalStatus share the same source and timing, so preserve them together.
      if (summary.phase === "draft" && prev.phase !== "draft") {
        summary.phase = prev.phase;
        summary.sessionEnded = prev.sessionEnded;
        if (summary.goalStatus === undefined && prev.goalStatus !== undefined) {
          summary.goalStatus = prev.goalStatus;
        }
      }
    }
    if (prev && summariesEqual(prev, summary)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

  /** Insert a summary directly (for cold-start/store sessions without a live projection). */
  seed(summary: SessionSummary): void {
    this.summaries.set(summary.sessionId, summary);
  }

  /**
   * Rereading a migrated store only fills in missing summaries; existing live/seed state must not be overwritten by cold-storage defaults.
   * Return a delta so the publisher can advance the sequence and notify list subscribers that are already online.
   */
  insertSeedIfMissing(summary: SessionSummary): SessionsIndexDelta[] {
    if (this.summaries.has(summary.sessionId)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

  /** Remove a session; return a remove delta if it existed. */
  remove(sessionId: string): SessionsIndexDelta[] {
    if (!this.summaries.has(sessionId)) return [];
    this.summaries.delete(sessionId);
    return [{ op: "session.removed", sessionId }];
  }

  has(sessionId: string): boolean {
    return this.summaries.has(sessionId);
  }

  /** Current full snapshot (sessions are unordered; sorting is client-side). */
  getSnapshot(): SessionsIndexSnapshot {
    return {
      protocolVersion: 1,
      workspaceId: this.workspaceId,
      logEpoch: this.logEpoch,
      sessions: [...this.summaries.values()],
    };
  }
}
