import type { Logger, WorkspaceHookReasonCode } from "@zcode/contracts";
import {
  emitWorkspaceHookTelemetry,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";

export class WorkspaceHookReviewTelemetry {
  constructor(
    private readonly admission: WorkspaceHookRuntimeAdmissionPort,
    private readonly logger?: Logger,
  ) {}

  requestCreated(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_request_created", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      // Diagnose persisted trust counts: record request and actual grant counts to detect silent loss.
      requestItemCount: request.items.length,
      requestEnabledCount: request.items.filter((item) => item.configuredEnabled).length,
    });
  }

  timeout(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_timeout", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      reasonCode: "workspace_hooks_interaction_timeout",
    });
  }

  responseRejected(target: WorkspaceHookReviewTarget, reasonCode: WorkspaceHookReasonCode): void {
    this.emit(
      reasonCode === "workspace_hooks_review_superseded"
        ? "workspace_hook.stale_response"
        : "workspace_hook.snapshot_mismatch",
      { bundleDigest: target.bundleDigest, reasonCode },
    );
  }

  decisionAccepted(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
    counts?: { grantedRecordCount?: number; requestEnabledCount?: number },
  ): void {
    this.emit("workspace_hook.trust_selected", {
      action: decision.action,
      bundleDigest: target.bundleDigest,
      generation: target.generation,
      // A mismatch with requestEnabledCount indicates silent loss: decisionAccepted is emitted only after applyDecision
      // succeeds, so existing fields cannot reveal "accepted but fewer were written."
      ...(counts?.grantedRecordCount === undefined
        ? {}
        : { grantedRecordCount: counts.grantedRecordCount }),
      ...(counts?.requestEnabledCount === undefined
        ? {}
        : { requestEnabledCount: counts.requestEnabledCount }),
    });
  }

  /**
   * Revoke observation: make both success and the number revoked visible, or there will be no way to diagnose issues.
   */
  revoked(bundleDigest: string, revokedCount: number): void {
    this.emit("workspace_hook.revoked", {
      bundleDigest,
      reasonCode: "workspace_hooks_revoked",
      revokedCount,
    });
  }

  trustStoreFailure(bundleDigest: string, errorMessage?: string): void {
    this.emit("workspace_hook.trust_store_failure", {
      bundleDigest,
      reasonCode: "workspace_hooks_trust_store_corrupt",
      // applyDecision may throw for non-storage reasons (resolveWorkspaceHookReviewDigests
      // with an unknown reviewItemId, coordinator internal errors, etc.). If all failures are reported as
      // trust_store_corrupt and the cause is dropped, logs retain only reasonCode and cannot identify the real cause.
      // Keep reasonCode unchanged (new values require contracts enum review); use errorMessage to trace the actual reason.
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  toggleFailure(
    bundleDigest: string,
    reasonCode: WorkspaceHookReasonCode,
    errorMessage?: string,
  ): void {
    this.emit(
      // Pass toggle failures through using WorkspaceHookMutationError.code. reasonCode covers cases beyond write/rebuild:
      // mismatches use a dedicated event; other uncategorized failures are toggle_failure,
      // avoiding mislabeling a pre-write failure as config_rebuild_failure (wrong failure attribution).
      reasonCode === "workspace_hooks_snapshot_mismatch"
        ? "workspace_hook.snapshot_mismatch"
        : reasonCode === "workspace_hooks_config_rebuild_failed"
          ? "workspace_hook.config_rebuild_failure"
          : "workspace_hook.toggle_failure",
      { bundleDigest, reasonCode, ...(errorMessage ? { errorMessage } : {}) },
    );
  }

  superseded(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_superseded", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      reasonCode: "workspace_hooks_review_superseded",
    });
  }

  private emit(
    event: Parameters<typeof emitWorkspaceHookTelemetry>[1],
    fields: Parameters<typeof emitWorkspaceHookTelemetry>[2],
  ): void {
    emitWorkspaceHookTelemetry(this.logger, event, {
      workspaceIdentity: this.admission.getCurrentSnapshot().workspaceIdentity,
      ...fields,
    });
  }
}
