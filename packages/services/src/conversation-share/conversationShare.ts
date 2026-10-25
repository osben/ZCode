/* oxlint-disable eslint(max-lines) -- Keep the shared error/preflight contract and cross-RPC redaction rules for Share within one boundary so the UI, Host, and API do not drift independently. */
import type {
  ConversationShareAccessMode,
  ConversationShareCapabilities,
  ConversationShareContinuation,
  ConversationSharePreview,
  ConversationShareRecord,
  Locale,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { Event as RpcEvent, type Event } from "@zcode/rpc";

import { createServiceDescriptor } from "../descriptors.js";
import type { ConversationShareClientErrorKind } from "./conversationShareHttpClient.js";

export type ConversationShareSelection =
  | { kind: "all" }
  | { kind: "productTurns"; productTurnIds: string[] }
  | { kind: "rowAnchors"; rowIds: number[] };

export interface PublishTextConversationInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  title: string;
  accessMode: ConversationShareAccessMode;
  selection: ConversationShareSelection;
  clientRequestId: string;
  disclosureAcceptedAt: number;
  /** UI language; determines whether the returned share_url points to the Chinese or English site. If omitted, preserve the server-provided URL. */
  locale?: Locale;
}

export interface ConversationSharePreflightInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  selection: ConversationShareSelection;
}

export interface ConversationShareAllowedArtifact {
  type: string;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  displayName?: string;
}

export interface ConversationShareTurnPreflightResult {
  /** Converted public row count; reaggregate per turn when the selection changes, without caching capacity errors for the whole selected set. */
  rowBudget?: { count: number; limit: number };
  productTurnId: string;
  turnFingerprint?: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
}

export interface ConversationSharePreflightResult {
  revision: number;
  logEpoch: string;
  capabilitiesFingerprint: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
  supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  turnResults: readonly ConversationShareTurnPreflightResult[];
}

export type ConversationShareServiceErrorKind =
  | ConversationShareClientErrorKind
  | "artifact_protocol_not_ready"
  | "connection_unavailable"
  | "invalid_selection"
  | "safety_check_timeout";

export type ConversationShareFailureReasonCode =
  | "running_turn"
  | "streaming_row"
  | "active_tool_call"
  | "active_subagent"
  | "input_attachment"
  | "input_attachment_unavailable"
  | "inline_tool_image"
  | "unsupported_timeline"
  | "unsafe_url"
  | "missing_product_turn"
  | "invalid_selection"
  | "artifact_type_not_allowed"
  | "artifact_extension_missing"
  | "artifact_outside_workspace"
  | "artifact_changed"
  | "content_unavailable"
  | "artifact_read_failed"
  // Known capacity overflow: the actual attachment size exceeds the server's max_artifact_bytes or the channel's transfer limit.
  // Unlike artifact_read_failed (unknown), this is a definite blocker at selection time.
  | "artifact_size_limit"
  | "artifact_manifest"
  | "payload_limit"
  | "no_shareable_content"
  | "stale_conversation"
  | "artifact_protocol_not_ready"
  | "invalid_conversation";

export type ConversationShareFailureIssueCode =
  | "authentication_required"
  | "network"
  | "service_unavailable"
  | "rate_limited"
  | "feature_disabled"
  | "connection_unavailable"
  | "invalid_contract"
  | "disclosure_required"
  | ConversationShareFailureReasonCode
  | "rows_limit"
  | "artifact_count_limit"
  | "artifact_total_size_limit"
  | "payload_size_limit"
  | "upload_incomplete"
  | "unknown";

export interface ConversationShareFailureIssue {
  code: ConversationShareFailureIssueCode;
  scope: "conversation" | "turn" | "artifact" | "transport";
  rowId?: number;
  turnOrdinal?: number;
  /**
   * Identity of the product turn that owns the issue.
   *
   * The UI's "deselect this turn" action used turnOrdinal to index its per-query list,
   * while turnOrdinal is assigned by the service across all turnHeaders. These indexes inevitably diverge in sessions with system-context turns
   * or multiple steer queries, causing the wrong turn to be deselected. Locate turns by identity;
   * use turnOrdinal only in display text.
   */
  productTurnId?: string;
  artifactDisplayName?: string;
  artifactType?: string;
  extension?: string;
  mimeType?: string;
  actual?: number;
  limit?: number;
  retryAfterMs?: number;
  phase?: ConversationSharePublishProgress["phase"] | "downloading" | "installing" | "committing";
  allowedFormats?: readonly string[];
  allowedArtifacts?: readonly ConversationShareAllowedArtifact[];
  availability?:
    | "not_found"
    | "permission_denied"
    | "connection_unavailable"
    | "changed"
    | "unknown";
}

