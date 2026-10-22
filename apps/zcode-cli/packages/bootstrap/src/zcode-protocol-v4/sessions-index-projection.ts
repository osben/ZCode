// sessions-index topic 的 CLI 侧归约：把一个 workspace 名下各会话的
// ConversationSnapshot 派生为 SessionSummary，并维护 conflated 最新态 + 产出 upsert/remove delta。
// 纯归约、无 IO；publisher（sessions-index-publisher）负责 seq 记账与帧构造，
// 事件订阅与 flush 调度归 gateway（v4-gateway）。
import {
  deriveSessionWorkflowActivity,
  type ConversationSnapshot,
  type SessionSummary,
  type SessionsIndexDelta,
  type SessionsIndexSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/** 派生一条 summary 需要的、快照之外的会话级元信息（来自 session-store record / 事件时刻）。 */
export interface SessionSummaryDeriveExtra {
  workspaceId: string;
  createdAt: number;
  lastActivityAt: number;
  lastOutcome?: SessionSummary["lastOutcome"];
  parentSessionId?: string;
  /** Execution worktree facts from the runtime; drives the sidebar badge and open-in-IDE target. */
  executionWorktree?: { path: string; branchName?: string };
  /**
   * Sidebar child-conversation facts (spec: sidebar-child-conversation-counts.md §3): true totals
   * from the store TTL cache plus the capped newest-first list; running flags come from the live
   * session registry without I/O. Absent when the session has no children.
   */
  sideChatCount?: number;
  subagentCount?: number;
  runningSubagentCount?: number;
  childSessions?: SessionSummary["childSessions"];
  /** True when the execution worktree directory was absent on disk at the meta source. */
  executionWorktreeMissing?: boolean;
  /** True for an incognito session (specs/incognito-session.md). */
  incognito?: boolean;
  /** Title recency: CLI time_title_updated, or time_created when the column is null. Absent when the live source cannot supply it. */
  titleUpdatedAt?: number;
}

const MAX_PREVIEW_CHARS = 120;

/** Keeps titleUpdatedAt absent unless a value is known, so a deleted field is never serialized as undefined. */
function setTitleUpdatedAt(summary: SessionSummary, titleUpdatedAt: number | undefined): void {
  if (titleUpdatedAt === undefined) delete summary.titleUpdatedAt;
  else summary.titleUpdatedAt = titleUpdatedAt;
}

/** 从 ConversationSnapshot + 会话元信息派生 SessionSummary（纯函数，golden 可测）。 */
export function deriveSessionSummary(
  snapshot: ConversationSnapshot,
  extra: SessionSummaryDeriveExtra,
): SessionSummary {
  // 最后一条 assistantText row 的文本作预览（≤120 字符）。
  let lastAssistantPreview: string | undefined;
  const lastOutcome = extra.lastOutcome;
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
  // 侧栏工作流运行行的数据：
  // 同一 snapshot 的 workflowRuns + backgroundWorks 派生，侧栏不必订阅 run 进度。
  const workflowActivity = deriveSessionWorkflowActivity({
    workflowRuns: snapshot.workflowRuns,
    backgroundWorks: snapshot.backgroundWorks,
  });
  // workspaceHookReview 由 Hooks Settings 呈现，不降级成 permission/userInput 侧栏徽标。
  const pending = snapshot.pendingInteractions.find(
    (interaction) => interaction.kind === "permission" || interaction.kind === "userInput",
  );
  const permissionCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "permission",
  ).length;
  const userInputCount = snapshot.pendingInteractions.filter(
    (interaction) => interaction.kind === "userInput",
  ).length;
  // 兼容恢复迁移或归约测试构造的裁剪快照：不能因新增轻量 toolName 投影，
  // 在旧 pending interaction 暂缺 payload 时阻断整个任务列表。
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
    ...(snapshot.meta.worktreePreparation
      ? { worktreePreparation: snapshot.meta.worktreePreparation }
      : {}),
    ...(snapshot.meta.submissionPreparation
      ? { submissionPreparation: snapshot.meta.submissionPreparation }
      : {}),
    sessionId: snapshot.sessionId,
    workspaceId: extra.workspaceId,
    ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}),
    title:
      snapshot.meta.title ||
      (snapshot.meta.worktreePreparation
        ? `Worktree ${snapshot.meta.worktreePreparation.branchName}`
        : ""),
    titleSource: snapshot.meta.titleSource,
    ...(extra.titleUpdatedAt !== undefined ? { titleUpdatedAt: extra.titleUpdatedAt } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
    phase: snapshot.control.phase,
    // 忠实透传 control.sessionEnded（语义：成功轮收口后即 true，不代表已删除）。
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
    ...(extra.executionWorktree ? { executionWorktree: extra.executionWorktree } : {}),
    ...(extra.sideChatCount ? { sideChatCount: extra.sideChatCount } : {}),
    ...(extra.subagentCount ? { subagentCount: extra.subagentCount } : {}),
    ...(extra.runningSubagentCount ? { runningSubagentCount: extra.runningSubagentCount } : {}),
    ...(extra.childSessions && extra.childSessions.length > 0
      ? { childSessions: extra.childSessions }
      : {}),
    ...(extra.executionWorktreeMissing ? { executionWorktreeMissing: true } : {}),
    ...(extra.incognito ? { incognito: true } : {}),
    createdAt: extra.createdAt,
  };
}

