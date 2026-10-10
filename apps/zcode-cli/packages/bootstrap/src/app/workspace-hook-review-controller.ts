import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
} from "@zcode/contracts";
import {
  WorkspaceHookReviewFlowRegistry,
  createWorkspaceHookTrustRecords,
  type WorkspaceHookReviewFlow,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookSnapshotEvaluation,
  type WorkspaceHookTrustCoordinator,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import { WorkspaceHookMutationError } from "@zcode/shared/workspace-hook-mutation";

export type * from "./workspace-hook-review-types.js";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookReviewControllerOptions,
  WorkspaceHookReviewHostPort,
  WorkspaceHookReviewMutationPort,
  WorkspaceHookTrustStoreMutationPort,
} from "./workspace-hook-review-types.js";
import {
  buildWorkspaceHookReviewRequest,
  resolveWorkspaceHookReviewDigests,
  toWorkspaceHookReviewTarget,
} from "./workspace-hook-review-request.js";
import { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";
import { superviseWorkspaceHookReviewFlow } from "./workspace-hook-review-supervisor.js";
import { applyWorkspaceHookRevoke } from "./workspace-hook-review-revoke.js";

export class WorkspaceHookReviewController {
  private readonly admission: WorkspaceHookRuntimeAdmissionPort;
  private readonly appVersion?: string;
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly host: WorkspaceHookReviewHostPort;
  private readonly telemetry: WorkspaceHookReviewTelemetry;
  private readonly mutation: WorkspaceHookReviewMutationPort;
  private readonly sessionId: string;
  private readonly store: Promise<WorkspaceHookTrustStoreMutationPort>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly registry = new WorkspaceHookReviewFlowRegistry();
  /** Flow -> supervisor promise. WeakMap removes the entry automatically when the flow is collected, without retaining another reference. */
  private readonly supervisedFlows = new WeakMap<
    WorkspaceHookReviewFlow,
    Promise<void>
  >();
  private reviewFlowId?: string;
  private generation = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceHookReviewControllerOptions) {
    this.admission = options.admission;
    this.appVersion = options.appVersion;
    this.coordinator = options.coordinator;
    this.host = options.host;
    this.telemetry = new WorkspaceHookReviewTelemetry(
      this.admission,
      options.logger,
    );
    this.mutation = options.mutation;
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  /**
   * See workspace-hook-review-supervisor: every newly opened flow must be supervised by it.
   *
   * openOrReuseFlow reuses the same still-pending flow object, so duplicate requestReview and
   * revoke/reopen paths could attach separate supervisors to one flow and emit ReviewSettled more
   * than once on timeout. Duplicate supervision has the same problem as no supervision: singletonize
   * by flow object so duplicate requests reuse the existing supervisor promise.
   */
  private superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void> {
    const existing = this.supervisedFlows.get(flow);
    if (existing) return existing;
    const supervision = superviseWorkspaceHookReviewFlow({
      flow,
      host: this.host,
      registry: this.registry,
      sessionId: this.sessionId,
      telemetry: this.telemetry,
    });
    this.supervisedFlows.set(flow, supervision);
    return supervision;
  }

  /**
   * Soft gate: open a review flow on demand.
   *
   * Called through requestWorkspaceHookReview when the user selects Review.
   * Safe no-op (returns accepted) when there are no pending items.
   * Idempotently reuses an existing active flow (openOrReuseFlow).
   * Must be supervised through superviseFlow; otherwise it silently dies on timeout and the panel remains unusable.
   */
  async requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult> {
    const snapshot = this.admission.getCurrentSnapshot();
    if (
      target.workspaceIdentity !== snapshot.workspaceIdentity ||
      target.bundleDigest !== snapshot.bundleDigest
    ) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch" as const,
      };
    }
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    // The old implementation treated only configuredEnabled=true pending items as reviewable.
    // Locking an untrusted switch in Settings then caused deadlock: the disabled Hook would not
    // run, so no Banner appeared and Trust could never be established ahead of time. Config gate
    // and Trust are orthogonal. The review request already carries all snapshot items, so check
    // admissionClass; a disabled item still will not run after being trusted.
    const hasPending = evaluation.items.some(
      (item) => item.admissionClass === "pending",
    );
    if (!hasPending) {
      if (evaluation.items.some((item) => item.trustState === "blocked_policy")) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      if (evaluation.storeStatus === "corrupt") {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      // No pending items: safe no-op.
      return { accepted: true, reviewItemIds: [] };
    }
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    void this.superviseFlow(flow).catch(() => undefined);
    return { accepted: true, reviewItemIds: [] };
  }

  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, decision);
      if (!validation.accepted) {
        this.telemetry.responseRejected(target, validation.reasonCode);
        return validation;
      }
      const flow = this.registry.getCurrentFlow(this.sessionId);
      if (!flow) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_review_superseded" as const,
        };
      }
      const snapshot = this.admission.getCurrentSnapshot();
      // The request is bound to the immutable snapshot bundle from when it opened. Today toggle is
      // the only valid caller of replaceSnapshot (it supersedes the old flow through
      // refreshPendingFlow), and equivalence relies on that implicit invariant. If a config hot-
      // reload watcher becomes a second caller and bypasses refreshPendingFlow, a missing tombstone
      // could apply authorization to a new bundle. Match revokeCurrent with an explicit check to
      // remove this implicit dependency.
      if (
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        this.telemetry.responseRejected(
          target,
          "workspace_hooks_snapshot_mismatch",
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      // Explicitly check policy eligibility for persistent Trust before granting it. If the policy
      // rejection thrown by assertPersistentTrustMutationAllowed inside applyDecision falls through
      // to the catch-all below, it is reported as trust_store_corrupt. Users would see a misleading
      // diagnostic when enterprise policy tightens. Match revoke: check first and return the exact reasonCode.
      if (
        !this.coordinator.canMutatePersistentTrust(snapshot.workspaceIdentity)
      ) {
        this.telemetry.responseRejected(
          target,
          "workspace_hooks_blocked_by_policy",
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      let applied: { grantedRecordCount?: number };
      try {
        applied = await this.applyPersistentTrust(validation.reviewItemIds);
      } catch (error) {
        // applyDecision can fail for non-storage reasons: unknown reviewItemId,
        // resolveWorkspaceHookReviewDigests/coordinator errors, store write failures, and so on. A
        // bare catch would report every failure as trust_store_corrupt and discard the original
        // error, as happened on the toggle path. Keep reasonCode unchanged (new codes need contract
        // review); pass errorMessage through telemetry for diagnosis.
        //
        // Redaction: WorkspaceHookMutationError messages were already redacted upstream (see
        // workspace-hook-review-mutation.ts using workspaceIdentitySummary/digestSummary). For any
        // Error, use only error.message; upstream throw sites must ensure messages contain no
        // absolute path/full digest (never report full workspace/source paths).
        this.telemetry.trustStoreFailure(
          target.bundleDigest,
          error instanceof Error ? error.message : String(error),
        );
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      this.telemetry.decisionAccepted(target, decision, {
        ...(applied.grantedRecordCount === undefined
          ? {}
          : { grantedRecordCount: applied.grantedRecordCount }),
        requestEnabledCount: flow.request.items.filter(
          (item) => item.configuredEnabled,
        ).length,
      });
      const resolved = this.registry.resolve(target, decision);
      // applyDecision and registry.resolve are not atomic. If the registry deadline timer fires
      // between them, the flow becomes timed_out and resolve returns superseded, so Trust is
      // persisted but the response says the review expired. Users may retry and troubleshooters
      // may assume the write failed—another attribution error.
      //
      // The decision took effect (persistent Trust was written), so return accepted and emit
      // Settled for the frontend to converge to the decided state. A rejected resolve means another
      // terminal state already owns the flow; it does not mean authorization failed. This is safe:
      // it does not report authorization that was never granted.
      if (!resolved.accepted) {
        // Preserve the observation: another terminal state already owns the flow (usually because the deadline fired).
        this.telemetry.responseRejected(target, resolved.reasonCode);
      }
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: { interactionId: target.interactionId, state: "resolved" },
      });
      // Soft gate: reevaluate pending state after settle and notify the projection layer to update the banner.
      await this.emitAdmissionUpdatedAfterMutation();
      // Granting Trust to one inline item must not remove actions from other pending items. After
      // the old generation settles, publish the next immutable generation immediately if pending
      // declarations remain; trusted rows disappear after Settings refresh, and the other rows stay actionable.
      await this.refreshPendingFlow(snapshot);
      return resolved.accepted
        ? resolved
        : {
            accepted: true as const,
            reviewItemIds: [...validation.reviewItemIds],
          };
    });
  }

  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  > {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [reviewItemId],
      });
      if (!validation.accepted) return validation;
      const currentSnapshot = this.admission.getCurrentSnapshot();
      const entry = currentSnapshot.hooks.find(
        (item) => item.reviewItemId === reviewItemId,
      );
      if (!entry?.editable) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      let writeCommitted = false;
      let nextSnapshot: WorkspaceHookBundleSnapshot;
      try {
        nextSnapshot = await this.mutation.toggle(
          { snapshot: currentSnapshot, reviewItemId, enabled },
          () => {
            writeCommitted = true;
            this.admission.invalidate("workspace_hooks_config_rebuild_failed");
          },
        );
        this.admission.replaceSnapshot(nextSnapshot);
      } catch (error) {
        if (!writeCommitted) {
          // A bare catch previously reported every mutation-port failure as config_write_failed,
          // including snapshot mismatches before the write (bundle changed after review/discovery
          // read failed). Users would retry a "write" that could never succeed, and the real cause
          // was hidden. Pass through WorkspaceHookMutationError.code and add cause to telemetry for diagnosis.
          const isMutationError =
            error instanceof WorkspaceHookMutationError ||
            (error instanceof Error &&
              error.name === "WorkspaceHookMutationError");
          const mutationCode = isMutationError
            ? ((error as WorkspaceHookMutationError)
                .code as WorkspaceHookReasonCode)
            : ("workspace_hooks_config_write_failed" as const);
          this.telemetry.toggleFailure(
            target.bundleDigest,
            mutationCode,
            error instanceof Error ? error.message : String(error),
          );
          return {
            accepted: false,
            reasonCode: mutationCode as WorkspaceHookReasonCode,
          };
        }
        this.telemetry.toggleFailure(
          target.bundleDigest,
          "workspace_hooks_config_rebuild_failed",
        );
        this.registry.fail(target, "workspace_hooks_config_rebuild_failed");
        await this.host.emit({
          type: SessionEventType.WorkspaceHookReviewSettled,
          payload: {
            interactionId: target.interactionId,
            state: "configuration_error",
            reasonCode: "workspace_hooks_config_rebuild_failed",
          },
        });
        return {
          accepted: false,
          reasonCode: "workspace_hooks_config_rebuild_failed" as const,
        };
      }

      const nextFlow = await this.refreshPendingFlow(nextSnapshot);
      // Soft gate: reevaluate pending state after toggle rebuilds the bundle.
      await this.emitAdmissionUpdatedAfterMutation();
      return {
        accepted: true,
        reviewItemIds: [reviewItemId],
        ...(nextFlow ? { request: nextFlow.request } : {}),
      };
    });
  }

  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [...reviewItemIds],
      });
      if (!validation.accepted) return validation;
      const snapshot = this.admission.getCurrentSnapshot();
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests: resolveWorkspaceHookReviewDigests(
          snapshot,
          validation.reviewItemIds,
        ),
        reviewItemIds: validation.reviewItemIds,
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(
          snapshot.bundleDigest,
          validation.reviewItemIds.length,
        );
        await this.refreshPendingFlow(snapshot);
        // Soft gate: reevaluate pending state after revoke.
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  revokeCurrent(
    target: WorkspaceHookTrustRevokeTarget,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const snapshot = this.admission.getCurrentSnapshot();
      if (
        target.sessionId !== this.sessionId ||
        target.remoteSessionId !== this.host.remoteSessionId ||
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const digests = [...new Set(target.hookDeclarationDigests)];
      const entries = snapshot.hooks.filter((entry) =>
        digests.includes(entry.hookDeclarationDigest),
      );
      if (
        digests.length === 0 ||
        new Set(entries.map((entry) => entry.hookDeclarationDigest)).size !==
          digests.length
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests,
        reviewItemIds: entries.map((entry) => entry.reviewItemId),
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, digests.length);
        await this.refreshPendingFlow(snapshot);
        // Soft gate: reevaluate pending state after revokeCurrent.
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  private async refreshPendingFlow(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (!current || current.state.state !== "pending") {
      // Returning immediately when no pending flow exists would leave the current session with no
      // way to reauthorize after "grant -> review resolved -> revoke"; the user would have to start a new conversation.
      //
      // Revoke means revoked -> admission=pending, which should prompt for review again. Open a new
      // flow here only if pending items were actually created; do not add a "grant trust directly"
      // bypass. Authorization still happens only through inline controls bound to the current immutable review.
      return await this.openReviewFlowForNewPendingItems(snapshot);
    }
    const target = toWorkspaceHookReviewTarget(current.request);
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const replacement = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: current.request.reviewFlowId,
      generation: current.request.generation + 1,
    });
    const nextFlow = this.registry.supersede(target, replacement);
    this.telemetry.superseded(replacement);
    this.generation = replacement.generation;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewSuperseded,
      payload: {
        interactionId: current.request.interactionId,
        supersededByInteractionId: replacement.interactionId,
      },
    });
    this.telemetry.requestCreated(replacement);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request: replacement },
    });
    if (replacement.summary.pendingCount === 0) {
      this.registry.closeWithoutDecision(
        toWorkspaceHookReviewTarget(replacement),
      );
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: replacement.interactionId,
          state: "resolved",
        },
      });
    }
    return nextFlow;
  }

  /**
   * Reopen review when the current session has no pending flow after revoke.
   *
   * Open only when pending items actually exist. The toggle controls execution, while Trust
   * controls admission; therefore configured-disabled declarations in the current review snapshot
   * must retain their inline Trust action. Use openOrReuseFlow, the same path as the initial
   * request, so existing generation/reviewFlowId/interactionId semantics remain unchanged.
   */
  private async openReviewFlowForNewPendingItems(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const evaluation = this.coordinator.evaluateSnapshot({
      snapshot,
    });
    const hasPending = evaluation.items.some(
      (item) => item.admissionClass === "pending",
    );
    if (!hasPending) return undefined;
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    // Must be supervised or the flow will silently die on timeout and leave the panel unusable
    // (see the superviseFlow comment). Deliberately do not await here: revoke must not block on the
    // 10-minute review deadline. Catch to avoid an unhandled rejection; flow termination itself
    // does not produce an error that should bubble to the caller.
    void this.superviseFlow(flow).catch(() => undefined);
    return flow;
  }

  private async openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (
      current?.state.state === "pending" &&
      current.request.bundleDigest === snapshot.bundleDigest
    ) {
      return current;
    }
    this.reviewFlowId ??= `workspace-hook-review:${this.createId()}`;
    const request = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: this.reviewFlowId,
      generation: this.generation + 1,
    });
    this.generation = request.generation;
    const flow = this.registry.open(request);
    this.telemetry.requestCreated(request);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request },
    });
    return flow;
  }

  private buildRequest(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
    flow: { reviewFlowId: string; generation: number },
  ): WorkspaceHookReviewRequestPayload {
    return buildWorkspaceHookReviewRequest({
      snapshot,
      evaluation,
      ...flow,
      sessionId: this.sessionId,
      host: this.host,
      now: this.now,
      createId: this.createId,
    });
  }

  private async applyPersistentTrust(
    reviewItemIds: readonly string[],
  ): Promise<{ grantedRecordCount?: number }> {
    const snapshot = this.admission.getCurrentSnapshot();
    this.coordinator.assertPersistentTrustMutationAllowed(
      snapshot.workspaceIdentity,
    );
    const records = createWorkspaceHookTrustRecords({
      snapshot,
      reviewItemIds,
      grantedAt: new Date(this.now()).toISOString(),
      ...(this.appVersion ? { appVersion: this.appVersion } : {}),
    });
    const file = await (await this.store).grant(records);
    this.coordinator.replacePersistentTrustRecords(file.records, {
      status: "ok",
    });
    return { grantedRecordCount: records.length };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Soft gate: reevaluate pending state after mutation and emit AdmissionUpdated.
   *
   * Use the same definition as admission: configuredEnabled && admissionClass === "pending".
   * Emit even when pendingCount === 0 so the projection can clear the banner.
   * admission's invalidate triggers refreshEvaluation inside evaluateDispatch; here, directly ask
   * the coordinator to reevaluate the snapshot, using the same source as admission.emitAdmissionState.
   */
  private async emitAdmissionUpdatedAfterMutation(): Promise<void> {
    const snapshot = this.admission.getCurrentSnapshot();
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const pendingCount = evaluation.items.filter(
      (item) => item.configuredEnabled && item.admissionClass === "pending",
    ).length;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookAdmissionUpdated,
      payload: {
        pendingCount,
        bundleDigest: snapshot.bundleDigest,
        ...(snapshot.workspaceIdentity
          ? { workspaceIdentity: snapshot.workspaceIdentity }
          : {}),
      },
    });
  }
}
