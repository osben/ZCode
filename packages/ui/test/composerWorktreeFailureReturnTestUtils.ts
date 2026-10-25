import { vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  armWorktreeSendContinuation,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  getV4WorktreeRecoveryScope,
  persistV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";

export function createMockServices(options?: {
  cancelRejected?: boolean;
  deleteRejected?: boolean;
  /** Runs after the Host acknowledges the cancellation, before the tombstone is requested. */
  onCancelAccepted?: () => void;
  /** Runs while the tombstone request is in flight (before it resolves). */
  onDeleteTaskStarted?: () => void;
}) {
  const commands: Array<Record<string, unknown>> = [];
  const deleteTask = vi.fn(async () => {
    options?.onDeleteTaskStarted?.();
    if (options?.deleteRejected) throw new Error("task deletion failed");
  });
  const services = {
    zcodeAgentService: {
      helloConversationV4: vi.fn(async () => ({
        kind: "hello",
        protocolVersion: 3,
        connectionId: "test-connection",
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: 1,
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      })),
      initializeConversationV4: vi.fn(async () => undefined),
      sendConversationCommandV4: vi.fn(
        async ({ envelope }: { envelope: Record<string, unknown> }) => {
          commands.push(envelope as Record<string, unknown>);
          const payload = envelope.payload as Record<string, unknown> | undefined;
          if (options?.cancelRejected && payload?.status === "cancelled") {
            return { status: "rejected", reasonCode: "guard.worktreePreparationStale" };
          }
          if (payload?.status === "cancelled") options?.onCancelAccepted?.();
          return { status: "accepted" };
        },
      ),
    },
    zcodeTaskService: { deleteTask },
  };
  return { services: services as unknown as IServiceAccessor, commands, deleteTask };
}

export interface SeedOptions {
  workspacePath: string;
  sessionId: string;
  submissionId: string;
  attemptId: string;
  recordText?: string;
  planEnabled?: boolean;
  withContinuation?: boolean;
  mainDraftText?: string;
  activeTaskOnSession?: boolean;
}

export function seedFailure(options: SeedOptions) {
  const workspaceKey = options.workspacePath;
  const params = {
    submissionId: options.submissionId,
    attemptId: options.attemptId,
    workspacePath: options.workspacePath,
    branchName: "feature-branch",
    targetPath: "/tmp/worktrees/feature-branch",
    baseBranch: "main",
    baseFromHeadDefault: false,
  };
  useComposerWorktreePipelineStore.setState({
    pipelineByWorkspaceKey: {
      [workspaceKey]: {
        activeSessionKey: options.sessionId,
        entriesBySessionKey: {
          [options.sessionId]: {
            status: "failed",
            attemptId: options.attemptId,
            sessionId: options.sessionId,
            params,
            createdAt: Date.now(),
            failureMessage: "Could not create the worktree",
          },
        },
      },
    },
  });
  persistV4ComposerDraft(
    options.workspacePath,
    undefined,
    getV4WorktreeRecoveryScope(options.sessionId, options.submissionId),
    {
      text: options.recordText ?? "frozen submission text",
      ...(options.planEnabled === false ? {} : { mode: "build", planEnabled: true }),
      recoveryAttachments: [
        {
          id: "att-1",
          filename: "paste-1.txt",
          localPath: "/tmp/paste-attachments/paste-1.txt",
          mimeType: "text/plain",
          sizeBytes: 20480,
          sourceKind: "clipboard-text" as const,
        },
      ],
    },
  );
  if (options.mainDraftText !== undefined) {
    persistV4ComposerDraft(options.workspacePath, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: options.mainDraftText,
    });
  }
  if (options.withContinuation !== false) {
    armWorktreeSendContinuation({
      workspaceKey,
      preparedSessionId: options.sessionId,
      attemptId: options.attemptId,
      hasBoundPreparedSession: true,
      dispatch: vi.fn(),
      restore: vi.fn(),
      restoreForRetry: vi.fn(),
    });
  }
  if (options.activeTaskOnSession !== false) {
    useZCodeSessionStore.getState().setActiveTaskId(options.workspacePath, options.sessionId);
  }
  return { params };
}
