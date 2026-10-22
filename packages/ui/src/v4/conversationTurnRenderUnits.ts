import type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
  ConversationTurnRenderUnitCache,
  ConversationTurnRenderUnitCacheEntry,
} from "@/v4/conversationTurnRenderUnitTypes.js";
export type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
  ConversationTurnRenderUnitCache,
} from "@/v4/conversationTurnRenderUnitTypes.js";
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import {
  isWorkflowLaunchUserInputRow,
  resolveWorkflowLaunchMeta,
} from "@/v4/workflowLaunchTurn.js";
import {
  buildConversationTurnWorkSegments,
  type ConversationTurnWorkStatus,
  resolveConversationTurnWorkDurationMs,
  resolveConversationTurnWorkStatus,
  withTurnOutputTokens,
} from "@/v4/conversationTurnWorkSegments.js";
import { markHighspeedOutputFooterUnits } from "@/highspeed/highspeedOutputFooter.js";

export type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
export { resolveNextHighspeedExpiryMs } from "@/highspeed/highspeedConversationRows.js";

interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isTimelineMarkerRow(row: ConversationRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker";
}

function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

function isVisibleAssistantWorkRow(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // reasoning_start/reasoning_end can create an empty terminal block; trim it only at the shared
    // render-unit boundary so completed state does not bypass the streaming renderer's empty-line filtering.
    return false;
  }
  // EnterPlanMode is only an internal mode-switch boundary. Treating it as an ordinary tool in "Worked"
  // would display a useless "Tool call executed" row. Filter it only in render units; do not rewrite the protocol projection,
  // preserving shared runtime and recovery semantics for desktop continuous and web remote replayable flows.
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  if (isUserInputRow(row)) return true;
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

// Lane placement is decided by the CLI projection; the UI must not infer it from the marker type.
// If lane is absent (should not happen), fall back to assistantWork so the row stays in the collapsed group instead of being lost.
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/** Artifact rows are appended to the tail by the sharing projection (insertDiscoveredArtifacts places them after the final row of this productTurn), but they are also AssistantWorkRow and become the final flow row. This invalidates the fallback rule that assumes the final row is assistantText: public projections prohibit actions, so the share page only has this fallback, and the final answer gets pulled into "Worked" with the whole turn expanded by default. Artifacts are appended output, not part of the conversation stream, so handle them as turn-tail content, like browserTurnEndRows screenshots. Do not switch to "take the last assistantText in flow": that could promote a CUA response from the middle of the turn as the final answer and split rows with the same assistantResponseId. */
function isTurnTrailingArtifactRow(row: AssistantWorkRow): boolean {
  return row.kind === "artifact";
}

function splitTurnTailRows(rows: readonly AssistantWorkRow[]): {
  flowRows: AssistantWorkRow[];
  tailRows: AssistantWorkRow[];
} {
  let tailStart = rows.length;
  while (
    tailStart > 0 &&
    (isTurnEndingTimelineMarkerRow(rows[tailStart - 1]!) ||
      isTurnTrailingArtifactRow(rows[tailStart - 1]!))
  ) {
    tailStart -= 1;
  }
  return {
    flowRows: rows.slice(0, tailStart),
    tailRows: rows.slice(tailStart),
  };
}

function isBrowserTurnEndRow(row: AssistantWorkRow): boolean {
  // Automatic screenshots are persisted after the final body as completed tool rows; the old grouping treated only
  // the timeline boundary as turn-tail content, moving screenshots into the "Worked" collapse above where they became invisible.
  return (
    row.kind === "toolCall" &&
    row.display?.kind === "node_repl_images" &&
    row.display.source === "browser_turn_end"
  );
}

function isLightBoundaryMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "lightBoundary";
}

function isCompletionBlockingWorkRowRunning(row: AssistantWorkRow): boolean {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.state === "streaming";
    case "toolCall":
      return (
        row.backgrounded !== true &&
        (row.status === "inputStreaming" ||
          row.status === "pendingApproval" ||
          row.status === "running")
      );
    case "subagent":
      return row.backgrounded !== true && row.status === "running";
    case "timelineMarker":
      return "status" in row.marker && row.marker.status === "running";
    default:
      return false;
  }
}

