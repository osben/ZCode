import type {
  ConversationShareFailureIssue,
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@zcode/services";
import { extractConversationPreviewFileReferences } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ConversationShareTurnFingerprintContext {
  capabilitiesFingerprint?: string;
  logEpoch?: string;
  productTurnId?: string;
  remoteSessionId?: string;
  revision?: number;
  sessionId?: string;
  workspaceKey?: string;
}

export function conversationShareTurnFingerprint(
  rows: readonly ConversationRow[],
  productTurnId: string,
  workspacePath = "",
  context: ConversationShareTurnFingerprintContext = {},
): string {
  const turnRows = rows.filter((row) => row.productTurnId === productTurnId);
  const assistantText = turnRows
    .filter((row): row is Extract<ConversationRow, { kind: "assistantText" }> => {
      return row.kind === "assistantText";
    })
    .map((row) => row.text)
    .join("\n\n");
  const candidateFingerprint = extractConversationPreviewFileReferences(
    assistantText,
    workspacePath,
  ).map((candidate) => ({
    kind: candidate.kind,
    path: candidate.path,
    start: candidate.start,
    end: candidate.end,
  }));
  const signature = turnRows.map((row) => ({
    rowId: row.rowId,
    kind: row.kind,
    state: "state" in row ? row.state : undefined,
    status: "status" in row ? row.status : undefined,
    text: "text" in row ? row.text : undefined,
    fileChanges: row.kind === "turnHeader" ? row.fileChanges : undefined,
    display: row.kind === "toolCall" ? row.display : undefined,
    attachments:
      row.kind === "userInput"
        ? row.attachments?.map((attachment) => ({
            ref: attachment.ref,
            fileName: attachment.fileName,
            mime: attachment.mime,
            bytes: attachment.bytes,
          }))
        : undefined,
  }));
  return hashString(
    JSON.stringify({
      scope: {
        workspaceKey: context.workspaceKey ?? workspacePath,
        remoteSessionId: context.remoteSessionId ?? "",
        sessionId: context.sessionId ?? "",
      },
      productTurnId: context.productTurnId ?? productTurnId,
      revision: context.revision,
      logEpoch: context.logEpoch,
      capabilitiesFingerprint: context.capabilitiesFingerprint,
      rows: signature,
      previewCandidates: candidateFingerprint,
    }),
  );
}

export function conversationSharePreflightCacheKey(
  scopeKey: string,
  productTurnId: string,
): string {
  return `${scopeKey}\u0000${productTurnId}`;
}

/**
 * When aggregating preflight results from multiple turns, remove duplicate global errors that cannot be located to a specific turn/file.
 * Preserve turn/file-level issues with their location fields so distinct issues the user must address are not merged.
 */
export function dedupeConversationShareIssues(
  issues: readonly ConversationShareFailureIssue[],
): ConversationShareFailureIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const hasLocator =
      issue.rowId !== undefined ||
      issue.turnOrdinal !== undefined ||
      issue.artifactDisplayName !== undefined;
    // Transport/conversation issues are global by nature; when turn/artifact issues have no location fields,
    // preserve them even if their content matches so multiple pending turns are not mistakenly merged into one.
    if (!hasLocator && issue.scope !== "transport" && issue.scope !== "conversation") {
      return true;
    }
    const key = JSON.stringify({
      code: issue.code,
      scope: issue.scope,
      rowId: issue.rowId,
      turnOrdinal: issue.turnOrdinal,
      artifactDisplayName: issue.artifactDisplayName,
      artifactType: issue.artifactType,
      extension: issue.extension,
      mimeType: issue.mimeType,
      actual: issue.actual,
      limit: issue.limit,
      retryAfterMs: issue.retryAfterMs,
      phase: issue.phase,
      allowedFormats: issue.allowedFormats,
      allowedArtifacts: issue.allowedArtifacts,
      availability: issue.availability,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Split one preflight result into cache entries keyed by turn.
 *
 * In dev, the host process does not restart when services are rebuilt, so an older host may return results without turnResults;
 * callers invoking `.map` directly throw, and a downstream catch reports “server-side preflight failed.” Degrade gracefully when the field is missing:
 * fall back to the overall issues when turn details are unavailable; coarser results are preferable to calling a successful preflight a failure.
 */
export function buildConversationSharePreflightCacheEntries(
  result: ConversationSharePreflightResult,
  productTurnIds: readonly string[],
  turnFingerprints: ReadonlyMap<string, string>,
): ConversationShareTurnPreflightResult[] {
  const entriesByProductTurnId = new Map(
    (Array.isArray(result.turnResults) ? result.turnResults : []).map((entry) => [
      entry.productTurnId,
      entry,
    ]),
  );
  return productTurnIds.map((productTurnId) => {
    const entry = entriesByProductTurnId.get(productTurnId);
    return {
      ...(entry ?? {
        blockingIssues: result.blockingIssues,
        skippableWarnings: result.skippableWarnings,
        deferredIssues: result.deferredIssues,
      }),
      productTurnId,
      turnFingerprint: turnFingerprints.get(productTurnId),
    };
  });
}

export function getMissingConversationSharePreflightTurnIds(
  scopeKey: string,
  selectedProductTurnIds: readonly string[],
  cache: ReadonlyMap<string, ConversationShareTurnPreflightResult>,
  turnFingerprints?: ReadonlyMap<string, string>,
): string[] {
  return selectedProductTurnIds.filter((productTurnId) => {
    const entry = cache.get(conversationSharePreflightCacheKey(scopeKey, productTurnId));
    return (
      entry === undefined ||
      (turnFingerprints !== undefined &&
        entry.turnFingerprint !== turnFingerprints.get(productTurnId))
    );
  });
}

/** The line limit applies to the entire selected set; recalculate after removing or adding turns instead of reusing a batch RPC total. */
export function aggregateConversationShareBlockingIssues(
  entries: readonly ConversationShareTurnPreflightResult[],
): ConversationShareFailureIssue[] {
  const issues = entries.flatMap((entry) => entry.blockingIssues);
  if (!entries.length || entries.some((entry) => !entry.rowBudget))
    return dedupeConversationShareIssues(issues);
  const actual = entries.reduce((count, entry) => count + entry.rowBudget!.count, 0);
  const limit = Math.min(...entries.map((entry) => entry.rowBudget!.limit));
  return dedupeConversationShareIssues([
    ...issues.filter((issue) => issue.code !== "rows_limit"),
    ...(actual > limit
      ? [{ code: "rows_limit" as const, scope: "conversation" as const, actual, limit }]
      : []),
  ]);
}