/** 两条 summary 是否等价（conflation：等价则不产 delta）。 */
function summariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.workspaceId === b.workspaceId &&
    a.parentSessionId === b.parentSessionId &&
    a.title === b.title &&
    a.titleSource === b.titleSource &&
    a.titleUpdatedAt === b.titleUpdatedAt &&
    a.lastOutcome === b.lastOutcome &&
    a.phase === b.phase &&
    a.submissionPreparation?.submissionId === b.submissionPreparation?.submissionId &&
    a.submissionPreparation?.status === b.submissionPreparation?.status &&
    a.worktreePreparation?.attemptId === b.worktreePreparation?.attemptId &&
    a.worktreePreparation?.status === b.worktreePreparation?.status &&
    a.worktreePreparation?.branchName === b.worktreePreparation?.branchName &&
    a.worktreePreparation?.targetPath === b.worktreePreparation?.targetPath &&
    a.worktreePreparation?.baseBranch === b.worktreePreparation?.baseBranch &&
    a.worktreePreparation?.failureMessage === b.worktreePreparation?.failureMessage &&
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
    // Field comparison instead of JSON.stringify: this equality check runs on every session event
    // fan-out, and the value is at most two scalar fields.
    a.executionWorktree?.path === b.executionWorktree?.path &&
    a.executionWorktree?.branchName === b.executionWorktree?.branchName &&
    // Child-conversation facts: normalize absent ≈ 0 the same way, and compare the capped list by
    // value so a counters-only or list-only change still emits a delta (acceptance #8).
    (a.sideChatCount ?? 0) === (b.sideChatCount ?? 0) &&
    (a.subagentCount ?? 0) === (b.subagentCount ?? 0) &&
    (a.runningSubagentCount ?? 0) === (b.runningSubagentCount ?? 0) &&
    JSON.stringify(a.childSessions ?? null) === JSON.stringify(b.childSessions ?? null) &&
    // Normalize absent ≈ false so a producer flipping between omitting the flag and false does not
    // emit a no-op delta, while a real health flip (false ↔ true) always produces one.
    (a.executionWorktreeMissing ?? false) === (b.executionWorktreeMissing ?? false) &&
    (a.incognito ?? false) === (b.incognito ?? false) &&
    a.createdAt === b.createdAt
  );
}

/**
 * 一个 workspace 的 sessions-index 归约态：Map<sessionId, SessionSummary> +
 * upsert/remove delta 生成（conflation key = sessionId）。
 */
export class SessionsIndexProjection {
  private readonly summaries = new Map<string, SessionSummary>();

  constructor(
    readonly workspaceId: string,
    readonly logEpoch: string,
  ) {}