function resolveTurnRunning(
  draft: DraftTurnRenderUnit,
  options: BuildConversationTurnRenderUnitsOptions,
): boolean {
  if (draft.header) {
    if (draft.header.executionKind === "controlOnly") return false;
    // turnHeader is the projection's authoritative turn boundary; a terminal main turn must not be
    // pushed back to running because a background tool/subagent in the same turn is still running.
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // A cold snapshot may truncate turnHeader while retaining only the tail window; the old fallback would treat
    // an isolated inputStreaming/running tool row as thinking again, so terminal control state must take priority.
    return false;
  }
  // Compatibility only for old projections without turnHeader; background-only work does not block main-turn completion.
  return draft.assistantWorkRows.some(isCompletionBlockingWorkRowRunning);
}

function shouldForceOpenAbnormalHistory(
  header: TurnHeaderRow | undefined,
  sessionPhase: SessionPhase | undefined,
): boolean {
  if (header) {
    return header.state === "completedInterrupted" || header.state === "failed";
  }
  return sessionPhase === "completedInterrupted" || sessionPhase === "error";
}

function materializeDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const workflowLaunch = resolveWorkflowLaunchMeta(draft.header, draft.userInputs);
  // A launch turn is represented by its run card; its user row does not enter visible input or the stream.
  const renderedRows =
    workflowLaunch === undefined
      ? draft.orderedRows
      : draft.orderedRows.filter((row) => !isWorkflowLaunchUserInputRow(row));
  const visibleUserInputs = renderedRows.filter(isUserInputRow);
  const visibleAssistantWorkRows = draft.assistantWorkRows.filter(isVisibleAssistantWorkRow);
  const visibleOrderedRows = renderedRows.filter(isVisibleConversationRow);
  const timelineOnly =
    visibleUserInputs.length === 0 &&
    visibleAssistantWorkRows.length > 0 &&
    visibleAssistantWorkRows.every(isTimelineMarkerRow);

  // modelChange is a light boundary at the top of the turn, rendered before user input and excluded from work.
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser automatic screenshots must follow file-diff summaries as the final content block, so extract them first;
  // process all other rows in CLI order, splitting out only a contiguous suffix of actual turn-tail markers.
  const browserTurnEndRows: AssistantWorkRow[] = [];
  const nonBrowserRows: AssistantWorkRow[] = [];
  if (!timelineOnly) {
    for (const row of bodyRows) {
      if (isBrowserTurnEndRow(row)) {
        browserTurnEndRows.push(row);
      } else {
        nonBrowserRows.push(row);
      }
    }
  }
  // Do not use filter to extract every turnTailBoundary and force ExitPlanMode into the tail;
  // that would move plans and intermediate markers from their tool rows to the bottom of the turn. All other rows must stay in flow.
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // The old expansion rule checked only running and final-body text. If an abnormal terminal turn retains partial assistant text,
  // it looks completed and collapses, hiding interruption/failure context. Trust the header for terminal status; use session phase only
  // when cold recovery lacks a header. Desktop continuous and mobile replayable flows share this boundary.
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // The final body of a product turn remains the only action target; visual work segments change only collapse boundaries.
  const assistantTextRows = flowRows.filter(isAssistantTextRow);
  const actionAssistantTextRow = assistantTextRows.find(
    (row) => row.actions?.canFork === true || row.actions?.canRetry === true,
  );
  const lastFlowRow = flowRows.at(-1);
  const latestAssistantTextRow =
    actionAssistantTextRow ??
    (!isRunning && lastFlowRow && isAssistantTextRow(lastFlowRow) ? lastFlowRow : undefined);
  const workDurationMs = resolveConversationTurnWorkDurationMs(draft.header, options, isRunning);
  const workStatus = withTurnOutputTokens(
    resolveConversationTurnWorkStatus(
      draft.header,
      bodyRows,
      isRunning,
      workDurationMs,
      isInterrupted,
    ),
    draft.header,
  );
  const browserTurnEndRowIds = new Set(browserTurnEndRows.map((row) => row.rowId));
  const orderedBodyRows = visibleOrderedRows.filter(
    // The main workSegments flow is rebuilt from orderedRows; if screenshots are extracted only from
    // bodyRows, they remain in the body flow and render again at the tail, causing duplicates and ordering errors.
    (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
  );
  const workSegments = buildConversationTurnWorkSegments({
    key: draft.key,
    header: draft.header,
    orderedRows: orderedBodyRows,
    assistantTailRows,
    latestAssistantTextRow,
    isRunning,
    isLastTurn,
    isInterrupted,
    forceOpenHistory,
    timelineOnly,
    nowMs: options.nowMs,
    ...(options.pluginUiPinResolver ? { pluginUiPinResolver: options.pluginUiPinResolver } : {}),
  });
  const orderedAssistantHistoryRows = workSegments.flatMap(
    (segment) => segment.assistantHistoryRows,
  );
  const assistantFollowingRows = workSegments.flatMap((segment) => segment.assistantFollowingRows);
  const flowItems = workSegments.flatMap((segment) => segment.flowItems);
  const mustOpenHistory = workSegments.at(-1)?.assistantHistoryDefaultOpen ?? false;
  return {
    key: draft.key,
    turnId: draft.turnId,
    ...(draft.header ? { header: draft.header } : {}),
    visibleUserInputs,
    // Light boundaries are already carried separately by leadingBoundaryRows; they must not count as assistant work.
    assistantWorkRows: bodyRows,
    assistantHistoryRows: orderedAssistantHistoryRows,
    assistantFollowingRows,
    assistantTailRows,
    browserTurnEndRows,
    hookInvocations: draft.hookInvocations,
    assistantTextRows,
    leadingBoundaryRows,
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems,
    workSegments,
    // renderRows is a flat view for lookup/diagnostics and must also follow CLI row order.
    renderRows: visibleOrderedRows,
    isLastTurn,
    isRunning,
    assistantHistoryDefaultOpen: mustOpenHistory,
    timelineOnly,
    ...(workStatus ? { workStatus } : {}),
    ...(draft.header ? { startedAt: draft.header.startedAt } : {}),
    ...(workflowLaunch ? { workflowLaunch } : {}),
  };
}

function createDraftUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // A cold snapshot may start in the middle of assistant/tool rows from the same turn, then reveal a different first visible rowId
    // after turnHeader arrives. Virtual-list keys must depend only on protocol-stable turnId; otherwise paging treats the existing turn
    // as a new node, losing measurement cache and viewport anchors.
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

function shouldKeepRenderUnit(unit: ConversationTurnRenderUnit): boolean {
  // Once invisible rows are removed (the projection no longer emits unrenderable markers), every work row is renderable;
  // the UI no longer decides which markers can render.
  return (
    unit.visibleUserInputs.length > 0 ||
    unit.assistantWorkRows.length > 0 ||
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute)) ||
    unit.leadingBoundaryRows.length > 0 ||
    // A direct-launch turn has an invisible user row and no assistant content, and is represented by a run card—it must remain.
    unit.workflowLaunch !== undefined ||
    unit.isRunning
  );
}

function normalizeRenderUnitPosition(
  unit: ConversationTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLastTurn = index === total - 1;
  const forceOpenHistory = shouldForceOpenAbnormalHistory(unit.header, options.sessionPhase);
  const assistantHistoryDefaultOpen =
    unit.workSegments && unit.workSegments.length > 0
      ? !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workSegments.at(-1)?.workStatus?.state === "running") ||
          (unit.workSegments.length === 1 &&
            unit.latestAssistantTextRow === undefined &&
            unit.assistantWorkRows.length > 0))
      : !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workStatus?.state === "running") ||
          (unit.latestAssistantTextRow === undefined && unit.assistantWorkRows.length > 0));
  const workSegments = unit.workSegments?.map((segment, segmentIndex, segments) =>
    segmentIndex === segments.length - 1
      ? {
          ...segment,
          assistantHistoryDefaultOpen:
            !unit.timelineOnly &&
            (forceOpenHistory ||
              (isLastTurn && segment.workStatus?.state === "running") ||
              (segments.length === 1 &&
                unit.latestAssistantTextRow === undefined &&
                segment.assistantWorkRows.length > 0)),
        }
      : segment,
  );
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    workSegments?.at(-1)?.assistantHistoryDefaultOpen ===
      unit.workSegments?.at(-1)?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}

/**
 * Writes the live work clock into running turns. buildConversationTurnRenderUnits without nowMs leaves a
 * running turn's duration open, so the timeline builds once per rows change and calls this per tick. Only
 * running units can change: their unit-level workStatus and last work segment status are recomputed with the
 * same helpers the builder uses, and every other unit keeps its object identity.
 */
