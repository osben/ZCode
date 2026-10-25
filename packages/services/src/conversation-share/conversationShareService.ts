/* oxlint-disable eslint(max-lines) -- Publishing, remote staging, safe polling, and atomic import share one attempt lifecycle; splitting them would give cleanup and progress state multiple owners. */
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import type {
  ConversationShareArtifactDescriptor,
  ConversationShareCapabilities,
  ConversationShareConfirmRequest,
  ConversationShareContinuation,
  ConversationShareRecord,
  Locale,
} from "@zcode/shared";
import {
  projectShareToolDisplay,
  decodeConversationShareRows,
  supportsConversationShareContent,
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
  localizeConversationShareUrl,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter } from "@zcode/rpc";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "#src/zcode-session/zcodeSession.js";
import { getConversationWorkspaceDir } from "#src/paths.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ConversationShareServiceError,
  sanitizeConversationShareIssues,
  type IConversationShareService,
  type PublishTextConversationInput,
  type ConversationSharePublishProgress,
  type ConversationShareImportProgress,
  type ConversationShareFailureIssue,
  type ConversationSharePreflightInput,
  type ConversationSharePreflightResult,
  type ConversationShareAllowedArtifact,
  type ConversationShareTurnPreflightResult,
  type ImportConversationShareInput,
  type ImportConversationShareResult,
  type ImportedConversationShare,
} from "./conversationShare.js";
import {
  ConversationShareClientError,
  type ConversationShareHttpClient,
} from "./conversationShareHttpClient.js";
import {
  buildConversationShareArtifactSnapshot,
  getConversationSharePreviewCandidateFingerprint,
  type ConversationSharePreviewPreflightSnapshot,
} from "./conversationShareArtifactDiscovery.js";
import {
  buildConversationShareConfirmRequest,
  sha256ConversationShareJson,
} from "./conversationShareIntegrity.js";
import { materializeConversationShareInlineImages } from "./conversationShareInlineImages.js";
import { buildConversationSharePublicProjection } from "./conversationSharePublicProjection.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import { formatSharedContextV1 } from "./sharedContextFormatter.js";

import {
  collectConversationShareWorkflowSnapshot,
  isWorkflowShareFallbackRow,
  type ShareWorkflowReader,
} from "./conversationShareWorkflowSnapshot.js";

const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONFIRM_POLL_TIMEOUT_MS = 120_000;
// The download fallback cannot be a bare fetch (without AbortSignal/timeout): if the object-storage connection hangs, import stays in
// the downloading phase until undici's default ~300s fallback, effectively freezing the app. 120s covers large artifacts on slow downloads.
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MISSING_ARTIFACT_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
// Fallback limit for preflight snapshots: a single share can write at most one entry per selected turn. 200 covers normal conversations
// and prevents long-lived hosts from growing without bound when users preflight repeatedly but never publish.
const PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES = 200;
// Concurrency limit for preflight stat: it makes little difference locally, but each stat is a network round trip in SSH/remote workspaces,
// so serial requests leave "Next" in checking for a long time. The limit prevents overwhelming the remote host.
const SHARE_PREFLIGHT_STAT_CONCURRENCY = 6;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Bounded-concurrency map that preserves input order in its output.
 *
 * Each preflight stat is a network round trip in SSH/remote workspaces; serial execution leaves "Next"
 * in checking for a long time. The concurrency cap prevents overwhelming the remote host. Results are written back by index,
 * so issue ordering remains deterministic (identical to the serial implementation).
 */
async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (items.length === 0) return [];
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Result or failure reason from stat; collect during the concurrent phase and classify in a second pass that preserves order. */
type SettledResult<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

async function settle<Value>(run: () => Promise<Value>): Promise<SettledResult<Value>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function isMissingArtifactReadError(error: unknown): boolean {
  return (
    error instanceof ConversationShareServiceError &&
    error.reasonCode === "artifact_read_failed" &&
    typeof error.diagnostics?.errno === "string" &&
    MISSING_ARTIFACT_ERRNOS.has(error.diagnostics.errno)
  );
}

function sanitizeFileSegment(value: string): string {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  return [...value.normalize("NFKC")]
    .map((character) =>
      character.codePointAt(0)! < 32 || forbidden.has(character) ? "-" : character,
    )
    .join("");
}

function uniqueImportedFileName(
  displayName: string,
  artifactId: string,
  usedNames: Set<string>,
): string {
  const base =
    sanitizeFileSegment(basename(displayName.replace(/\\/gu, "/")))
      .replace(/^[. ]+|[. ]+$/gu, "")
      .slice(0, 180) || "artifact";
  let candidate = base;
  if (usedNames.has(candidate.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    const suffix = artifactId.replace(/[^A-Za-z0-9]/gu, "").slice(-8) || "artifact";
    candidate = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export interface ConversationShareServiceOptions {
  zcodeAgentService: ConversationShareAgentService;
  client: ConversationShareHttpClient;
  artifactSource: ConversationShareArtifactSource;
  confirmPollIntervalMs?: number;
  confirmPollTimeoutMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  zcodeSessionService?: Pick<IZCodeSessionService, "createSession" | "listSessions">;
  download?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Timeout for downloading one artifact (including reading the body); defaults to 120s. */
  downloadTimeoutMs?: number;
  conversationWorkspaceRoot?: string;
  /** Canonical share-page base URL injected only by the Desktop Host. */
  shareWebUrl?: string;
  logger?: ServiceLogger;
}

type ConversationShareAgentService = ShareWorkflowReader &
  Pick<
    IZCodeAgentService,
    | "conversationRowsRangeV4"
    | "conversationFileChangesV4"
    | "conversationAttachmentReadV4"
    | "conversationAttachmentStatV4"
  >;

/** Symbol methods cannot be called through the string-command ProxyChannel; used only to assemble Desktop Host attachments. */
export const conversationShareConnectionScopeFactory = Symbol(
  "conversationShareConnectionScopeFactory",
);

const CONNECTION_UNAVAILABLE_ERRORS = new Set([
  "fault.conversation.rowsRangeConnectionUntrusted",
  "fault.connection.handshakeRequired",
  "fault.connection.closed",
]);

function normalizeConversationShareConnectionError(error: unknown): unknown {
  if (error instanceof Error && CONNECTION_UNAVAILABLE_ERRORS.has(error.message)) {
    return new ConversationShareServiceError(
      "connection_unavailable",
      "Conversation share connection is not ready",
    );
  }
  return error;
}

function workspaceKeyOf(path: string | undefined, identity: string | undefined): string {
  return identity?.trim() || path?.trim() || "__default_conversation_workspace__";
}

function importDedupeKey(shareCode: string, workspaceKey: string): string {
  return `${shareCode}\u0000${workspaceKey}`;
}

function previewPreflightKey(
  input: Pick<
    PublishTextConversationInput | ConversationSharePreflightInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >,
  productTurnId: string,
): string {
  return [
    workspaceKeyOf(input.workspacePath, input.workspaceIdentity),
    input.remoteSessionId ?? "",
    input.sessionId,
    productTurnId,
  ].join("\u0000");
}

/**
 * Title prefix for imported sessions. The services layer has no intl, so maintain only a minimal mapping here.
 * The prefix is fixed during import and persisted as session.title (titleSource: "custom"); later UI-language changes do not rewrite it.
 */
const IMPORTED_SHARE_TITLE_PREFIX: Readonly<Record<Locale, string>> = {
  "zh-CN": "来自分享：",
  "en-US": "From Share: ",
  "uk-UA": "Зі спільного доступу: ",
};

function formatImportedShareSessionTitle(shareTitle: string, locale: Locale | undefined): string {
  return `${IMPORTED_SHARE_TITLE_PREFIX[locale ?? "zh-CN"]}${shareTitle.trim()}`;
}

function localizePublishedShare(
  share: ConversationShareRecord,
  locale: Locale | undefined,
): ConversationShareRecord {
  if (!locale) return share;
  const shareUrl = localizeConversationShareUrl(share.share_url, locale);
  return shareUrl === share.share_url ? share : { ...share, share_url: shareUrl };
}

/** Read-only copy format version produced by this client; evolves independently of the wire schema_version. */
const IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION = 1;

/**
 * Shape of the persisted read-only copy; it comes from disk and must be validated before rendering.
 *
 * formatVersion and rows are intentionally permissive: if a user imports a session in a newer version and then rolls back,
 * the read-only block should still render as much as possible (skip unrecognized rows and show a notice at the top) rather than disappearing silently and looking like data loss.
 */
const importedConversationShareFileSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    shareId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    title: z.string(),
    rows: z.array(z.unknown()),
    content_blocks: z.array(z.unknown()).optional(),
    artifacts: z.array(
      z.object({
        artifactId: z.string().trim().min(1),
        displayName: z.string(),
        mimeType: z.string().optional(),
        workspaceRelativePath: z.string().optional(),
      }),
    ),
  })
  .strip();

interface ConversationRowsRead {
  rows: ConversationRow[];
  revision: number;
  logEpoch: string;
}

function turnOrdinalByProductTurn(rows: readonly ConversationRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId || result.has(row.productTurnId)) continue;
    result.set(row.productTurnId, result.size + 1);
  }
  return result;
}

function rowTurnOrdinal(row: ConversationRow, ordinals: Map<string, number>): number | undefined {
  return row.productTurnId ? ordinals.get(row.productTurnId) : undefined;
}

function hasUnsafeShareString(value: unknown): boolean {
  if (typeof value === "string") return /^(?:data|file):/iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsafeShareString);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsafeShareString(entry),
  );
}

function hasUnsupportedArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return /^zcode-artifact:\/\//iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedArtifactReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsupportedArtifactReference(entry),
  );
}

/**
 * Silently remove finalized internal structures that the V1 public projection cannot carry: drop fields/rows that cannot be public, while preserving the rest
 * of the turn. This allows publishing to continue without exposing internal rendering structures as user-facing errors.
 *
 * Downgrade only finalized content that cannot be carried. Running turns/rows/tools/subagents are still blocked by
 * collectShareStructureIssues; that content is not finalized, so skipping it would share a partial result.
 */
function sanitizeUnsupportedShareStructures(rows: readonly ConversationRow[]): ConversationRow[] {
  const sanitized: ConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "timelineMarker") {
      // Keep running markers so collectShareStructureIssues continues to block them; the content is not finalized.
      // A blocked publish never reaches projection, so retaining the marker has no side effects.
      const markerRunning =
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running");
      if (markerRunning) {
        sanitized.push(row);
        continue;
      }
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        // Branch/rollback markers carry only local session relationships and are not rendered on the public page; remove them directly so internal timeline structures
        // are not counted as "files skipped" or shown to the user.
        continue;
      }
      // Silently strip other markers to avoid bothering the sharer:
      // - compact (context was compressed) is runtime bookkeeping with no value to read-only viewers. Its lane is assistantWork, and leaving it at the end of the flow
      //   displaces the "final response" collapse anchor and makes the whole turn open by default
      //   (conversationTurnWorkSegments.ts assistantHistoryDefaultOpen); this is the primary reason it must be removed.
      // - goalVerify / goalSet / retryNotice are not rendered on the share page and only consume max_rows quota.
      // - modelChange can show only a generic "model switched" message, which provides little information and exposes internal model changes.
      continue;
    }
    if (row.kind === "toolCall" && row.toolName === "EnterPlanMode") {
      // EnterPlanMode is only an internal mode-transition boundary. The rendering layer (isVisibleAssistantWorkRow) already filters it out,
      // but it would still consume max_rows / max_payload_bytes in the payload without ever being displayed.
      continue;
    }
    sanitized.push(row);
  }
  return sanitized;
}

function sanitizeUnsupportedShareArtifacts(
  rows: readonly ConversationRow[],
  capabilities: ConversationShareCapabilities,
  ordinalRows: readonly ConversationRow[],
): { rows: ConversationRow[]; warnings: ConversationShareFailureIssue[] } {
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const warnings: ConversationShareFailureIssue[] = [];
  const retained = rows.filter((row) => {
    if (row.kind !== "artifact") return true;
    const extension = fileExtension(row.displayName);
    const mimeType = normalizedMimeType(row.mimeType);
    const allowed = capabilities.allowed_artifacts.find(
      (candidate) =>
        candidate.type === row.artifactType &&
        candidate.extensions.some(
          (value) => value.replace(/^\./u, "").toLowerCase() === extension,
        ) &&
        candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
    );
    if (allowed) return true;
    warnings.push({
      code: "artifact_type_not_allowed",
      scope: "artifact",
      rowId: row.rowId,
      ...(row.productTurnId && ordinals.has(row.productTurnId)
        ? { turnOrdinal: ordinals.get(row.productTurnId) }
        : {}),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
      artifactDisplayName: row.displayName,
      artifactType: row.artifactType,
      ...(extension ? { extension } : {}),
      mimeType,
      allowedFormats: allowedFormatLabels(capabilities),
      allowedArtifacts: allowedArtifactSummaries(capabilities),
    });
    return false;
  });
  return { rows: retained, warnings };
}

function collectShareStructureIssues(
  rows: readonly ConversationRow[],
  ordinalRows: readonly ConversationRow[] = rows,
): ConversationShareFailureIssue[] {
  const issues: ConversationShareFailureIssue[] = [];
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const add = (row: ConversationRow, code: ConversationShareFailureIssue["code"]) => {
    issues.push({
      code,
      scope: code === "missing_product_turn" ? "conversation" : "turn",
      ...(row.rowId === undefined ? {} : { rowId: row.rowId }),
      ...(rowTurnOrdinal(row, ordinals) === undefined
        ? {}
        : { turnOrdinal: rowTurnOrdinal(row, ordinals) }),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
    });
  };
  for (const row of rows) {
    if (!row.productTurnId) add(row, "missing_product_turn");
    if (row.kind === "turnHeader" && row.state === "running") add(row, "running_turn");
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      add(row, "streaming_row");
    }
    if (
      row.kind === "toolCall" &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    ) {
      add(row, "active_tool_call");
    }
    if (row.kind === "subagent" && row.status === "running") add(row, "active_subagent");
    if (row.kind === "timelineMarker") {
      // Only timeline operations that are still running remain blocking; fork/checkpoint/compact summaryRef have already been downgraded to skipped by
      // sanitizeUnsupportedShareStructures.
      if (
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")
      ) {
        add(row, "unsupported_timeline");
      }
    }
    if (hasUnsafeShareString(row)) add(row, "unsafe_url");
    if (hasUnsupportedArtifactReference(row)) add(row, "artifact_protocol_not_ready");
  }
  return issues;
}

function allowedFormatLabels(capabilities: ConversationShareCapabilities): string[] {
  return capabilities.allowed_artifacts.flatMap((allowed) =>
    allowed.extensions.map(
      (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
    ),
  );
}

function allowedArtifactSummaries(
  capabilities: ConversationShareCapabilities,
): ConversationShareAllowedArtifact[] {
  return capabilities.allowed_artifacts.map((allowed) => ({
    type: allowed.type,
    extensions: [...allowed.extensions],
    mimeTypes: [...allowed.mime_types],
  }));
}

function capabilitiesFingerprint(capabilities: ConversationShareCapabilities): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
}

function fileExtension(fileName: string): string | undefined {
  const baseName = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1 ? baseName.slice(dot + 1).toLowerCase() : undefined;
}

function normalizedMimeType(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function attachmentDisplayName(fileName: string): string {
  return basename(fileName.replace(/\\/gu, "/")) || "附件";
}

function allowedArtifactFor(
  capabilities: ConversationShareCapabilities,
  extension: string | undefined,
  mimeType: string,
) {
  if (!extension) return undefined;
  return capabilities.allowed_artifacts.find(
    (allowed) =>
      allowed.extensions.some((value) => value.replace(/^\./u, "").toLowerCase() === extension) &&
      allowed.mime_types.some((value) => value.toLowerCase() === mimeType),
  );
}

/**
 * Classify attachment errors using stable protocol-level fault codes (see attachment-faults.ts).
 *
 * Do not classify with an `error.message` regex: this breaks when RPC wrappers/schema validation change.
 * A ZodError for an oversized attachment was once misclassified as "unknown" and downgraded to deferred, silently dropping content.
 * Keep an errno-text fallback only when a fault code is absent, for older zcode-cli versions that do not include structured codes yet.
 */
function isDefiniteMissingAttachment(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not found|not_found|statNotFile|is_directory/iu.test(message);
}

function isAttachmentAuthorizationError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /shareStatNotAuthorized|shareReadNotAuthorized|connectionUntrusted/iu.test(message);
}

/** The attachment exceeds protocol/channel capacity; show this as a definite blocker during selection. */
function isAttachmentTooLargeError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  return (
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge ||
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge
  );
}

function buildTurnPreflightResults(
  productTurnIds: readonly string[],
  turnOrdinalByProductTurnId: ReadonlyMap<string, number>,
  blockingIssues: readonly ConversationShareFailureIssue[],
  skippableWarnings: readonly ConversationShareFailureIssue[],
  deferredIssues: readonly ConversationShareFailureIssue[],
): ConversationShareTurnPreflightResult[] {
  return productTurnIds.map((productTurnId) => {
    const turnOrdinal = turnOrdinalByProductTurnId.get(productTurnId);
    const forTurn = (issues: readonly ConversationShareFailureIssue[]) =>
      issues.filter(
        (issue) =>
          issue.turnOrdinal === turnOrdinal ||
          (issue.turnOrdinal === undefined &&
            issue.rowId === undefined &&
            issue.artifactDisplayName === undefined &&
            (issue.scope === "conversation" || issue.scope === "transport")),
      );
    return {
      productTurnId,
      blockingIssues: forTurn(blockingIssues),
      skippableWarnings: forTurn(skippableWarnings),
      deferredIssues: forTurn(deferredIssues),
    };
  });
}

function removeIndependentArtifactRows(rows: readonly ConversationRow[]): ConversationRow[] {
  // Share candidates are limited to user-input attachments and final visible Assistant preview cards; embedded
  // images are converted separately afterwards. Historical artifact rows without a corresponding preview card
  // are no longer a third independent discovery source for the public projection.
  return rows.filter((row) => row.kind !== "artifact");
}

function throwServiceError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
): never {
  throw new ConversationShareServiceError(kind, message);
}

