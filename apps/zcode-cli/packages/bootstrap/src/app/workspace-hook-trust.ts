import { createDefaultFileWorkspaceHookTrustStore } from "@zcode/adapters/storage";
import {
  InMemoryWorkspaceHookPolicyProvider,
  WorkspaceHookTrustCoordinator,
  createWorkspaceHookRuntimeAdmission,
  emitWorkspaceHookTelemetry,
  type WorkspaceHookAdmissionState,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookPolicyProvider,
} from "@zcode/core";
import { SessionEventType } from "@zcode/contracts";
import type {
  Logger,
  SessionId,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookPolicy,
  WorkspaceHookAdmissionUpdatedPayload,
} from "@zcode/contracts";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookRuntimeRoot } from "@zcode/shared/workspace-hook-discovery";
import {
  WorkspaceHookReviewController,
  type WorkspaceHookReviewCommandResult,
  type WorkspaceHookReviewHostPort,
  type WorkspaceHookReviewLifecycleEvent,
} from "./workspace-hook-review-controller.js";
import { createWorkspaceHookReviewMutationPort } from "./workspace-hook-review-mutation.js";
import type { WorkspaceHookReviewHostContext } from "./types.js";

interface WorkspaceHookRuntimeSecurity {
  admission: WorkspaceHookRuntimeAdmissionPort;
  snapshot: WorkspaceHookBundleSnapshot;
  /**
   * The Trust store is a file, while the coordinator's persistentRecords is a per-session in-memory
   * mirror loaded only once when the session is created. Settings inline trust (the pretrust path
   * without a task) writes the file and returns, leaving the running session's coordinator unchanged
   * and its revision untouched. Trusted Hooks then remain rejected and banner pendingCount stays
   * stale. After successful pretrust authorization, this method must reload the file into this
   * session's coordinator and re-emit admission state, matching the task-scoped respond path.
   */
  reloadTrust(): Promise<void>;
/** Soft gate: start a review flow on demand; safely do nothing when there are no pending items. */
  requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  >;
  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult>;
  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult>;
}