export function applyConversationTurnLiveClock(
  units: ConversationTurnRenderUnit[],
  nowMs: number,
): ConversationTurnRenderUnit[] {
  if (!units.some((unit) => unit.isRunning)) return units;
  return units.map((unit) => (unit.isRunning ? withLiveWorkClock(unit, nowMs) : unit));
}

function isSameWorkStatus(
  a: ConversationTurnWorkStatus | undefined,
  b: ConversationTurnWorkStatus | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function withLiveWorkClock(
  unit: ConversationTurnRenderUnit,
  nowMs: number,
): ConversationTurnRenderUnit {
  // A running turn is never interrupted: resolveTurnRunning rejects terminal headers and terminal session phases.
  const isInterrupted = false;
  const { header } = unit;
  const workStatus = withTurnOutputTokens(
    resolveConversationTurnWorkStatus(
      header,
      unit.assistantWorkRows,
      true,
      resolveConversationTurnWorkDurationMs(header, { nowMs }, true),
      isInterrupted,
    ),
    header,
  );
  // Same row sets as materializeDraftUnit feeds to the segment builder, so the last segment is computed identically.
  const leadingBoundaryRowIds = new Set(unit.leadingBoundaryRows.map((row) => row.rowId));
  const browserTurnEndRowIds = new Set(unit.browserTurnEndRows.map((row) => row.rowId));
  const liveSegments = buildConversationTurnWorkSegments({
    key: unit.key,
    ...(header ? { header } : {}),
    orderedRows: unit.renderRows.filter(
      (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
    ),
    assistantTailRows: unit.assistantTailRows,
    ...(unit.latestAssistantTextRow ? { latestAssistantTextRow: unit.latestAssistantTextRow } : {}),
    isRunning: true,
    isLastTurn: unit.isLastTurn,
    isInterrupted,
    forceOpenHistory: false,
    timelineOnly: unit.timelineOnly,
    nowMs,
  });
  const liveLastStatus = liveSegments.at(-1)?.workStatus;
  const baseSegments = unit.workSegments;
  const lastBaseSegment = baseSegments?.at(-1);
  const segmentStatusChanged =
    lastBaseSegment !== undefined && !isSameWorkStatus(lastBaseSegment.workStatus, liveLastStatus);
  if (isSameWorkStatus(unit.workStatus, workStatus) && !segmentStatusChanged) return unit;

  const next: ConversationTurnRenderUnit = { ...unit };
  if (workStatus) next.workStatus = workStatus;
  else delete next.workStatus;
  if (baseSegments && segmentStatusChanged) {
    next.workSegments = baseSegments.map((segment, index) => {
      if (index !== baseSegments.length - 1) return segment;
      const patched = { ...segment };
      if (liveLastStatus) patched.workStatus = liveLastStatus;
      else delete patched.workStatus;
      return patched;
    });
  }
  return next;
}

export function createConversationTurnRenderUnitCache(): ConversationTurnRenderUnitCache {
  return { entries: new Map() };
}

interface MaterializedDraftSlot {
  unit: ConversationTurnRenderUnit;
  /** Present only for non-running turns when a cache is supplied; running turns depend on nowMs and are never reused. */
  entry?: ConversationTurnRenderUnitCacheEntry;
}

/**
 * Plugin pin results are derived from the whole window (other turns can change a row's disposition), so the
 * turn's cache key is the resolved value for its plugin rows, not the resolver closure identity.
 */
function resolvePinSignature(
  orderedRows: readonly ConversationRow[],
  resolver: BuildConversationTurnRenderUnitsOptions["pluginUiPinResolver"],
): string {
  if (!resolver) return "";
  const parts: string[] = [];
  for (const row of orderedRows) {
    if (row.kind !== "toolCall") continue;
    const display = row.display;
    if (display?.kind !== "mcp_tool" || display.ui === undefined) continue;
    parts.push(`${row.toolCallId}:${JSON.stringify(resolver(row.toolCallId) ?? null)}`);
  }
  return parts.join("\n");
}

function isSameDraftInputs(
  entry: ConversationTurnRenderUnitCacheEntry,
  draft: DraftTurnRenderUnit,
  isLastDraft: boolean,
  sessionPhase: BuildConversationTurnRenderUnitsOptions["sessionPhase"],
  pinSignature: string,
): boolean {
  if (
    entry.header !== draft.header ||
    entry.sessionPhase !== sessionPhase ||
    entry.isLastDraft !== isLastDraft ||
    entry.pinSignature !== pinSignature ||
    entry.orderedRows.length !== draft.orderedRows.length
  ) {
    return false;
  }
  return entry.orderedRows.every((row, index) => row === draft.orderedRows[index]);
}

function materializeCachedDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
  previous: ConversationTurnRenderUnitCacheEntry | undefined,
): MaterializedDraftSlot {
  const isLastDraft = index === total - 1;
  const pinSignature = resolvePinSignature(draft.orderedRows, options.pluginUiPinResolver);
  if (
    previous &&
    isSameDraftInputs(previous, draft, isLastDraft, options.sessionPhase, pinSignature)
  ) {
    return { unit: previous.materialized, entry: previous };
  }
  const unit = materializeDraftUnit(draft, index, total, options);
  if (!options.cache || unit.isRunning) return { unit };
  return {
    unit,
    entry: {
      header: draft.header,
      orderedRows: draft.orderedRows,
      sessionPhase: options.sessionPhase,
      isLastDraft,
      pinSignature,
      materialized: unit,
    },
  };
}

function normalizeCachedUnit(
  slot: MaterializedDraftSlot,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLast = index === total - 1;
  const entry = slot.entry;
  if (!entry) return normalizeRenderUnitPosition(slot.unit, index, total, options);
  if (entry.normalized?.source === slot.unit && entry.normalized.isLast === isLast) {
    return entry.normalized.unit;
  }
  const unit = normalizeRenderUnitPosition(slot.unit, index, total, options);
  entry.normalized = { source: slot.unit, isLast, unit };
  return unit;
}

function isSameFooterMark(a: ConversationTurnRenderUnit, b: ConversationTurnRenderUnit): boolean {
  return (
    a.showHighspeedOutputFooter === b.showHighspeedOutputFooter &&
    JSON.stringify(a.highspeedOutputFooterTarget ?? null) ===
      JSON.stringify(b.highspeedOutputFooterTarget ?? null)
  );
}

/** The footer pass rebuilds a target object on every call; keep the previous object while the mark is unchanged. */
function reuseFooterMarkedUnit(
  slot: MaterializedDraftSlot,
  base: ConversationTurnRenderUnit,
  marked: ConversationTurnRenderUnit,
): ConversationTurnRenderUnit {
  if (marked === base || !slot.entry) return marked;
  const previous = slot.entry.footer;
  if (previous?.base === base && isSameFooterMark(previous.unit, marked)) return previous.unit;
  slot.entry.footer = { base, unit: marked };
  return marked;
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  const units: DraftTurnRenderUnit[] = [];
  const unitByTurnId = new Map<string, DraftTurnRenderUnit>();

  const getOrCreateUnit = (turnId: string) => {
    const existing = unitByTurnId.get(turnId);
    if (existing) {
      return existing;
    }
    const unit = createDraftUnit(turnId);
    units.push(unit);
    unitByTurnId.set(turnId, unit);
    return unit;
  };

  for (const row of rows) {
    const unit = getOrCreateUnit(row.turnId);
    if (isTurnHeaderRow(row)) {
      unit.header = row;
      continue;
    }
    unit.orderedRows.push(row);
    if (isUserInputRow(row)) {
      unit.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      unit.hookInvocations.push(row);
      continue;
    }
    unit.assistantWorkRows.push(row);
  }

  const previousEntries = options.cache?.entries;
  const nextEntries = new Map<string, ConversationTurnRenderUnitCacheEntry>();
  const materializedSlots = units.map((unit, index) => {
    const slot = materializeCachedDraftUnit(
      unit,
      index,
      units.length,
      options,
      previousEntries?.get(unit.turnId),
    );
    if (slot.entry) nextEntries.set(unit.turnId, slot.entry);
    return slot;
  });
  const keptSlots = materializedSlots.filter((slot) => shouldKeepRenderUnit(slot.unit));
  const normalizedUnits = keptSlots.map((slot, index) =>
    normalizeCachedUnit(slot, index, keptSlots.length, options),
  );
  const markedUnits = markHighspeedOutputFooterUnits(normalizedUnits, options.nowMs ?? Date.now());
  if (options.cache) options.cache.entries = nextEntries;
  return markedUnits.map((unit, index) =>
    reuseFooterMarkedUnit(keptSlots[index]!, normalizedUnits[index]!, unit),
  );
}