function selectRows(
  rows: ConversationRow[],
  selection: PublishTextConversationInput["selection"],
): { rows: ConversationRow[]; productTurnIds: string[] } {
  let selectedProductTurnIds: Set<string>;
  if (selection.kind === "all") {
    selectedProductTurnIds = new Set(
      rows
        .filter((row) => row.kind === "turnHeader")
        .map((row) => row.productTurnId)
        .filter((value): value is string => value !== undefined),
    );
  } else if (selection.kind === "productTurns") {
    if (selection.productTurnIds.length === 0) {
      throwServiceError("invalid_selection", "At least one product turn must be selected");
    }
    selectedProductTurnIds = new Set(selection.productTurnIds);
  } else {
    if (selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    selectedProductTurnIds = new Set<string>();
    for (const rowId of new Set(selection.rowIds)) {
      const row = rowsById.get(rowId);
      if (!row?.productTurnId) {
        throwServiceError("invalid_selection", "A selected row no longer exists");
      }
      selectedProductTurnIds.add(row.productTurnId);
    }
  }

  const orderedProductTurnIds: string[] = [];
  const headerCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId) continue;
    headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
    if (selectedProductTurnIds.has(row.productTurnId)) {
      orderedProductTurnIds.push(row.productTurnId);
    }
  }
  if (
    orderedProductTurnIds.length === 0 ||
    orderedProductTurnIds.length !== selectedProductTurnIds.size ||
    orderedProductTurnIds.some((productTurnId) => headerCounts.get(productTurnId) !== 1)
  ) {
    throwServiceError("invalid_selection", "Selected product turns are incomplete or ambiguous");
  }

  const selectedTurnIds = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "turnHeader" &&
          row.productTurnId !== undefined &&
          selectedProductTurnIds.has(row.productTurnId),
      )
      .map((row) => row.turnId),
  );

  return {
    productTurnIds: orderedProductTurnIds,
    // Older projections may lack productTurnId. Keep the row if its turnId is among the selected turns so validation can reject it explicitly;
    // do not silently filter it out and publish an incomplete conversation.
    rows: rows.filter(
      (row) =>
        (row.productTurnId !== undefined && selectedProductTurnIds.has(row.productTurnId)) ||
        (row.productTurnId === undefined && selectedTurnIds.has(row.turnId)),
    ),
  };
}

export class ConversationShareService implements IConversationShareService {
  private readonly zcodeAgentService: ConversationShareAgentService;
  private readonly client: ConversationShareHttpClient;
  private readonly artifactSource: ConversationShareArtifactSource;
  private readonly confirmPollIntervalMs: number;
  private readonly confirmPollTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly progressEmitters = new Map<string, Emitter<ConversationSharePublishProgress>>();
  private readonly importProgressEmitters = new Map<
    string,
    Emitter<ConversationShareImportProgress>
  >();
  private readonly zcodeSessionService?: Pick<
    IZCodeSessionService,
    "createSession" | "listSessions"
  >;
  private readonly download: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  private readonly downloadTimeoutMs: number;
  private readonly conversationWorkspaceRoot: string;
  private readonly shareWebUrl: string;
  private readonly importIndexPath: string;
  private readonly logger: ServiceLogger;
  private readonly publishPhases = new Map<string, ConversationSharePublishProgress["phase"]>();
  // Selection and publishing share the "final visible card" boundary. Publishing still runs stat/read again, but does not re-include
  // candidates that the UI hid during selection because they were missing.
  //
  // Lifecycle: the desktop host is long-lived. This map previously deleted an entry only when its
  // stat settled, so it grew continuously over time. It now has two cleanup paths: clear entries by
  // session prefix when publishing completes, and enforce a FIFO size limit on set (covering paths
  // where the user abandons sharing and never publishes).
  private readonly previewPreflightSnapshots = new Map<
    string,
    ConversationSharePreviewPreflightSnapshot
  >();
  private readonly completedImports = new Map<string, ImportConversationShareResult>();
  private readonly completedImportsByWorkspace = new Map<string, ImportConversationShareResult>();
  private readonly inFlightImports = new Map<string, Promise<ImportConversationShareResult>>();
  private readonly inFlightImportsByWorkspace = new Map<
    string,
    Promise<ImportConversationShareResult>
  >();
  private completedImportsLoaded!: Promise<void>;
  private importIndexWriteChain: Promise<void> = Promise.resolve();

  constructor(options: ConversationShareServiceOptions) {
    this.zcodeAgentService = options.zcodeAgentService;
    this.client = options.client;
    this.artifactSource = options.artifactSource;
    this.confirmPollIntervalMs = options.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS;
    this.confirmPollTimeoutMs = options.confirmPollTimeoutMs ?? DEFAULT_CONFIRM_POLL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
    this.zcodeSessionService = options.zcodeSessionService;
    this.download = options.download ?? ((url, init) => fetch(url, { signal: init?.signal }));
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.conversationWorkspaceRoot =
      options.conversationWorkspaceRoot ?? getConversationWorkspaceDir();
    // The fallback was hard-coded to the production site at https://zcode.z.ai/cn/share. In test
    // environments where the API base uses a configured ZCode origin, imported links still pointed to
    // production and opening the divider showed a share from another environment. Use the same
    // environment resolver as the API base (also used by buildRuntimeZCodeApiUrl) to keep them aligned.
    // Precedence is unchanged: explicit option > ZCODE_CONVERSATION_SHARE_WEB_URL > environment-derived.
    this.shareWebUrl = (
      options.shareWebUrl ??
      process.env.ZCODE_CONVERSATION_SHARE_WEB_URL ??
      `${resolveRuntimeZCodeEndpointOrigin(process.env)}/cn/share`
    ).replace(/\/+$/u, "");
    this.importIndexPath = join(this.conversationWorkspaceRoot, ".zcode-share-imports.json");
    this.logger = options.logger ?? createServiceLogger("conversation-share");
    this.completedImportsLoaded = this.loadCompletedImportIndex();
    if (this.zcodeSessionService) {
      void this.cleanupAbandonedImports().catch(() => undefined);
    }
  }

  getCapabilities() {
    return this.client.getCapabilities();
  }

  /** Store a preflight snapshot and, above the limit, evict the oldest entry by insertion order (Map preserves that order). */
  private setPreviewPreflightSnapshot(
    key: string,
    snapshot: ConversationSharePreviewPreflightSnapshot,
  ): void {
    // Delete and reinsert an existing key so it moves to the end of insertion order and eviction truly
    // removes the least recently updated entry.
    this.previewPreflightSnapshots.delete(key);
    this.previewPreflightSnapshots.set(key, snapshot);
    while (this.previewPreflightSnapshots.size > PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES) {
      const oldestKey = this.previewPreflightSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.previewPreflightSnapshots.delete(oldestKey);
    }
  }

  /** Clear all preflight snapshots for this workspace and session after sharing completes. */
  private clearPreviewPreflightSnapshots(
    input: Pick<
      PublishTextConversationInput | ConversationSharePreflightInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
  ): void {
    const prefix = previewPreflightKey(input, "");
    for (const key of this.previewPreflightSnapshots.keys()) {
      if (key.startsWith(prefix)) this.previewPreflightSnapshots.delete(key);
    }
  }

  async preflight(
    input: ConversationSharePreflightInput,
  ): Promise<ConversationSharePreflightResult> {
    try {
      return await this.preflightWithAgent(input, this.zcodeAgentService);
    } catch (error) {
      throw normalizeConversationShareConnectionError(error);
    }
  }