export type ConversationShareFailureDiagnosticValue = string | number | boolean;
export type ConversationShareFailureDiagnostics = Readonly<
  Record<string, ConversationShareFailureDiagnosticValue>
>;

function inferFailureReasonCode(message: string): ConversationShareFailureReasonCode {
  if (/Running turns/iu.test(message)) return "running_turn";
  if (/Streaming rows/iu.test(message)) return "streaming_row";
  if (/Active tool calls/iu.test(message)) return "active_tool_call";
  if (/Active subagents|subagent detail/iu.test(message)) return "active_subagent";
  if (/attachments?|public input contains local write identity/iu.test(message)) {
    return "input_attachment";
  }
  if (/Inline tool images/iu.test(message)) return "inline_tool_image";
  if (/Timeline|fork|checkpoint|summary references/iu.test(message)) {
    return "unsupported_timeline";
  }
  if (/Local and inline URLs/iu.test(message)) return "unsafe_url";
  if (/missing its product turn|product turn identity/iu.test(message)) {
    return "missing_product_turn";
  }
  if (/Selected product turns|selected row|selection/iu.test(message)) {
    return "invalid_selection";
  }
  if (/not allowed by server capabilities/iu.test(message)) return "artifact_type_not_allowed";
  if (/extension is missing/iu.test(message)) return "artifact_extension_missing";
  if (/outside the workspace/iu.test(message)) return "artifact_outside_workspace";
  if (/changed after|file changed|size\/mtime/iu.test(message)) return "artifact_changed";
  // The fallback message from local/remote artifact sources is "artifact cannot be read".
  // The old regex matched only ended|source|chunk|readable, so read failures were misclassified as invalid_conversation.
  if (/artifact (?:ended|source|chunk|readable|cannot be read)/iu.test(message)) {
    return "artifact_read_failed";
  }
  if (/artifact (?:identifiers|manifest|acknowledgement|missing)/iu.test(message)) {
    return "artifact_manifest";
  }
  if (/payload|too many rows|too many artifacts/iu.test(message)) return "payload_limit";
  return "invalid_conversation";
}

export interface ConversationShareFailureDetails {
  requestId?: string;
  status?: number;
  code?: number;
  reasonCode?: ConversationShareFailureReasonCode;
  diagnostics?: ConversationShareFailureDiagnostics;
  issues?: readonly ConversationShareFailureIssue[];
  issueCount?: number;
  omittedIssueCount?: number;
  /** Low-level error for Host-side diagnostics only; never include it in details sent to the Renderer. */
  cause?: unknown;
}

const SAFE_FAILURE_DIAGNOSTIC_KEYS = new Set([
  "rowKind",
  "rowId",
  "field",
  "artifactType",
  "extension",
  "phase",
  "expectedBytes",
  "actualBytes",
  "errno",
]);

const MAX_FAILURE_ISSUES = 5;

