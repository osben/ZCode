/* eslint-disable max-lines -- zcodeSessionService groups desktop-continuous session operations, draft lifecycle, and task-index synchronization boundaries; splitting it requires separate design. */
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "#src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createSessionTraceId,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type {
  IZCodeSessionService,
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionReadWorkspacePresentationParams,
  ZCodeSessionResumeParams,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "#src/zcode-session/zcodeSession.js";
import { formatModelPickerValue } from "#src/zcode-agent/zcodeConfigOptions.js";
import { createZCodeSessionApiRetryRuntimeTracker } from "#src/zcode-session/zcodeSessionApiRetry.js";
import { appendWorkspaceToFilesystemMcpServers } from "#src/session/mcpWorkspaceScope.js";
import { repairEmptyImportedClaudeSessionSnapshot } from "#src/zcode-session/importedClaudeSessionRepair.js";
import { createZCodeDeferredDraftRegistry } from "#src/zcode-session/zcodeSessionDraftRegistry.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";

const logger = createServiceLogger("zcode-session-service");

interface CreateZCodeSessionServiceOptions {
  agentService: IZCodeAgentService;
  /**
   * Background task-index SQLite synchronizer. When injected, it is notified whenever a session is created/restored, a prompt is sent, or
   * events are subscribed to, so it can maintain shadow subscriptions and keep SQLite aligned with runtime state in the desktop-continuous path.
   * It also syncs the latest snapshot to SQLite and broadcasts workspace_task_list_changed after every session-state-changing operation,
   * so the sidebar immediately reflects the first_input title and updatedAt ordering.
   */
  taskIndexSyncer?: ZCodeTaskIndexSyncer;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

export function createZCodeSessionService({
  agentService,
  taskIndexSyncer,
  cuaProductMcpServerResolver,
}: CreateZCodeSessionServiceOptions): IZCodeSessionService {
  const { withApiRetryRuntime } = createZCodeSessionApiRetryRuntimeTracker();
  const deferredDraftSessions = createZCodeDeferredDraftRegistry();

  function notifySyncer(
    target: ZCodeTaskTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void {
    if (!taskIndexSyncer) {
      return;
    }
    taskIndexSyncer.ensureSessionSubscription(
      {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.sessionId,
      },
      options,
    );
  }

  function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
    // Logging diagnostics must not assume that test mocks or future partial snapshots always include messages/pendingRequestIds.
    // readSession's business result has already been validated by the agent layer, and the service records only observation fields; a logging error would otherwise interrupt
    // desktop-continuous snapshot recovery. Count missing diagnostic values as empty arrays without modifying the snapshot returned to the UI.
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const pendingRequestIds = Array.isArray(snapshot.runtime.pendingRequestIds)
      ? snapshot.runtime.pendingRequestIds
      : [];
    return {
      activeTurnId: snapshot.runtime.activeTurnId ?? null,
      eventSeq: snapshot.runtime.eventSeq,
      messageCount: messages.length,
      pendingRequestCount: pendingRequestIds.length,
      sessionStatus: snapshot.session.status,
      stateRevision: snapshot.runtime.stateRevision,
    };
  }

  function readSnapshotAvailableThoughtLevels(
    snapshot: ZCodeSessionStateSnapshot,
  ): Set<string> | null {
    const thoughtLevel = snapshot.settings.thoughtLevel;
    if (!thoughtLevel.enabled) {
      return new Set();
    }
    const available = Array.isArray(thoughtLevel.available)
      ? (thoughtLevel.available as readonly unknown[])
      : [];
    if (available.length === 0) {
      return null;
    }
    const values = available
      .map((option) => {
        if (typeof option === "string") {
          return option.trim();
        }
        if (typeof option === "object" && option !== null && "value" in option) {
          const value = (option as { value?: unknown }).value;
          return typeof value === "string" ? value.trim() : "";
        }
        return "";
      })
      .filter((value) => value.length > 0);
    return values.length > 0 ? new Set(values) : null;
  }

  function canReplayThoughtLevelFromResumeSnapshot(params: {
    snapshot: ZCodeSessionStateSnapshot;
    thoughtLevel: string;
  }): boolean {
    const availableThoughtLevels = readSnapshotAvailableThoughtLevels(params.snapshot);
    return availableThoughtLevels === null || availableThoughtLevels.has(params.thoughtLevel);
  }

  // zcodeSessionService is the desktop-continuous main path and must broadcast a snapshot after state changes;
  // otherwise SQLite remains at the "New session" written by createSession and the sidebar never receives
  // workspace_task_list_changed. Legacy write paths (send/steer/fork/compact/rewind pass-through) have been removed;
  // only lifecycle/configuration operations such as createSession/resumeSession/setModel call this method.
  async function broadcastSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    tag: string,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      /** Design correction: required; the emission site must declare the change category. */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<void> {
    if (!taskIndexSyncer) {
      return;
    }
    try {
      // Diagnostic log (the left list refreshes with input-box operations): identify which lifecycle op (setModel/createSession/resumeSession) triggered the snapshot broadcast.
      logger.debug(
        undefined,
        `[list-refresh-trace] broadcastSnapshot tag=${tag} taskId=${snapshot.session.sessionId}`,
      );
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, options);
    } catch (error) {
      logger.warn(
        undefined,
        `[zcode-session-service] ${tag} syncSnapshotAndBroadcast 失败 taskId=${snapshot.session.sessionId}`,
        error,
      );
    }
  }