  private async preflightWithAgent(
    input: ConversationSharePreflightInput,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationSharePreflightResult> {
    const capabilities = await this.client.getCapabilities();
    const supportedArtifactTypes = allowedArtifactSummaries(capabilities);
    const conversation = await this.loadAllRows(input, agentService);
    const blockingIssues: ConversationShareFailureIssue[] = [];
    const skippableWarnings: ConversationShareFailureIssue[] = [];
    const deferredIssues: ConversationShareFailureIssue[] = [];

    let selected: { rows: ConversationRow[]; productTurnIds: string[] };
    try {
      selected = selectRows(conversation.rows, input.selection);
    } catch (error) {
      if (error instanceof ConversationShareServiceError) {
        blockingIssues.push({
          code: "invalid_selection",
          scope: "conversation",
        });
      } else {
        throw error;
      }
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues,
        skippableWarnings,
        deferredIssues,
        supportedArtifactTypes,
        turnResults: [],
      };
    }

    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurn(conversation.rows),
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: this.now(),
      preflight: true,
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurn(conversation.rows).get(draft.productTurnId),
              },
            ]
          : [],
    );
    skippableWarnings.push(
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    );
    blockingIssues.push(...collectShareStructureIssues(selectedRows, conversation.rows));
    let hasShareableContent = selectedRows.some((row) => {
      if (row.kind === "turnHeader" || row.kind === "timelineMarker") return false;
      if (row.kind === "assistantText" || row.kind === "reasoning")
        return row.text.trim().length > 0;
      if (row.kind === "userInput") return row.text.trim().length > 0;
      if (row.kind === "toolCall") {
        return Boolean(
          row.inputText?.trim() || row.output?.text?.trim() || row.error?.message?.trim(),
        );
      }
      return true;
    });

    const turnOrdinalByProductTurnId = turnOrdinalByProductTurn(conversation.rows);
    // Collect all attachments that need stat first, then check them with bounded concurrency and
    // classify them in the original order. Two passes retain the remote concurrency benefit while
    // keeping issue ordering consistent with the serial implementation.
    const attachmentChecks: {
      row: Extract<ConversationRow, { kind: "userInput" }> & {
        entityId: string;
      };
      attachmentIndex: number;
      attachment: NonNullable<
        Extract<ConversationRow, { kind: "userInput" }>["attachments"]
      >[number];
      allowed: ReturnType<typeof allowedArtifactFor>;
      baseIssue: Omit<ConversationShareFailureIssue, "code">;
    }[] = [];
    for (const row of selectedRows) {
      if (row.kind !== "userInput" || !row.attachments) continue;
      for (const [attachmentIndex, attachment] of row.attachments.entries()) {
        const extension = fileExtension(attachment.fileName);
        const mimeType = normalizedMimeType(attachment.mime);
        const allowed = allowedArtifactFor(capabilities, extension, mimeType);
        const baseIssue = {
          scope: "artifact" as const,
          rowId: row.rowId,
          ...(row.productTurnId && turnOrdinalByProductTurnId.has(row.productTurnId)
            ? { turnOrdinal: turnOrdinalByProductTurnId.get(row.productTurnId) }
            : {}),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachmentDisplayName(attachment.fileName),
          ...(extension ? { extension } : {}),
          mimeType,
          ...(allowed ? { artifactType: allowed.type } : { artifactType: extension ?? "unknown" }),
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Partial<ConversationShareFailureIssue>;
        if (!row.entityId) {
          blockingIssues.push({
            code: "input_attachment",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
          continue;
        }
        attachmentChecks.push({
          row: { ...row, entityId: row.entityId },
          attachmentIndex,
          attachment,
          allowed,
          baseIssue,
        });
      }
    }
    const attachmentStats = await mapWithConcurrency(
      attachmentChecks,
      SHARE_PREFLIGHT_STAT_CONCURRENCY,
      (check) =>
        settle(() =>
          agentService.conversationAttachmentStatV4({
            workspacePath: input.workspacePath,
            ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            sessionId: input.sessionId,
            target: { rowId: check.row.rowId, entityId: check.row.entityId },
            attachmentIndex: check.attachmentIndex,
            ref: check.attachment.ref,
          }),
        ),
    );
    for (const [checkIndex, check] of attachmentChecks.entries()) {
      const { row, attachment, allowed, baseIssue } = check;
      const settled = attachmentStats[checkIndex]!;
      if (settled.ok) {
        const stat = settled.value;
        if (!allowed) {
          // Even for an unsupported type, first check that the attachment existed when selected.
          // Report artifact_type_not_allowed only for existing attachments, not for files already removed.
          //
          // Check type before size: unsupported types are never uploaded, so their size is irrelevant to
          // sharing. Reversing the checks would turn a skippable unsupported-format warning into a
          // blocking size-limit error that compression could not fix.
          skippableWarnings.push({
            code: "artifact_type_not_allowed",
            ...baseIssue,
          });
        } else if (stat.totalBytes > capabilities.max_artifact_bytes) {
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            actual: stat.totalBytes,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (attachment.bytes > 0 && stat.totalBytes !== attachment.bytes) {
          skippableWarnings.push({
            code: "artifact_changed",
            ...baseIssue,
            availability: "changed",
          });
        } else {
          hasShareableContent = true;
        }
      } else {
        const error = settled.error;
        if (isAttachmentAuthorizationError(error)) {
          blockingIssues.push({
            code: "artifact_protocol_not_ready",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
        } else if (isAttachmentTooLargeError(error)) {
          // If an attachment is too large for stat to represent, it is still a known size-limit blocker.
          // Never downgrade it to deferred, which would silently omit the attachment from publishing.
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (isDefiniteMissingAttachment(error)) {
          skippableWarnings.push({
            code: "input_attachment_unavailable",
            ...baseIssue,
            availability: "not_found",
          });
        } else {
          hasShareableContent = true;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...baseIssue,
            availability: "unknown",
          });
        }
      }
    }

    if (!hasShareableContent) {
      blockingIssues.push({
        code: "no_shareable_content",
        scope: "conversation",
      });
    }

    if (blockingIssues.length > 0) {
      const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
      const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
      const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues: sanitizedBlockingIssues.issues,
        skippableWarnings: sanitizedWarnings.issues,
        deferredIssues: sanitizedDeferred.issues,
        supportedArtifactTypes,
        turnResults: buildTurnPreflightResults(
          selected.productTurnIds,
          turnOrdinalByProductTurnId,
          sanitizedBlockingIssues.issues,
          sanitizedWarnings.issues,
          sanitizedDeferred.issues,
        ),
      };
    }

    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
    if (registeredProjection.rows.length > capabilities.max_rows) {
      blockingIssues.push({
        code: "rows_limit",
        scope: "conversation",
        actual: registeredProjection.rows.length,
        limit: capabilities.max_rows,
      });
    }
    const manifestIssues = this.collectArtifactManifestIssues(
      capabilities,
      registeredProjection.artifacts,
    ).map((issue) => {
      // Embedded-image capacity issues must carry turn location; otherwise splitting turn caches would miss the file-level block.
      const row = selectedRows.find(
        (candidate) =>
          candidate.kind === "artifact" && candidate.displayName === issue.artifactDisplayName,
      );
      return row
        ? {
            ...issue,
            rowId: row.rowId,
            productTurnId: row.productTurnId,
            turnOrdinal: rowTurnOrdinal(row, turnOrdinalByProductTurnId),
          }
        : issue;
    });
    blockingIssues.push(
      ...manifestIssues.filter((issue) => issue.code !== "artifact_type_not_allowed"),
    );
    skippableWarnings.push(
      ...manifestIssues.filter((issue) => issue.code === "artifact_type_not_allowed"),
    );

    const headersByProductTurnId = new Map<
      string,
      Extract<ConversationRow, { kind: "turnHeader" }>
    >();
    const assistantTextByProductTurnId = new Map<string, string[]>();
    for (const row of selectedRows) {
      if (row.kind === "turnHeader" && row.productTurnId) {
        headersByProductTurnId.set(row.productTurnId, row);
      }
      if (row.kind === "assistantText" && row.productTurnId && !isWorkflowShareFallbackRow(row)) {
        const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
        texts.push(row.text);
        assistantTextByProductTurnId.set(row.productTurnId, texts);
      }
    }

    for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
      const header = headersByProductTurnId.get(productTurnId);
      if (!header) continue;
      const assistantText = textParts.join("\n\n");
      const references = extractConversationPreviewFileReferences(
        assistantText,
        input.workspacePath,
      );
      const needsFileChanges = references.some(
        (reference) => reference.kind === "markdown" || reference.kind === "html",
      );
      let fileChanges: Array<{ path: string; state: "active" | "reverted" }> | undefined;
      if (needsFileChanges && header.fileChanges?.state !== "reverted") {
        if (!header.entityId) {
          deferredIssues.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            productTurnId,
            availability: "unknown",
          });
          continue;
        }
        const result = await agentService.conversationFileChangesV4({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          sessionId: input.sessionId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: conversation.revision,
          baseLogEpoch: conversation.logEpoch,
        });
        fileChanges = result.items.map((item) => ({
          path: item.path,
          state: result.state === "reverted" ? ("reverted" as const) : ("active" as const),
        }));
      }

      const candidates = buildConversationPreviewArtifactCandidates({
        assistantText,
        productTurnId,
        workspacePath: input.workspacePath,
        fileChanges,
      });
      const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
      const previewCanonicalPaths = new Set<string>();
      let previewStatSettled = this.artifactSource.stat !== undefined;
      // Start stat calls concurrently but process results in candidate order: deduplication and the
      // visible-card limit depend on order, and each stat is a round trip for remote workspaces.
      const artifactSourceStat = this.artifactSource.stat;
      const candidateStats = artifactSourceStat
        ? await mapWithConcurrency(candidates, SHARE_PREFLIGHT_STAT_CONCURRENCY, (candidate) =>
            settle(() =>
              artifactSourceStat({
                workspacePath: input.workspacePath,
                ref: candidate.sourceRef,
              }),
            ),
          )
        : [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;

        // Check every path within the candidate limit first, then apply the UI's visible-card limit to
        // existing paths. This ensures earlier existing files do not prevent existence checks for later
        // candidates.
        const settled = candidateStats[candidateIndex];
        if (!settled) {
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (settled.ok) {
          if (previewCanonicalPaths.has(settled.value.canonicalPath)) continue;
          previewCanonicalPaths.add(settled.value.canonicalPath);
        } else {
          if (isMissingArtifactReadError(settled.error)) {
            // If an Assistant preview file no longer exists, the UI will not show its card either, so do
            // not add a Share warning.
            continue;
          }
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
          visibleCandidates.push(candidate);
        }
      }

      for (const candidate of visibleCandidates) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;
        const allowed =
          candidate.previewKind === "video" || candidate.previewKind === "audio"
            ? undefined
            : allowedArtifactFor(
                capabilities,
                fileExtension(candidate.displayName),
                candidate.mimeType,
              );
        if (!allowed) {
          skippableWarnings.push({ code: "artifact_type_not_allowed", ...issue });
        }
      }
      const snapshotKey = previewPreflightKey(input, productTurnId);
      if (previewStatSettled) {
        this.setPreviewPreflightSnapshot(snapshotKey, {
          revision: conversation.revision,
          logEpoch: conversation.logEpoch,
          capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
          candidateFingerprint: getConversationSharePreviewCandidateFingerprint(candidates),
          visibleSourceRefs: visibleCandidates.map((candidate) => candidate.sourceRef),
        });
      } else {
        this.previewPreflightSnapshots.delete(snapshotKey);
      }
    }

    const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
    const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
    const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
    return {
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
      blockingIssues: sanitizedBlockingIssues.issues,
      skippableWarnings: sanitizedWarnings.issues,
      deferredIssues: sanitizedDeferred.issues,
      supportedArtifactTypes,
      turnResults: buildTurnPreflightResults(
        selected.productTurnIds,
        turnOrdinalByProductTurnId,
        sanitizedBlockingIssues.issues,
        sanitizedWarnings.issues,
        sanitizedDeferred.issues,
      ).map((result) => ({
        ...result,
        rowBudget: {
          count: registeredProjection.rows.filter(
            (row) =>
              row.productTurnId ===
              registeredProjection.selectedProductTurnIds[
                selected.productTurnIds.indexOf(result.productTurnId)
              ],
          ).length,
          limit: capabilities.max_rows,
        },
      })),
    };
  }

  getPreview(shareCode: string) {
    return this.client.getPreview(shareCode);
  }

  getContinuation(input: { shareCode: string; clientRequestId: string }) {
    return this.client.getContinuation(input.shareCode, {
      schema_version: 1,
      client_request_id: input.clientRequestId,
    });
  }

  /** Internal Host attachment facade: reuse the same business service and replace only the trusted Agent scope for V4 Rows/File queries. */
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService {
    return {
      getCapabilities: () => this.getCapabilities(),
      preflight: async (input) => {
        try {
          return await this.preflightWithAgent(input, agentService);
        } catch (error) {
          throw normalizeConversationShareConnectionError(error);
        }
      },
      publish: (input, operationId) => this.publishWithAgent(input, operationId, agentService),
      onDynamicPublishProgress: (operationId) => this.onDynamicPublishProgress(operationId),
      importShare: (input, operationId) => this.importShare(input, operationId),
      onDynamicImportProgress: (operationId) => this.onDynamicImportProgress(operationId),
      getImportedConversation: (input) => this.getImportedConversation(input),
      getPreview: (shareCode) => this.getPreview(shareCode),
      getContinuation: (input) => this.getContinuation(input),
    };
  }

  onDynamicPublishProgress(operationId: string) {
    return this.getProgressEmitter(operationId).event;
  }

  onDynamicImportProgress(operationId: string) {
    return this.getImportProgressEmitter(operationId).event;
  }

  /**
   * Download one artifact's bytes with a per-request timeout (including body reads) and a Content-Length preflight check.
   *
   * The download fallback cannot use bare fetch without an AbortSignal, and size/SHA-256 checks cannot
   * wait until after arrayBuffer(). A stalled connection could leave import stuck in downloading
   * indefinitely (undici's default timeout is about 300 seconds), and compromised storage could make
   * the client read an oversized payload into memory before detecting a mismatch. Treat timeouts as
   * network failures. If Content-Length exceeds manifest size_bytes, fail integrity and abort before
   * reading the body; checking integrity only after an unbounded download protects correctness but not
   * client resources.
   */
  private async downloadArtifactBytes(
    artifact: ConversationShareContinuation["artifacts"][number],
  ): Promise<{ bytes: Uint8Array; responseMimeType?: string }> {
    const artifactIssue = (
      code: ConversationShareFailureIssue["code"],
      extra?: { actual?: number; limit?: number },
    ): ConversationShareFailureIssue => ({
      code,
      scope: "artifact",
      artifactDisplayName: artifact.display_name,
      artifactType: artifact.artifact_type,
      extension: artifact.extension,
      mimeType: artifact.mime_type,
      phase: "downloading",
      ...(extra?.actual === undefined ? {} : { actual: extra.actual }),
      ...(extra?.limit === undefined ? {} : { limit: extra.limit }),
    });
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const response = await this.download(artifact.download_url, { signal: controller.signal });
      if (!response.ok) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download failed",
          { issues: [artifactIssue("unknown")] },
        );
      }
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > artifact.size_bytes) {
        // The body cannot pass validation, so abort the connection before throwing instead of reading
        // an oversized response into memory.
        controller.abort();
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact integrity check failed",
          {
            issues: [
              artifactIssue("artifact_changed", {
                actual: declaredBytes,
                limit: artifact.size_bytes,
              }),
            ],
          },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const responseMimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      return { bytes, responseMimeType };
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ConversationShareServiceError)) {
        throw new ConversationShareServiceError(
          "network",
          "Conversation artifact download timed out",
          {
            issues: [artifactIssue("unknown")],
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    await this.completedImportsLoaded;
    const workspaceKey = workspaceKeyOf(input.targetWorkspacePath, input.targetWorkspaceIdentity);
    const workspaceKeyedShare = importDedupeKey(input.shareCode, workspaceKey);
    const key = `${workspaceKeyedShare}\u0000${input.clientRequestId}`;
    const completed =
      this.completedImports.get(key) ?? this.completedImportsByWorkspace.get(workspaceKeyedShare);
    if (completed) {
      this.logger.info(undefined, "conversation share import reused", {
        operationId,
        phase: "complete",
      });
      return { ...completed, reused: true };
    }
    const inFlight =
      this.inFlightImports.get(key) ?? this.inFlightImportsByWorkspace.get(workspaceKeyedShare);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.importShareInternal(input, operationId)
      .then((result) => {
        this.completedImports.set(key, result);
        this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
        return this.persistCompletedImportIndex()
          .catch(() => undefined)
          .then(() => result);
      })
      .finally(() => {
        this.inFlightImports.delete(key);
      });
    this.inFlightImports.set(key, promise);
    this.inFlightImportsByWorkspace.set(workspaceKeyedShare, promise);
    void promise.then(
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
      () => {
        if (this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise) {
          this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
        }
      },
    );
    return promise;
  }

  private async importShareInternal(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    if (!this.zcodeSessionService) {
      throwServiceError("feature_disabled", "Conversation share import is unavailable");
    }
    // ConversationShareHttpClient.getContinuation already rechecked both digests against the exact
    // values sent by the server. Do not recompute them from parsed data here: Zod strips unknown fields
    // by default, so adding an optional field on the publisher would make older clients calculate a
    // different hash and misreport an additive change as a share-file integrity failure.
    const continuation = await this.getContinuation(input);

    const remoteTarget =
      input.targetWorkspaceKind === "remote" || Boolean(input.targetWorkspaceIdentity);
    const workspacePath =
      input.targetWorkspacePath && !remoteTarget
        ? input.targetWorkspacePath
        : this.conversationWorkspaceRoot;
    const workspaceIdentity =
      input.targetWorkspaceIdentity && !remoteTarget ? input.targetWorkspaceIdentity : undefined;
    const shareRoot = join(workspacePath, ".zcode-share");
    const importRoot = join(shareRoot, sanitizeFileSegment(continuation.share.share_id));
    const markerPath = join(importRoot, ".zcode-share-import.json");
    const stagingPath = join(importRoot, ".share-import-staging");
    const finalArtifactsPath = join(importRoot, "shared-artifacts");
    const conversationPath = join(importRoot, "shared-conversation.json");
    const importId = randomUUID();
    const contextId = `shared-context-${randomUUID()}`;
    const sessionId = `share-import-${randomUUID()}`;
    // This URL is stored in durable provenance and the sharedContextImport snapshot, while
    // sharedContextImportV2StateSchema accepts only the canonical /cn/share/<code> form. Durable
    // records must not store a value that changes with the UI language, or it will be stale if the user
    // later changes languages. Localize only for display.
    const shareUrl = `${this.shareWebUrl}/${encodeURIComponent(input.shareCode)}`;
    await mkdir(shareRoot, { recursive: true });
    try {
      const existingMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        existingMarker.shareCode === input.shareCode &&
        typeof existingMarker.sessionId === "string" &&
        existingMarker.sessionId.startsWith("share-import-")
      ) {
        const sessions = await this.zcodeSessionService.listSessions({ workspacePath, limit: 100 });
        const existingSession = sessions.find(
          (item) => item.sessionId === existingMarker.sessionId,
        );
        if (
          existingSession &&
          typeof existingMarker.contextId === "string" &&
          typeof existingMarker.shareUrl === "string"
        ) {
          return {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            sessionId: existingSession.sessionId,
            contextId: existingMarker.contextId,
            shareUrl: existingMarker.shareUrl,
            title: existingSession.title,
            reused: true,
          };
        }
        await rm(importRoot, { recursive: true, force: true });
      }
    } catch {
      // Continue creating when the marker is missing or incomplete; directories not owned by this share
      // will not be deleted.
    }
    // This tracks whether importRoot may still be deleted on failure, not whether this code created it.
    // Disarm it once the session is committed (see immediately after createSession below).
    let importRootCleanupArmed = false;
    try {
      await mkdir(importRoot);
      importRootCleanupArmed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throwServiceError("unknown", "Conversation share import is already in progress");
      }
      throw error;
    }
    try {
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "preparing",
          createdAt: this.now(),
        }),
        "utf8",
      );
    } catch (error) {
      await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await mkdir(stagingPath);
      const installedArtifacts: Array<{
        artifactId: string;
        workspaceRelativePath: string;
        displayName: string;
        mimeType: string;
        sha256: string;
      }> = [];
      const usedNames = new Set<string>();
      let completedArtifacts = 0;
      this.reportImportProgress(operationId, "downloading", 0, continuation.artifacts.length);
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "downloading",
          createdAt: this.now(),
        }),
        "utf8",
      );
      for (const artifact of continuation.artifacts) {
        const { bytes, responseMimeType } = await this.downloadArtifactBytes(artifact);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== artifact.size_bytes || sha256 !== artifact.sha256) {
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Conversation artifact integrity check failed",
            {
              issues: [
                {
                  code: "artifact_changed",
                  scope: "artifact",
                  artifactDisplayName: artifact.display_name,
                  artifactType: artifact.artifact_type,
                  extension: artifact.extension,
                  mimeType: artifact.mime_type,
                  actual: bytes.byteLength,
                  limit: artifact.size_bytes,
                  phase: "downloading",
                },
              ],
            },
          );
        }
        // A content-type mismatch cannot directly make the contract invalid, or every .md import could
        // fail: object storage/CDNs label downloads according to their own rules (often text/plain or
        // application/octet-stream for .md), independently of the mime_type used when publishing.
        //
        // By this point, bytes have passed size and SHA-256 checks, and artifact_set_sha256 covers the
        // manifest itself. artifact.mime_type is therefore authoritative; the response header provides
        // no additional integrity guarantee. Using it as a gate would cause false rejections, so record
        // the mismatch without blocking.
        if (
          responseMimeType &&
          responseMimeType.toLowerCase() !== artifact.mime_type.toLowerCase()
        ) {
          this.logger.info(undefined, "conversation share artifact content-type differs", {
            artifactType: artifact.artifact_type,
            extension: artifact.extension,
            expectedMimeType: artifact.mime_type,
            responseMimeType,
          });
        }
        const fileName = uniqueImportedFileName(
          artifact.display_name,
          artifact.artifact_id,
          usedNames,
        );
        await writeFile(join(stagingPath, fileName), bytes);
        installedArtifacts.push({
          artifactId: artifact.artifact_id,
          workspaceRelativePath: `.zcode-share/${sanitizeFileSegment(continuation.share.share_id)}/shared-artifacts/${fileName}`,
          displayName: artifact.display_name,
          mimeType: artifact.mime_type,
          sha256: artifact.sha256,
        });
        completedArtifacts += 1;
        this.reportImportProgress(
          operationId,
          "downloading",
          completedArtifacts,
          continuation.artifacts.length,
        );
      }
      this.reportImportProgress(
        operationId,
        "installing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "installing",
          createdAt: this.now(),
        }),
        "utf8",
      );
      await rename(stagingPath, finalArtifactsPath);
      // Read-only blocks must remain available offline indefinitely. A share may expire or not yet be
      // online, so rendering cannot fetch it remotely. Store public rows alongside artifact metadata in
      // importRoot, where failure cleanup removes both together.
      //
      // Store rawRows rather than parsed output so rows and fields this version does not recognize are
      // preserved and can become visible after the user upgrades, instead of being permanently lost
      // because the import used an older version.
      await writeFile(
        conversationPath,
        JSON.stringify({
          formatVersion: IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION,
          shareId: continuation.share.share_id,
          contextId,
          title: continuation.share.title,
          rows: continuation.rawRows,
          ...(continuation.content_blocks ? { content_blocks: continuation.content_blocks } : {}),
          artifacts: continuation.artifacts.map((artifact) => ({
            artifactId: artifact.artifact_id,
            displayName: artifact.display_name,
            mimeType: artifact.mime_type,
            workspaceRelativePath: installedArtifacts.find(
              (installed) => installed.artifactId === artifact.artifact_id,
            )?.workspaceRelativePath,
          })),
        }),
        "utf8",
      );
      const context = formatSharedContextV1({
        share: { shareId: continuation.share.share_id, title: continuation.share.title },
        rows: continuation.rows,
        installedArtifacts,
      });
      if (context.unsupportedKinds.length > 0) {
        // Content is missing from model-side shared_context. Do not block import, but record it.
        this.logger.info(undefined, "shared context skipped row kinds this build cannot format", {
          kinds: context.unsupportedKinds,
        });
      }
      this.reportImportProgress(
        operationId,
        "committing",
        completedArtifacts,
        continuation.artifacts.length,
      );
      await writeFile(
        markerPath,
        JSON.stringify({
          importId,
          shareCode: input.shareCode,
          clientRequestId: input.clientRequestId,
          sessionId,
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
          phase: "committing",
          createdAt: this.now(),
        }),
        "utf8",
      );
      const snapshot = await this.zcodeSessionService.createSession({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
        persistence: "immediate",
        importedHistory: {
          source: "sharedContext",
          // Prefix the session title so imported sessions are easy to identify in the task list. The UI
          // does not read sharedContextImport.title (it reads only contextId/status/shareUrl), so this
          // prefix does not affect display. The CLI already writes importedHistory.title to session.title.
          title: formatImportedShareSessionTitle(continuation.share.title, input.locale),
          markdown: context.markdown,
          provenance: {
            shareId: continuation.share.share_id,
            contextId,
            shareUrl,
            status: "pending",
            projectionSha256: continuation.integrity.projection_sha256,
            artifactSetSha256: continuation.integrity.artifact_set_sha256,
            formatterVersion: 1,
            markdownSha256: context.markdownSha256,
            installedArtifacts: installedArtifacts.map((artifact) => ({
              artifactId: artifact.artifactId,
              workspaceRelativePath: artifact.workspaceRelativePath,
            })),
          },
        },
      });
      // The session is committed and its provenance points to artifacts installed in importRoot. If
      // marker cleanup or progress reporting throws after this point, the old catch would remove
      // importRoot and leave the user with a session referencing missing files. Limit failure cleanup
      // to before createSession, so disarm it immediately here. The marker is only a trace file; failure
      // to delete it must not fail the import.
      importRootCleanupArmed = false;
      await rm(markerPath, { force: true }).catch(() => undefined);
      this.reportImportProgress(
        operationId,
        "complete",
        completedArtifacts,
        continuation.artifacts.length,
      );
      return {
        workspacePath,
        workspaceIdentity,
        sessionId: snapshot.session.sessionId,
        contextId,
        shareUrl,
        title: continuation.share.title,
        reused: false,
        ...(remoteTarget
          ? { fallbackReason: "remote_workspace" as const }
          : input.targetWorkspacePath
            ? {}
            : { fallbackReason: "default_workspace" as const }),
      };
    } catch (error) {
      // Imports now live in an existing workspace, so deleting the workspace root could damage the
      // user's project. Failure cleanup may touch only the subdirectory owned by this import.
      if (importRootCleanupArmed) {
        await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Recover the public rows saved during import by contextId.
   *
   * Directory names use share_id, which is not equivalent to contextId. Scan each importRoot under
   * .zcode-share/ and compare its stored contextId; this avoids a separate index and keeps older imports
   * readable. Disk content crosses a storage boundary, so validate it with a schema before passing it
   * to the renderer.
   */
  async getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null> {
    const shareRoot = join(input.workspacePath, ".zcode-share");
    let entries: Dirent[];
    try {
      entries = await readdir(shareRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(join(shareRoot, entry.name, "shared-conversation.json"), "utf8"),
        );
      } catch {
        continue;
      }
      const validated = importedConversationShareFileSchema.safeParse(parsed);
      if (!validated.success || validated.data.contextId !== input.contextId) continue;
      const decoded = decodeConversationShareRows(validated.data.rows);
      // If formatVersion is newer than this client (for example, the user imported with a newer build
      // and then downgraded), count unrecognized rows in unsupportedRowCount and show a soft UI warning
      // instead of silently omitting content.
      const unsupportedRowCount =
        decoded.unsupportedCount +
        (validated.data.formatVersion > IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION ? 1 : 0);
      if (unsupportedRowCount > 0) {
        this.logger.info(
          undefined,
          "imported conversation share has content this build can't read",
          {
            formatVersion: validated.data.formatVersion,
            kinds: decoded.unsupportedKinds,
            droppedCount: decoded.unsupportedCount,
            keptCount: decoded.rows.length,
          },
        );
      }
      return {
        shareId: validated.data.shareId,
        contextId: validated.data.contextId,
        title: validated.data.title,
        rows: decoded.rows,
        contentBlocks: validated.data.content_blocks,
        artifacts: validated.data.artifacts,
        unsupportedRowCount,
      };
    }
    return null;
  }

  private async loadCompletedImportIndex(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.importIndexPath, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<ImportConversationShareResult>;
      if (
        typeof record.workspacePath !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.title !== "string" ||
        typeof record.contextId !== "string" ||
        typeof record.shareUrl !== "string"
      ) {
        continue;
      }
      try {
        if (!(await stat(record.workspacePath)).isDirectory()) continue;
      } catch {
        continue;
      }
      const keyParts = key.split("\u0000");
      const shareCode = keyParts[0]!;
      const workspaceKey =
        keyParts[1] ?? workspaceKeyOf(record.workspacePath, record.workspaceIdentity);
      const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
      const result: ImportConversationShareResult = {
        workspacePath: record.workspacePath,
        ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
        sessionId: record.sessionId,
        contextId: record.contextId,
        shareUrl: record.shareUrl,
        title: record.title,
        reused: true,
      };
      this.completedImports.set(key, result);
      this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
    }
  }

  private async writeCompletedImportIndexOnce(): Promise<void> {
    const data = Object.fromEntries(this.completedImports.entries());
    const temporaryPath = `${this.importIndexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(data), "utf8");
      await rename(temporaryPath, this.importIndexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private persistCompletedImportIndex(): Promise<void> {
    // The chain previously had no catch, so the first write failure left importIndexWriteChain
    // permanently rejected. Every later persist became a silent no-op (call sites also swallowed errors
    // with .catch(() => undefined)). Without the index there is no recovery source because the marker is
    // deleted on success; importing the same share again then hits mkdir EEXIST and reports "already in
    // progress" forever. Keep the stored chain resolved and use it only for serialization; leave the
    // returned promise observable so each caller decides whether to swallow that write's failure.
    const run = this.importIndexWriteChain
      .catch(() => undefined)
      .then(() => this.writeCompletedImportIndexOnce());
    this.importIndexWriteChain = run.catch(() => undefined);
    return run;
  }

  async publish(input: PublishTextConversationInput, operationId: string) {
    return this.publishWithAgent(input, operationId, this.zcodeAgentService);
  }

  private async publishWithAgent(
    input: PublishTextConversationInput,
    operationId: string,
    agentService: ConversationShareAgentService,
  ) {
    this.logger.info(undefined, "conversation share publish started", {
      operationId,
      accessMode: input.accessMode,
      selectionKind: input.selection.kind,
      remoteWorkspace: Boolean(input.workspaceIdentity || input.remoteSessionId),
    });
    try {
      const result = await this.publishInternal(input, operationId, agentService);
      this.logger.info(undefined, "conversation share publish completed", {
        operationId,
        phase: "complete",
      });
      // Successful publishing ends this share, so no consumer needs its preflight snapshots. Clear them
      // immediately; otherwise a long-lived desktop host would accumulate workspace/session/turn
      // entries without bound.
      this.clearPreviewPreflightSnapshots(input);
      return result;
    } catch (rawError) {
      const error = normalizeConversationShareConnectionError(rawError);
      const record =
        error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
      this.logger.warn(undefined, "conversation share publish failed", {
        operationId,
        phase: this.publishPhases.get(operationId) ?? "collecting",
        kind: typeof record?.kind === "string" ? record.kind : "unknown",
        ...(typeof record?.reasonCode === "string" ? { reasonCode: record.reasonCode } : {}),
        ...(record?.diagnostics && typeof record.diagnostics === "object"
          ? { diagnostics: record.diagnostics }
          : {}),
        ...(typeof record?.status === "number" ? { status: record.status } : {}),
        ...(typeof record?.code === "number" ? { code: record.code } : {}),
        ...(typeof record?.requestId === "string" ? { requestId: record.requestId } : {}),
        ...(error instanceof ConversationShareClientError && error.details?.clientRequestId
          ? { clientRequestId: error.details.clientRequestId }
          : {}),
        errorName:
          typeof record?.name === "string"
            ? record.name
            : error instanceof Error
              ? error.name
              : "UnknownError",
      });
      throw error;
    } finally {
      this.publishPhases.delete(operationId);
    }
  }

  private async publishInternal(
    input: PublishTextConversationInput,
    operationId?: string,
    agentService: ConversationShareAgentService = this.zcodeAgentService,
  ): Promise<ConversationShareRecord> {
    const report = (
      phase: ConversationSharePublishProgress["phase"],
      completedArtifacts = 0,
      totalArtifacts = 0,
      warnings?: {
        issues: readonly ConversationShareFailureIssue[];
        issueCount: number;
        omittedIssueCount: number;
      },
    ) => {
      if (!operationId) return;
      this.publishPhases.set(operationId, phase);
      this.logger.info(undefined, "conversation share publish phase changed", {
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings ? { warningCount: warnings.issueCount } : {}),
      });
      this.getProgressEmitter(operationId).fire({
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings
          ? { warnings: warnings.issues, omittedWarningCount: warnings.omittedIssueCount }
          : {}),
      });
    };
    report("collecting");
    if (!input.title.trim() || !input.clientRequestId.trim()) {
      throwServiceError("invalid_contract", "Share title and request identity are required");
    }
    if (!Number.isSafeInteger(input.disclosureAcceptedAt) || input.disclosureAcceptedAt <= 0) {
      throwServiceError("disclosure_required", "Explicit disclosure confirmation is required");
    }
    if (input.selection.kind === "rowAnchors" && input.selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }

    const capabilities = await this.client.getCapabilities();
    if (!capabilities.access_modes.includes(input.accessMode)) {
      throwServiceError("feature_disabled", "Requested share access mode is unavailable");
    }

    const conversation = await this.loadAllRows(input, agentService);
    const selected = selectRows(conversation.rows, input.selection);
    // Downgrade finalized structures that cannot be represented publicly by removing fields or dropping
    // whole rows and emitting non-blocking warnings. All later projections and artifact discovery use
    // these sanitized rows.
    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurn(conversation.rows),
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: this.now(),
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurn(conversation.rows).get(draft.productTurnId),
              },
            ]
          : [],
    );
    const publishWarnings: ConversationShareFailureIssue[] = [
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    ];
    // Fix reason: the public projection previously stopped at the first unsupported structure, leaving users
    // unable to know which other turns they may need to deselect. Now preflight the entire selected group and
    // return sanitized issues so the UI can offer an actionable suggestion for each one.
    const structureIssues = collectShareStructureIssues(selectedRows, conversation.rows);
    if (structureIssues.length > 0) {
      const structureKind = structureIssues.some(
        (issue) => issue.code === "artifact_protocol_not_ready",
      )
        ? "artifact_protocol_not_ready"
        : structureIssues.some((issue) => issue.code === "unsafe_url")
          ? "unsafe_structure"
          : "invalid_conversation";
      throw new ConversationShareServiceError(
        structureKind,
        "Selected conversation contains unsupported structure",
        { issues: structureIssues },
      );
    }
    // The local runtime projection contains subagent details and write-state IDs, which backend V1
    // rejects with 3205. Build a separate public projection before confirmation; do not send selected
    // local rows directly.
    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
    this.validateArtifactManifest(capabilities, registeredProjection.artifacts);
    const preflightPreviewSnapshots = new Map<string, ConversationSharePreviewPreflightSnapshot>();
    for (const productTurnId of selected.productTurnIds) {
      const snapshot = this.previewPreflightSnapshots.get(
        previewPreflightKey(input, productTurnId),
      );
      if (snapshot) preflightPreviewSnapshots.set(productTurnId, snapshot);
    }
    const artifactSnapshot = await buildConversationShareArtifactSnapshot({
      zcodeAgentService: agentService,
      artifactSource: this.artifactSource,
      input,
      selectedRows,
      registeredArtifacts: registeredProjection.artifacts,
      inlineBytesBySourceRef: new Map([
        ...inlineImages.bytesBySourceRef,
        ...workflowSnapshot.bytes,
      ]),
      capabilities,
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      turnOrdinalByProductTurnId: turnOrdinalByProductTurn(conversation.rows),
      preflightPreviewSnapshots,
      currentCapabilitiesFingerprint: capabilitiesFingerprint(capabilities),
    });
    if (artifactSnapshot.issues.length > 0) {
      throw new ConversationShareServiceError(
        "artifact_not_allowed",
        "Conversation result artifacts are not allowed by server capabilities",
        { issues: artifactSnapshot.issues },
      );
    }
    if (artifactSnapshot.warnings.length > 0) {
      publishWarnings.push(...artifactSnapshot.warnings);
    }
    if (publishWarnings.length > 0) {
      // Non-blocking: publishing continues when a referenced file or user-input attachment cannot be
      // materialized, but tell the sharer which real files were omitted from the link. Internal markers
      // have been removed and inline images converted to artifacts.
      report("collecting", 0, 0, sanitizeConversationShareIssues(publishWarnings));
    }
    const publicProjection = buildConversationSharePublicProjection({
      rows: artifactSnapshot.rows,
      selectedProductTurnIds: selected.productTurnIds,
      additionalArtifacts: artifactSnapshot.additionalArtifacts,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
      ...(supportsConversationShareContent(capabilities)
        ? { contentDrafts: workflowSnapshot.drafts }
        : {}),
    });
    this.validateArtifactManifest(capabilities, publicProjection.artifacts);
    if (publicProjection.rows.length > capabilities.max_rows) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation contains too many rows to share",
        {
          issues: [
            {
              code: "rows_limit",
              scope: "conversation",
              actual: publicProjection.rows.length,
              limit: capabilities.max_rows,
            },
          ],
        },
      );
    }

    const confirmRequest = buildConversationShareConfirmRequest({
      selected_product_turn_ids: publicProjection.selectedProductTurnIds,
      projection: {
        rows: publicProjection.rows,
        ...(publicProjection.contentBlocks
          ? { content_blocks: publicProjection.contentBlocks }
          : {}),
      },
      artifacts: publicProjection.artifacts.map((artifact) => artifact.descriptor),
      disclosure_confirmation: {
        version: 1,
        accepted_at: input.disclosureAcceptedAt,
        acknowledged_no_secret_detection: true,
      },
    });
    if (
      Buffer.byteLength(JSON.stringify(confirmRequest), "utf8") > capabilities.max_payload_bytes
    ) {
      const actualBytes = Buffer.byteLength(JSON.stringify(confirmRequest), "utf8");
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation share payload is too large",
        {
          issues: [
            {
              code: "payload_size_limit",
              scope: "conversation",
              actual: actualBytes,
              limit: capabilities.max_payload_bytes,
            },
          ],
        },
      );
    }

    const payloadSha256 = sha256ConversationShareJson(confirmRequest);
    const preparation = await this.client.createPreparation({
      client_request_id: input.clientRequestId,
      title: input.title.trim(),
      schema_version: 1,
      access_mode: input.accessMode,
      payload_sha256: payloadSha256,
      artifact_count: publicProjection.artifacts.length,
    });
    if (preparation.status === "confirmed") {
      report("complete", publicProjection.artifacts.length, publicProjection.artifacts.length);
      return localizePublishedShare(preparation.share, input.locale);
    }
    report("uploading", 0, publicProjection.artifacts.length);
    let uploadedArtifacts = 0;
    for (const artifact of publicProjection.artifacts) {
      const bytes = artifactSnapshot.bytesBySourceRef.get(artifact.sourceRef);
      if (!bytes) {
        throwServiceError(
          "invalid_conversation",
          "Conversation artifact bytes are missing from the publication snapshot",
        );
      }
      const upload = await this.client.uploadArtifact(
        preparation.preparation_id,
        artifact.descriptor,
        new Blob([Uint8Array.from(bytes).buffer], {
          type: artifact.descriptor.mime_type,
        }),
      );
      if (
        upload.artifact_id !== artifact.descriptor.artifact_id ||
        upload.size_bytes !== artifact.descriptor.size_bytes ||
        upload.sha256 !== artifact.descriptor.sha256
      ) {
        throw new ConversationShareServiceError(
          "upload_incomplete",
          "Conversation artifact upload acknowledgement does not match the manifest",
          {
            issues: [
              {
                code: "upload_incomplete",
                scope: "artifact",
                artifactDisplayName: artifact.descriptor.display_name,
                artifactType: artifact.descriptor.artifact_type,
                extension: artifact.descriptor.extension,
                mimeType: artifact.descriptor.mime_type,
                actual: upload.size_bytes,
                limit: artifact.descriptor.size_bytes,
              },
            ],
          },
        );
      }
      uploadedArtifacts += 1;
      report("uploading", uploadedArtifacts, publicProjection.artifacts.length);
    }
    report("checking", uploadedArtifacts, publicProjection.artifacts.length);
    const share = await this.confirmUntilReady(preparation.preparation_id, confirmRequest);
    report("complete", uploadedArtifacts, publicProjection.artifacts.length);
    // The server does not currently accept locale, so rewrite the returned link to the site matching
    // the UI language. localizeConversationShareUrl recognizes only known share-path forms and preserves
    // all other forms unchanged.
    return localizePublishedShare(share, input.locale);
  }

  private getProgressEmitter(operationId: string): Emitter<ConversationSharePublishProgress> {
    const existing = this.progressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationSharePublishProgress>({
      onDidRemoveLastListener: () => {
        this.progressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.progressEmitters.set(operationId, emitter);
    return emitter;
  }

  private getImportProgressEmitter(operationId: string): Emitter<ConversationShareImportProgress> {
    const existing = this.importProgressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationShareImportProgress>({
      onDidRemoveLastListener: () => {
        this.importProgressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.importProgressEmitters.set(operationId, emitter);
    return emitter;
  }

  private reportImportProgress(
    operationId: string,
    phase: ConversationShareImportProgress["phase"],
    completedArtifacts: number,
    totalArtifacts: number,
  ) {
    this.getImportProgressEmitter(operationId).fire({
      operationId,
      phase,
      completedArtifacts,
      totalArtifacts,
    });
  }

  private async cleanupAbandonedImports(): Promise<void> {
    if (!this.zcodeSessionService) return;
    await this.completedImportsLoaded;
    // Scan only import-owned subdirectories in the default conversation workspace. Handle markers in
    // other workspaces on the next import request with a target, avoiding enumeration and access to
    // user project directories at startup.
    const shareRoot = join(this.conversationWorkspaceRoot, ".zcode-share");
    const imports = await readdir(shareRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of imports) {
      if (!entry.isDirectory()) continue;
      const importRoot = join(shareRoot, entry.name);
      const markerPath = join(importRoot, ".zcode-share-import.json");
      let marker: {
        sessionId?: unknown;
        shareCode?: unknown;
        clientRequestId?: unknown;
        workspaceKey?: unknown;
        contextId?: unknown;
        shareUrl?: unknown;
      };
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
      } catch {
        continue;
      }
      if (typeof marker.sessionId !== "string" || !marker.sessionId.startsWith("share-import-"))
        continue;
      try {
        const sessions = await this.zcodeSessionService.listSessions({
          workspacePath: this.conversationWorkspaceRoot,
          limit: 100,
        });
        const session = sessions.find((item) => item.sessionId === marker.sessionId);
        if (session) {
          if (
            typeof marker.shareCode === "string" &&
            typeof marker.clientRequestId === "string" &&
            typeof marker.contextId === "string" &&
            typeof marker.shareUrl === "string"
          ) {
            const workspaceKeyedShare = importDedupeKey(
              marker.shareCode,
              typeof marker.workspaceKey === "string"
                ? marker.workspaceKey
                : this.conversationWorkspaceRoot,
            );
            const result: ImportConversationShareResult = {
              workspacePath: this.conversationWorkspaceRoot,
              sessionId: session.sessionId,
              contextId: marker.contextId,
              shareUrl: marker.shareUrl,
              title: session.title,
              reused: true,
            };
            this.completedImports.set(
              `${workspaceKeyedShare}\u0000${marker.clientRequestId}`,
              result,
            );
            this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
            await this.persistCompletedImportIndex().catch(() => undefined);
          }
          await rm(markerPath, { force: true });
        } else {
          // Delete only this importRoot when it has a valid marker and no matching session.
          await rm(importRoot, { recursive: true, force: true });
        }
      } catch {
        // If the session state cannot be verified, keep importRoot; do not turn a transient error into
        // data deletion.
      }
    }
  }

  private collectArtifactManifestIssues(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): ConversationShareFailureIssue[] {
    const artifactIds = new Set<string>();
    const issues: ConversationShareFailureIssue[] = [];
    if (artifacts.length > capabilities.max_artifact_count) {
      issues.push({
        code: "artifact_count_limit",
        scope: "conversation",
        actual: artifacts.length,
        limit: capabilities.max_artifact_count,
      });
    }
    let declaredTotalBytes = 0;
    for (const { descriptor } of artifacts) {
      if (artifactIds.has(descriptor.artifact_id)) {
        issues.push({
          code: "artifact_manifest",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
        });
        continue;
      }
      artifactIds.add(descriptor.artifact_id);
      declaredTotalBytes += descriptor.size_bytes;
      if (descriptor.size_bytes > capabilities.max_artifact_bytes) {
        issues.push({
          code: "artifact_size_limit",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          actual: descriptor.size_bytes,
          limit: capabilities.max_artifact_bytes,
        });
      }
      const allowed = capabilities.allowed_artifacts.some(
        (candidate) =>
          candidate.type === descriptor.artifact_type &&
          candidate.extensions.some(
            (extension) => extension.replace(/^\./u, "").toLowerCase() === descriptor.extension,
          ) &&
          candidate.mime_types.some(
            (mimeType) => mimeType.toLowerCase() === descriptor.mime_type.toLowerCase(),
          ),
      );
      if (!allowed) {
        issues.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          allowedFormats: allowedFormatLabels(capabilities),
          allowedArtifacts: allowedArtifactSummaries(capabilities),
        });
      }
    }
    if (declaredTotalBytes > capabilities.max_total_artifact_bytes) {
      issues.push({
        code: "artifact_total_size_limit",
        scope: "conversation",
        actual: declaredTotalBytes,
        limit: capabilities.max_total_artifact_bytes,
      });
    }
    return issues;
  }

  private validateArtifactManifest(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): void {
    const issues = this.collectArtifactManifestIssues(capabilities, artifacts);
    if (issues.length > 0) {
      const hasTypeIssue = issues.some((issue) => issue.code === "artifact_type_not_allowed");
      throw new ConversationShareServiceError(
        hasTypeIssue ? "artifact_not_allowed" : "limit_exceeded",
        "Conversation artifacts cannot be shared",
        { issues },
      );
    }
  }

  private async confirmUntilReady(
    preparationId: string,
    request: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
    let deadline: number | undefined;
    let lastRequestId: string | undefined;
    let lastStatus: number | undefined;
    let lastCode: number | undefined;
    while (true) {
      try {
        return await this.client.confirm(preparationId, request);
      } catch (error) {
        if (
          !(error instanceof ConversationShareClientError) ||
          error.kind !== "safety_check_pending"
        ) {
          throw error;
        }
        lastRequestId = error.requestId ?? lastRequestId;
        lastStatus = error.status ?? lastStatus;
        lastCode = error.code ?? lastCode;

        // 3215 is a non-terminal backend safety check. Retry serially with the same preparation/DTO;
        // do not prepare again or wait indefinitely.
        const currentTime = this.now();
        deadline ??= currentTime + this.confirmPollTimeoutMs;
        const remainingMs = deadline - currentTime;
        if (remainingMs <= 0) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
        const requestedDelayMs = error.retryAfterMs ?? this.confirmPollIntervalMs;
        await this.sleep(Math.min(requestedDelayMs, remainingMs));
        if (this.now() >= deadline) {
          throw new ConversationShareServiceError(
            "safety_check_timeout",
            "Conversation share safety check timed out",
            {
              ...(lastRequestId === undefined ? {} : { requestId: lastRequestId }),
              ...(lastStatus === undefined ? {} : { status: lastStatus }),
              ...(lastCode === undefined ? {} : { code: lastCode }),
            },
          );
        }
      }
    }
  }

  private async loadAllRows(
    input: Pick<
      PublishTextConversationInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationRowsRead> {
    const pages: ConversationRow[][] = [];
    let beforeRowId: number | undefined;
    let logEpoch: string | undefined;
    let revision: number | undefined;

    while (true) {
      const result = await agentService.conversationRowsRangeV4({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
        sessionId: input.sessionId,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      });
      if (
        (logEpoch !== undefined && result.atLogEpoch !== logEpoch) ||
        (revision !== undefined && result.atRevision !== revision)
      ) {
        throwServiceError("invalid_conversation", "Conversation changed while preparing share");
      }
      logEpoch = result.atLogEpoch;
      revision = result.atRevision;
      pages.unshift(result.rows);
      if (!result.hasMore) break;
      const firstRowId = result.rows[0]?.rowId;
      if (firstRowId === undefined || firstRowId === beforeRowId) {
        throwServiceError("invalid_contract", "Conversation row pagination did not advance");
      }
      beforeRowId = firstRowId;
    }

    const rows = pages.flat();
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      if (previous.rowId >= current.rowId) {
        throwServiceError("invalid_contract", "Conversation rows are not globally ordered");
      }
    }
    if (logEpoch === undefined || revision === undefined) {
      throwServiceError("invalid_contract", "Conversation rows are missing a read watermark");
    }
    return { rows, revision, logEpoch };
  }
}