function sanitizeFailureIssue(
  issue: ConversationShareFailureIssue,
): ConversationShareFailureIssue | null {
  const safeString = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && !/[\\/]|:\/\//u.test(value) ? value : undefined;
  const safeMimeType = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(value)
      ? value
      : undefined;
  const artifactDisplayName = issue.artifactDisplayName?.trim();
  // If displayName contains a path/URL or is too long, returning null filters out the entire issue. The goal of redaction is
  // to avoid exposing paths, not to lose the whole diagnostic. Strip only this field and retain identifiers such as code/scope.
  const safeArtifactDisplayName =
    artifactDisplayName &&
    artifactDisplayName.length <= 128 &&
    !/[\\/]|:\/\//u.test(artifactDisplayName)
      ? artifactDisplayName
      : undefined;
  const allowedFormats = issue.allowedFormats
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 128 && !/[\\/]|:\/\//u.test(value));
  const allowedArtifacts = issue.allowedArtifacts
    ?.map((artifact) => ({
      type: artifact.type.trim(),
      extensions: artifact.extensions
        .map((extension) => extension.trim().replace(/^\./u, ""))
        .filter((extension) => extension.length > 0 && extension.length <= 32),
      mimeTypes: artifact.mimeTypes
        .map((mimeType) => mimeType.trim().toLowerCase())
        .filter((mimeType) => /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(mimeType)),
      ...(artifact.displayName &&
      artifact.displayName.length <= 64 &&
      !/[\\/]|:\/\//u.test(artifact.displayName)
        ? { displayName: artifact.displayName.trim() }
        : {}),
    }))
    .filter(
      (artifact) =>
        artifact.type.length > 0 &&
        !/[\\/]|:\/\//u.test(artifact.type) &&
        artifact.extensions.length > 0,
    );
  return {
    code: issue.code,
    scope: issue.scope,
    ...(issue.rowId === undefined ? {} : { rowId: issue.rowId }),
    ...(issue.turnOrdinal === undefined ? {} : { turnOrdinal: issue.turnOrdinal }),
    ...(typeof issue.productTurnId === "string" && issue.productTurnId.length > 0
      ? { productTurnId: issue.productTurnId }
      : {}),
    ...(safeArtifactDisplayName ? { artifactDisplayName: safeArtifactDisplayName } : {}),
    ...(safeString(issue.artifactType) ? { artifactType: safeString(issue.artifactType) } : {}),
    ...(safeString(issue.extension) ? { extension: safeString(issue.extension) } : {}),
    ...(safeMimeType(issue.mimeType) ? { mimeType: safeMimeType(issue.mimeType) } : {}),
    ...(issue.actual === undefined ? {} : { actual: issue.actual }),
    ...(issue.limit === undefined ? {} : { limit: issue.limit }),
    ...(issue.retryAfterMs === undefined ? {} : { retryAfterMs: issue.retryAfterMs }),
    ...(issue.phase === undefined ? {} : { phase: issue.phase }),
    ...(allowedFormats && allowedFormats.length > 0 ? { allowedFormats } : {}),
    ...(allowedArtifacts && allowedArtifacts.length > 0 ? { allowedArtifacts } : {}),
    ...(issue.availability === undefined ? {} : { availability: issue.availability }),
  };
}

/**
 * Trim and sanitize the issue list into a payload safe to send across RPC, and return the number omitted.
 * Non-blocking warnings and blocking issues use the same redaction rules.
 */
export function sanitizeConversationShareIssues(issues: readonly ConversationShareFailureIssue[]): {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount: number;
} {
  const sanitized = issues
    .slice(0, MAX_FAILURE_ISSUES)
    .map(sanitizeFailureIssue)
    .filter((issue): issue is ConversationShareFailureIssue => issue !== null);
  return {
    issues: sanitized,
    issueCount: issues.length,
    omittedIssueCount: Math.max(0, issues.length - sanitized.length),
  };
}