  async function repairEmptyImportedClaudeSession(
    snapshot: ZCodeSessionStateSnapshot,
    params: ZCodeSessionResumeParams | ZCodeSessionReadParams,
  ): Promise<ZCodeSessionStateSnapshot> {
    return withApiRetryRuntime(
      await repairEmptyImportedClaudeSessionSnapshot({
        agentService,
        snapshot,
        target: params,
      }),
    );
  }

  async function withResolvedMcpServers<
    T extends ZCodeSessionCreateParams | ZCodeSessionResumeParams,
  >(params: T): Promise<T> {
    const mcpServers = appendWorkspaceToFilesystemMcpServers(
      params.mcpServers,
      params.workspacePath,
    );
    const resolvedMcpServers = cuaProductMcpServerResolver
      ? await cuaProductMcpServerResolver.resolveMcpServers(mcpServers, {
          workspacePath: params.workspacePath,
        })
      : mcpServers;
    if (resolvedMcpServers === params.mcpServers) {
      return params;
    }
    // The desktop-continuous session path bypasses the legacy task adapter and previously skipped
    // workspace injection for filesystem MCP, so the same MCP lacked current-project authorization on direct session startup.
    // Change only the temporary parameters sent to runtime; do not write user config and contaminate MCP settings across workspaces.
    // Product CUA broker socket/token are likewise injected only into runtime parameters.
    return { ...params, mcpServers: resolvedMcpServers };
  }