  /** 用某会话的最新 snapshot 更新其 summary；变化则返回 upsert delta，否则空。 */
  upsertFromConversation(
    snapshot: ConversationSnapshot,
    extra: Omit<SessionSummaryDeriveExtra, "workspaceId">,
  ): SessionsIndexDelta[] {
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: this.workspaceId,
      ...extra,
    });
    const prev = this.summaries.get(summary.sessionId);
    // 降级防御（stored→live 切换窗口）：冷恢复的 live 投影在 hydration 补齐
    // meta 之前 title 为空、record 时间可能被 resume 重置——store 种子里的
    // 稳定字段不得被降级值覆盖（否则侧栏表现为"原会话消失、冒出新任务"）。
    if (prev) {
      // sessions-index 读侧要区分“存储/协议物理标题”和“用户显式重命名”。
      // 冷恢复 live 投影在 hydration 补齐前可能只有 default/generated 标题；旧 seed 若已是
      // custom，不得被这类自动标题降级，否则侧边栏会把用户手动标题闪回生成标题。
      // titleUpdatedAt always moves with the title it describes: when the title is kept from prev, its recency is kept too.
      if (prev.titleSource === "custom" && summary.titleSource !== "custom") {
        summary.title = prev.title;
        summary.titleSource = prev.titleSource;
        setTitleUpdatedAt(summary, prev.titleUpdatedAt);
      } else if (!summary.title && prev.title) {
        summary.title = prev.title;
        setTitleUpdatedAt(summary, prev.titleUpdatedAt);
        // 旧 store seed 的 titleSource 可缺省；冷投影的
        // default 只是暂态值。保住标题时也要保住“字段缺省”，否则
        // summariesEqual 会产生一帧无产品变化的 upsert。
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
      // 冷恢复的 live 投影在 hydration 完成前 phase 是初始 draft。
      // 会话一旦有过真实内容就不可能退回 draft；若用它覆盖非 draft 基线，
      // 打开一个历史任务就会广播一帧「completedSuccess→draft」纯降级 delta，
      // UI 列表行状态被清空、对应 workspace 列表整体重查（表现为"点开任务列表重新加载"）。
      // phase/sessionEnded/goalStatus 同窗口同源，一并保基线。
      if (summary.phase === "draft" && prev.phase !== "draft") {
        summary.phase = prev.phase;
        summary.sessionEnded = prev.sessionEnded;
        if (summary.goalStatus === undefined && prev.goalStatus !== undefined) {
          summary.goalStatus = prev.goalStatus;
        }
      }
    }
    // Same title and no supplied value: the previous recency still describes this title.
    if (
      prev &&
      summary.titleUpdatedAt === undefined &&
      prev.titleUpdatedAt !== undefined &&
      summary.title === prev.title
    ) {
      setTitleUpdatedAt(summary, prev.titleUpdatedAt);
    }
    if (prev && summariesEqual(prev, summary)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

  /** 直接放入一条 summary（冷启动/无 live projection 的 store 会话）。 */
  seed(summary: SessionSummary): void {
    this.summaries.set(summary.sessionId, summary);
  }

  /**
   * 兼容迁移后的 store 重读只补齐缺失摘要；已有 live/seed 状态不能被冷存储默认态覆盖。
   * 返回 delta 供 publisher 推进 seq，并通知已经在线的列表订阅者。
   */
  insertSeedIfMissing(summary: SessionSummary): SessionsIndexDelta[] {
    if (this.summaries.has(summary.sessionId)) return [];
    this.summaries.set(summary.sessionId, summary);
    return [{ op: "session.upserted", session: summary }];
  }

  /** Update child facts on an existing cold or live row without changing activity or starting a conversation runtime. */
  updateChildFacts(
    sessionId: string,
    facts: Pick<
      SessionSummary,
      "sideChatCount" | "subagentCount" | "runningSubagentCount" | "childSessions"
    >,
  ): SessionsIndexDelta[] {
    const prev = this.summaries.get(sessionId);
    if (!prev) return [];
    const next = { ...prev };
    delete next.sideChatCount;
    delete next.subagentCount;
    delete next.runningSubagentCount;
    delete next.childSessions;
    if (facts.sideChatCount) next.sideChatCount = facts.sideChatCount;
    if (facts.subagentCount) next.subagentCount = facts.subagentCount;
    if (facts.runningSubagentCount) next.runningSubagentCount = facts.runningSubagentCount;
    if (facts.childSessions?.length) next.childSessions = facts.childSessions;
    if (summariesEqual(prev, next)) return [];
    this.summaries.set(sessionId, next);
    return [{ op: "session.upserted", session: next }];
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

  /** 当前全量快照（sessions 无序，排序是客户端逻辑）。 */
  getSnapshot(): SessionsIndexSnapshot {
    return {
      protocolVersion: 1,
      workspaceId: this.workspaceId,
      logEpoch: this.logEpoch,
      sessions: [...this.summaries.values()],
    };
  }
}