function sanitizeFailureDiagnostics(
  diagnostics: ConversationShareFailureDiagnostics | undefined,
): ConversationShareFailureDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const safe: Record<string, ConversationShareFailureDiagnosticValue> = {};
  for (const [key, value] of Object.entries(diagnostics)) {
    if (!SAFE_FAILURE_DIAGNOSTIC_KEYS.has(key)) continue;
    if (typeof value === "string" && (/[\\/]|:\/\//u.test(value) || value.length > 128)) continue;
    safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export class ConversationShareServiceError extends Error {
  readonly kind: ConversationShareServiceErrorKind;
  readonly requestId?: string;
  readonly status?: number;
  readonly code?: number;
  readonly reasonCode: ConversationShareFailureReasonCode;
  readonly diagnostics?: ConversationShareFailureDiagnostics;
  readonly issues?: readonly ConversationShareFailureIssue[];
  readonly issueCount: number;
  readonly omittedIssueCount: number;
  /** Safe error payload sent to the Renderer through the existing RPC details field. */
  readonly details?: ConversationShareFailureDetails;

  constructor(
    kind: ConversationShareServiceErrorKind,
    message: string,
    details: ConversationShareFailureDetails = {},
  ) {
    super(message, ...(details.cause === undefined ? [] : [{ cause: details.cause }]));
    this.name = "ConversationShareServiceError";
    this.kind = kind;
    const requestId = details.requestId?.trim();
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
    }
    if (Number.isSafeInteger(details.status)) this.status = details.status;
    if (Number.isSafeInteger(details.code)) this.code = details.code;
    this.reasonCode = details.reasonCode ?? inferFailureReasonCode(message);
    const diagnostics = sanitizeFailureDiagnostics(details.diagnostics);
    if (diagnostics) {
      this.diagnostics = diagnostics;
    }
    const sanitized = sanitizeConversationShareIssues(details.issues ?? []);
    this.issueCount = sanitized.issueCount;
    this.omittedIssueCount = sanitized.omittedIssueCount;
    if (sanitized.issues.length > 0) {
      this.issues = sanitized.issues;
    }
    const safeDetails: ConversationShareFailureDetails = {
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
      reasonCode: this.reasonCode,
      ...(this.diagnostics === undefined ? {} : { diagnostics: this.diagnostics }),
      ...(this.issues === undefined ? {} : { issues: this.issues }),
      ...(this.issueCount > 0 ? { issueCount: this.issueCount } : {}),
      ...(this.issueCount > 0 ? { omittedIssueCount: this.omittedIssueCount } : {}),
    };
    if (Object.keys(safeDetails).length > 0) {
      this.details = safeDetails;
    }
  }
}

export interface ConversationSharePublishProgress {
  operationId: string;
  phase: "collecting" | "uploading" | "checking" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
  /**
   * Non-blocking notice: publishing continues, but these artifacts are skipped (for example, a file referenced in the body no longer exists).
   * Sanitized by sanitizeConversationShareIssues and safe to send across RPC.
   */
  warnings?: readonly ConversationShareFailureIssue[];
  omittedWarningCount?: number;
}

export interface ConversationShareImportProgress {
  operationId: string;
  phase: "downloading" | "installing" | "committing" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
}

export interface ImportConversationShareInput {
  shareCode: string;
  clientRequestId: string;
  /** Target captured by the current renderer; the Deep Link itself must not carry a path or identity. */
  targetWorkspacePath?: string;
  targetWorkspaceIdentity?: string;
  targetWorkspaceKind?: "local" | "remote";
  /** UI language; determines the imported session's title prefix. The return link itself always stores the canonical path. */
  locale?: Locale;
}

/** Public rows copy persisted during import; read-only blocks in the session render from it without fetching the source again. */
export interface ImportedConversationShare {
  shareId: string;
  contextId: string;
  title: string;
  rows: ConversationRow[];
  /**
   * Number of rows skipped because this client cannot render them (the copy contains a new row kind or a newer formatVersion).
   * When >0, show a non-blocking notice at the top of the read-only block so users do not think content was lost.
   */
  unsupportedRowCount: number;
  /** Upstream content blocks of the imported share; optional so older copies without them still type-check. */
  contentBlocks?: unknown[];
  artifacts: Array<{
    artifactId: string;
    displayName: string;
    mimeType?: string;
    workspaceRelativePath?: string;
  }>;
}

export interface ImportConversationShareResult {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  contextId: string;
  shareUrl: string;
  title: string;
  reused: boolean;
  fallbackReason?: "remote_workspace" | "default_workspace";
}

export interface IConversationShareService {
  getCapabilities(): Promise<ConversationShareCapabilities>;
  preflight(input: ConversationSharePreflightInput): Promise<ConversationSharePreflightResult>;
  publish(
    input: PublishTextConversationInput,
    operationId: string,
  ): Promise<ConversationShareRecord>;
  onDynamicPublishProgress(operationId: string): Event<ConversationSharePublishProgress>;
  importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult>;
  onDynamicImportProgress(operationId: string): Event<ConversationShareImportProgress>;
  /** Read public rows persisted during import; return null if not found (the session then omits the read-only block). */
  getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null>;
  getPreview(shareCode: string): Promise<ConversationSharePreview>;
  getContinuation(input: {
    shareCode: string;
    clientRequestId: string;
  }): Promise<ConversationShareContinuation>;
}

export const IConversationShareService = createServiceDescriptor<IConversationShareService>(
  ServiceChannels.ConversationShare,
);

/**
 * Shared gate implementation for environments where sharing is unavailable.
 *
 * Every host that does not support sharing (desktop-attached remote, server remote, etc.) must reject all
 * write operations and return empty event streams. Hand-writing this in each host risks missing a method when IConversationShareService changes,
 * so generate the behavior here centrally.
 */
export function createUnsupportedConversationShareService(options: {
  message: string;
  /** Optional audit hook: pass this when a host wants to record rejected action names. */
  onRejected?: (action: string) => void;
}): IConversationShareService {
  const reject = (action: string) => async (): Promise<never> => {
    options.onRejected?.(action);
    throw new ConversationShareServiceError("feature_disabled", options.message);
  };
  const noEvents = () => RpcEvent.None;
  return {
    getCapabilities: reject("getCapabilities"),
    preflight: reject("preflight"),
    publish: reject("publish"),
    onDynamicPublishProgress: noEvents,
    importShare: reject("importShare"),
    onDynamicImportProgress: noEvents,
    // Read-only query: return null rather than throw in an unsupported environment, so the session simply omits the read-only block.
    getImportedConversation: async () => null,
    getPreview: reject("getPreview"),
    getContinuation: reject("getContinuation"),
  };
}