  return {
    async initializeWorkspace(params: ZCodeSessionWorkspaceTarget) {
      const result = await agentService.initialize(params);
      // V4 task-index ingestion (sessions-index/workspace-config) is a persistent workspace-level subscription.
      // V4 command paths (createSession/sendText through v4/command) no longer pass through this service's session operations;
      // establish the subscription during workspace prewarming, or terminal state/title/config catalogs from pure V4 sessions will never reach SQLite or workspace broadcasts.
      if (result.available && taskIndexSyncer) {
        taskIndexSyncer.ensureWorkspaceSubscription({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
      }
      return result;
    },

    getWorkspaceRuntimeIdentity(params: ZCodeSessionWorkspaceTarget) {
      return agentService.getWorkspaceRuntimeIdentity(params);
    },

    readWorkspacePresentation(params: ZCodeSessionReadWorkspacePresentationParams) {
      return agentService.readWorkspacePresentation(params);
    },

    async createSession(params: ZCodeSessionCreateParams) {
      const startedAt = Date.now();
      const sessionTraceId = params.sessionTraceId ?? createSessionTraceId();
      const agentParams = await withResolvedMcpServers({ ...params, sessionTraceId });
      logger.info(sessionTraceId, "[zcode-session-service] createSession 分配 session trace", {
        persistence: agentParams.persistence,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      const snapshot = await agentService.createSession(agentParams);
      logger.info(sessionTraceId, "[zcode-session-service] createSession agent 返回", {
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        persistence: agentParams.persistence,
        snapshotTraceId: snapshot.session.traceId ?? null,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      if (agentParams.persistence === "deferred") {
        // A draft session before the first send lets the toolbar and agent runtime share the same state.
        // Do not add an empty session like this to the app task-index SQLite, or the sidebar/search will show a session with no user input.
        // Track this draft so later state changes such as setModel are also kept out of the task index.
        deferredDraftSessions.remember(agentParams, snapshot);
        return snapshot;
      }
      // The desktop-continuous path bypasses the ZCode task adapter, so SQLite's task index depends entirely on
      // the syncer's shadow subscription. Ensure it immediately after createSession succeeds, before the first runtime event arrives.
      notifySyncer({
        workspacePath: snapshot.session.workspace.workspacePath,
        workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
        sessionId: snapshot.session.sessionId,
      });
      // Sync the initial snapshot to SQLite and broadcast immediately so the UI list sees the new session row right away.
      // The initial desktop-continuous send bypasses legacy createTask, so grouped top-level ordering must be written here.
      const snapshotWithRuntime = withApiRetryRuntime(snapshot);
      const broadcastStartedAt = Date.now();
      await broadcastSnapshot(snapshotWithRuntime, "createSession", {
        moveGroupedTaskToTop: true,
        // The first-send broadcast retains the legacy task_meta_changed semantics (low frequency, once per task);
        // changing it to task_created (insert-active) also requires changing optimistic-insert deduplication.
        broadcastReason: "task_meta_changed",
      });
      logger.info(sessionTraceId, "[zcode-session-service] createSession task index 同步完成", {
        broadcastDurationMs: Date.now() - broadcastStartedAt,
        durationMs: Date.now() - startedAt,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: params.workspaceIdentity,
        workspacePath: params.workspacePath,
      });
      return snapshotWithRuntime;
    },

    async resumeSession(params: ZCodeSessionResumeParams) {
      const startedAt = Date.now();
      const { broadcastSnapshot: shouldBroadcastSnapshot = true, ...resumeParams } = params;
      const agentParams = await withResolvedMcpServers(resumeParams);
      let snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.resumeSession(agentParams)),
        agentParams,
      );
      const requestedThoughtLevelOverride = agentParams.thoughtLevel?.trim();
      let thoughtLevelOverride = requestedThoughtLevelOverride;
      if (
        requestedThoughtLevelOverride &&
        snapshot.settings.thoughtLevel.current !== requestedThoughtLevelOverride
      ) {
        if (
          !canReplayThoughtLevelFromResumeSnapshot({
            snapshot,
            thoughtLevel: requestedThoughtLevelOverride,
          })
        ) {
          // When restoring a historical task, the model has already switched back to its task-local model, but the old task config
          // may still carry the previous model's thoughtLevel (for example, GLM-5-Turbo with max).
          // snapshot.settings.thoughtLevel.available is the source of truth for current model capabilities; do not replay unsupported values to the agent.
          thoughtLevelOverride = undefined;
          logger.warn(
            undefined,
            "[zcode-session-service] resumeSession 跳过不支持的 task 思考强度",
            {
              availableThoughtLevels: Array.from(
                readSnapshotAvailableThoughtLevels(snapshot) ?? [],
              ),
              requestedThoughtLevel: requestedThoughtLevelOverride,
              sessionId: agentParams.sessionId,
              snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
              workspaceIdentity: agentParams.workspaceIdentity ?? null,
              workspacePath: agentParams.workspacePath,
            },
          );
        }
      }
      if (thoughtLevelOverride && snapshot.settings.thoughtLevel.current !== thoughtLevelOverride) {
        logger.info(undefined, "[zcode-session-service] resumeSession 重放 task 思考强度", {
          requestedThoughtLevel: thoughtLevelOverride,
          sessionId: agentParams.sessionId,
          snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
          workspaceIdentity: agentParams.workspaceIdentity ?? null,
          workspacePath: agentParams.workspacePath,
        });
        // When opening a historical task, the resume snapshot may still contain the latest thought level from a draft in the same workspace.
        // Explicitly replay the task-local thoughtLevel for this session and broadcast the corrected snapshot;
        // otherwise syncer/UI could write the draft's high value back to an active task that was set to max.
        snapshot = await repairEmptyImportedClaudeSession(
          withApiRetryRuntime(
            await agentService.setThoughtLevel({
              workspacePath: agentParams.workspacePath,
              workspaceIdentity: agentParams.workspaceIdentity,
              sessionId: agentParams.sessionId,
              thoughtLevel: thoughtLevelOverride,
            }),
          ),
          agentParams,
        );
      }
      const agentDurationMs = Date.now() - startedAt;
      notifySyncer(agentParams, { includeSnapshot: shouldBroadcastSnapshot });
      const broadcastStartedAt = Date.now();
      const modelOverride = agentParams.model
        ? formatModelPickerValue(agentParams.model)
        : undefined;
      const syncOptions =
        modelOverride || thoughtLevelOverride
          ? {
              ...(modelOverride ? { modelOverride } : {}),
              ...(thoughtLevelOverride ? { thoughtLevelOverride } : {}),
            }
          : undefined;
      if (shouldBroadcastSnapshot) {
        // Opening/restoring a task reconciles its snapshot without changing pin/archive/unread ownership;
        // defaulting to task_meta_changed would trigger a global membership reload every time a task is opened.
        await broadcastSnapshot(snapshot, "resumeSession", {
          ...syncOptions,
          broadcastReason: "task_status_changed",
        });
      } else if (modelOverride && taskIndexSyncer) {
        await taskIndexSyncer.syncTaskModel(
          {
            workspacePath: agentParams.workspacePath,
            workspaceIdentity: agentParams.workspaceIdentity,
            sessionId: agentParams.sessionId,
          },
          modelOverride,
        );
      }
      logger.info(undefined, "[zcode-session-service] resumeSession 历史恢复完成", {
        agentDurationMs,
        broadcastDurationMs: shouldBroadcastSnapshot ? Date.now() - broadcastStartedAt : 0,
        broadcastSnapshot: shouldBroadcastSnapshot,
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        sessionId: agentParams.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: agentParams.workspaceIdentity ?? null,
        workspacePath: agentParams.workspacePath,
      });
      return snapshot;
    },

    listSessions(params: ZCodeSessionListParams) {
      return agentService.listSessions(params);
    },

    async readSession(params: ZCodeSessionReadParams) {
      const startedAt = Date.now();
      const snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.readSession(params)),
        params,
      );
      logger.info(undefined, "[zcode-session-service] readSession 历史快照读取完成", {
        deliveryKind: params.deliveryKind,
        durationMs: Date.now() - startedAt,
        messageLimit: params.messageLimit ?? null,
        sessionId: params.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return snapshot;
    },

    readSessionMessages(params: ZCodeSessionMessagesParams) {
      return agentService.readSessionMessages(params);
    },

    readSessionEvents(params: ZCodeSessionEventsParams) {
      return agentService.readSessionEvents(params);
    },

    promoteDeferredDraftSession(params: ZCodeTaskTarget) {
      const wasDeferredDraft = deferredDraftSessions.has(params);
      deferredDraftSessions.forget(params);
      if (!wasDeferredDraft) {
        return Promise.resolve();
      }
      // The mobile replayable first send consumes the deferred draft through the task facade. Clear the draft marker here
      // and notify task-index sync so later desktop control of the same task does not keep skipping sync under deferred rules.
      notifySyncer(params);
      logger.info(undefined, "[zcode-session-service] deferred draft session 已提升为 task", {
        sessionId: params.sessionId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return Promise.resolve();
    },

    closeSession(params: ZCodeTaskTarget) {
      deferredDraftSessions.forget(params);
      return agentService.closeSession(params).then(() => undefined);
    },

    async closeDeferredDraftSession(params: ZCodeTaskTarget) {
      try {
        const closed = await agentService.closeSession({
          ...params,
          expectedPersistence: "deferred",
        });
        if (closed) {
          deferredDraftSessions.forget(params);
        }
        return closed;
      } catch (error) {
        // Older Agents reject expectedPersistence. The safe fallback is to retain the old session and create a new draft;
        // do not fall back to unconditional close, which could close an active task just promoted by another client.
        logger.warn(
          undefined,
          "[zcode-session-service] 条件关闭 deferred draft 失败，保留旧 session",
          {
            error: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspacePath: params.workspacePath,
          },
        );
        return false;
      }
    },

    async setModel(params: ZCodeSessionSetModelParams) {
      const isDeferredDraft = deferredDraftSessions.has(params);
      if (!isDeferredDraft) {
        notifySyncer(params);
      }
      const snapshot = withApiRetryRuntime(await agentService.setModel(params));
      if (isDeferredDraft) {
        // A deferred draft exists only in runtime memory, and setModel returns an empty snapshot with no messages.
        // If it is subscribed/written to the task index here, restarting the process leaves a dirty "Session not found" session that cannot resume.
        return snapshot;
      }
      await broadcastSnapshot(snapshot, "setModel", {
        modelOverride: formatModelPickerValue(params.model),
        // Changing models is a configuration-only update, so broadcast task_model_changed.
        // It previously fell through to the default task_meta_changed, causing the UI to treat it as an ownership change
        // and reload global membership plus every left-side list.
        broadcastReason: "task_model_changed",
      });
      return snapshot;
    },

    async setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams) {
      return withApiRetryRuntime(await agentService.setThoughtLevel(params));
    },

    async setMode(params: ZCodeSessionSetModeParams) {
      return withApiRetryRuntime(await agentService.setMode(params));
    },

    // onDynamicSessionEvent (the old Renderer session/subscribe surface) has been removed.
    // V4 UI session events use agentService's conversation frame channel; this service no longer subscribes to
    // agentService.onDynamicSessionEvent.
  };
}
