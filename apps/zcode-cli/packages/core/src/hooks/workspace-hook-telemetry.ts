import { createHash } from "node:crypto";
import type { Logger, WorkspaceHookReasonCode } from "@zcode/contracts";

export type WorkspaceHookTelemetryEvent =
  | "workspace_hook.feature_disabled"
  | "workspace_hook.review_request_created"
  | "workspace_hook.trust_selected"
  | "workspace_hook.review_timeout"
  | "workspace_hook.review_superseded"
  | "workspace_hook.snapshot_mismatch"
  | "workspace_hook.policy_blocked"
  | "workspace_hook.trust_store_failure"
  | "workspace_hook.toggle_failure"
  | "workspace_hook.config_rebuild_failure"
  // Revocation needs dedicated observability: when investigating a panel failure after revocation, logs must show
  // whether revocation succeeded and whether a later failure came from revocation or authorization.
  | "workspace_hook.revoked"
  | "workspace_hook.stale_response";

export interface WorkspaceHookTelemetryFields {
  workspaceIdentity?: string;
  bundleDigest?: string;
  declarationDigest?: string;
  reasonCode?: WorkspaceHookReasonCode;
  source?: string;
  action?: string;
  generation?: number;
  /**
   * Pass through the errorMessage supplied by the caller; otherwise the original error is silently discarded during emit,
   * leaving only the reasonCode in logs and making it impossible to identify the actual cause.
   * This carries only the short message from the domain error, not commands, script contents, or Trust payloads.
   */
  errorMessage?: string;
  /**
   * Diagnose the number of Trust records persisted: if the store writes fewer records than were selected and decisionAccepted
   * did not throw, logs cannot show whether the request omitted an item or the write lost a record.
   *
   * requestItemCount / requestEnabledCount record the counts actually included in the review request;
   * grantedRecordCount records the number actually written. A mismatch indicates silent data loss.
   */
  requestItemCount?: number;
  requestEnabledCount?: number;
  grantedRecordCount?: number;
  /** Number of declarations actually revoked (separate from grantedRecordCount to avoid mixing meanings). */
  revokedCount?: number;
}

const MAX_TELEMETRY_ERROR_MESSAGE_LENGTH = 300;

/**
 * Workspace Hook observability reuses the existing Logger Port.
 * Send only stable reasons, generation, and summaries; do not send commands, script contents, paths, or Trust payloads.
 */
export function emitWorkspaceHookTelemetry(
  logger: Logger | undefined,
  event: WorkspaceHookTelemetryEvent,
  fields: WorkspaceHookTelemetryFields = {},
): void {
  if (!logger) return;
  logger.info("Workspace Hook Trust telemetry", {
    event,
    module: "workspace_hook_trust",
    ...(fields.workspaceIdentity
      ? { workspaceIdentityDigest: workspaceIdentitySummary(fields.workspaceIdentity) }
      : {}),
    ...(fields.bundleDigest ? { bundleDigest: digestSummary(fields.bundleDigest) } : {}),
    ...(fields.declarationDigest
      ? { declarationDigest: digestSummary(fields.declarationDigest) }
      : {}),
    ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.action ? { action: fields.action } : {}),
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    ...(fields.errorMessage
      ? { errorMessage: fields.errorMessage.slice(0, MAX_TELEMETRY_ERROR_MESSAGE_LENGTH) }
      : {}),
    ...(fields.requestItemCount === undefined ? {} : { requestItemCount: fields.requestItemCount }),
    ...(fields.requestEnabledCount === undefined
      ? {}
      : { requestEnabledCount: fields.requestEnabledCount }),
    ...(fields.grantedRecordCount === undefined
      ? {}
      : { grantedRecordCount: fields.grantedRecordCount }),
    ...(fields.revokedCount === undefined ? {} : { revokedCount: fields.revokedCount }),
  });
}

export function digestSummary(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

/**
 * Short SHA-256 digest of the workspace identity.
 *
 * In this implementation, identity is an absolute path. Telemetry must not upload the full workspace path
 * or record source paths, so redact any text sent to telemetry through this helper first
 * (including domain error messages) instead of relying on downstream filtering.
 */
export function workspaceIdentitySummary(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