export function createWorkspaceHookRuntimeSecurity(input: {
  appVersion?: string;
  emitAdmissionEvent?: (event: {
    type: typeof SessionEventType.WorkspaceHookAdmissionUpdated;
    payload: WorkspaceHookAdmissionUpdatedPayload;
  }) => Promise<void>;
  emitReviewEvent?: (event: WorkspaceHookReviewLifecycleEvent) => Promise<void>;
  logger: Logger;
  projectConfigPath?: string;
  policy?: WorkspaceHookPolicy;
  policyProvider?: WorkspaceHookPolicyProvider;
  reviewHost?: WorkspaceHookReviewHostContext;
  workspaceHookTrustEnabled?: boolean;
  runtimeRoot: WorkspaceHookRuntimeRoot;
  sessionId: SessionId;
  snapshot?: WorkspaceHookBundleSnapshot;
  userConfigPath: string;
  workingDirectory: string;
/** Tests inject a temporary HOME; production omits it, and the Trust store uses the real ~/.zcode/security path. */
  homeDir?: string;
}): WorkspaceHookRuntimeSecurity | undefined {
  if (!input.snapshot) return undefined;
  const policyProvider =
    input.policyProvider ?? new InMemoryWorkspaceHookPolicyProvider(input.policy);
  const coordinator = new WorkspaceHookTrustCoordinator({
    coordinatorEpoch: crypto.randomUUID(),
    policyProvider,
  });
  // When rollout is disabled, preserve the old hard block and do not read the existing Trust store.
  // Keep the Trust file so the user's choices are reused if the feature is enabled again later.
  const trustEnabled = input.workspaceHookTrustEnabled === true;
  const store = trustEnabled
    ? createDefaultFileWorkspaceHookTrustStore({
        userConfigPath: input.userConfigPath,
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      })
    : undefined;
  const ready = trustEnabled
    ? loadWorkspaceHookTrustStore({
        coordinator,
        logger: input.logger,
        store: store as NonNullable<typeof store>,
      })
    : Promise.resolve();
  let controller: WorkspaceHookReviewController | undefined;
  // Soft gate: onAdmissionStateChanged -> emit the WorkspaceHookAdmissionUpdated session event.
  // Called after activate() finishes evaluation and after replaceSnapshot, so the projection can write the snapshot fields.
  const onAdmissionStateChanged: ((state: WorkspaceHookAdmissionState) => void) | undefined =
    input.emitAdmissionEvent
      ? (state) => {
          void input.emitAdmissionEvent!({
            type: SessionEventType.WorkspaceHookAdmissionUpdated,
            payload: {
              pendingCount: state.pendingCount,
              bundleDigest: state.bundleDigest,
              ...(state.workspaceIdentity ? { workspaceIdentity: state.workspaceIdentity } : {}),
            },
          }).catch((error: unknown) => {
            input.logger.warn("Failed to emit WorkspaceHookAdmissionUpdated", {
              errorType: error instanceof Error ? error.name : typeof error,
              event: "workspace_hook.admission_event_emit_failed",
              module: "bootstrap.workspace_hook_trust",
            });
          });
        }
      : undefined;
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    enabled: trustEnabled,
    logger: input.logger,
    ready,
    ...(onAdmissionStateChanged ? { onAdmissionStateChanged } : {}),
    snapshot: input.snapshot,
  });

  if (trustEnabled && input.reviewHost && input.emitReviewEvent) {
    const host: WorkspaceHookReviewHostPort = {
      ...input.reviewHost,
      emit: input.emitReviewEvent,
    };
    controller = new WorkspaceHookReviewController({
      admission,
      appVersion: input.appVersion,
      coordinator,
      host,
      logger: input.logger,
      mutation: createWorkspaceHookReviewMutationPort({
        workingDirectory: input.workingDirectory,
        workspaceIdentity: input.snapshot.workspaceIdentity,
        projectConfigPath: input.projectConfigPath,
        runtimeRoot: input.runtimeRoot,
      }),
      sessionId: input.sessionId,
      store: store as NonNullable<typeof store>,
    });
  }

  const unavailable = (): WorkspaceHookReviewCommandResult => ({
    accepted: false,
    reasonCode: trustEnabled
      ? "workspace_hooks_require_trust_capable_host"
      : "workspace_hooks_feature_disabled",
  });
  return {
    admission,
    snapshot: input.snapshot,
    reloadTrust: async () => {
      if (!trustEnabled || !store) return;
      await loadWorkspaceHookTrustStore({ coordinator, logger: input.logger, store });
      // replacePersistentTrustRecords already bumped the revision and cleared the evaluation cache.
      // activate is idempotent (skips waiting for ready), reevaluates, and re-emits admission state
      // (including when pendingCount === 0, to clear the banner).
      await admission.activate("resume");
    },
    requestReview: (target) =>
      controller ? controller.requestReview(target) : Promise.resolve(unavailable()),
    respond: (target, decision) =>
      controller ? controller.respond(target, decision) : Promise.resolve(unavailable()),
    toggle: (target, reviewItemId, enabled) =>
      controller
        ? controller.toggle(target, reviewItemId, enabled)
        : Promise.resolve(unavailable()),
    revoke: (target, reviewItemIds) =>
      controller ? controller.revoke(target, reviewItemIds) : Promise.resolve(unavailable()),
    revokeCurrent: (target) =>
      controller ? controller.revokeCurrent(target) : Promise.resolve(unavailable()),
  };
}

async function loadWorkspaceHookTrustStore(input: {
  coordinator: WorkspaceHookTrustCoordinator;
  logger: Logger;
  store: ReturnType<typeof createDefaultFileWorkspaceHookTrustStore>;
}): Promise<void> {
  try {
    const loaded = await (await input.store).load();
    input.coordinator.replacePersistentTrustRecords(loaded.records, {
      status: loaded.status,
      ...(loaded.status === "corrupt" ? { recoveredCorruptPath: loaded.recoveredCorruptPath } : {}),
    });
  } catch (error) {
    input.coordinator.replacePersistentTrustRecords([], { status: "corrupt" });
    emitWorkspaceHookTelemetry(input.logger, "workspace_hook.trust_store_failure", {
      reasonCode: "workspace_hooks_trust_store_corrupt",
    });
    input.logger.warn("Workspace Hook Trust store bootstrap failed closed", {
      errorType: error instanceof Error ? error.name : typeof error,
      event: "workspace_hook.trust_store.bootstrap_failed",
      module: "bootstrap.workspace_hook_trust",
      reasonCode: "workspace_hooks_trust_store_corrupt",
      status: "completed",
    });
  }
}
