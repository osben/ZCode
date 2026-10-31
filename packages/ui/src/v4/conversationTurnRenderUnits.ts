import { isPluginUiPinnedToolRow } from "@/plugin-ui/index.js";
import type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
export type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
import type {
  AssistantTextRow,
  ConversationRow,
  ConversationRowsPartition,
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
  // While wrapper arguments are incomplete there is no authoritative target identity, so the generic card would bypass hidden rules such as Todo.
  // Hide only the argument-generation phase; once the target identity arrives the original renderer is reused, and failure or stop still shows feedback.
  if (
    row.kind === "toolCall" &&
    row.toolName === "DeferredToolCall" &&
    row.status === "inputStreaming"
  ) {
    return false;
  }
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // reasoning_start/reasoning_end can form an empty terminal block; trim it only at the shared
    // render-unit boundary so that completed state does not bypass the streaming renderer's empty-line filter.
    return false;
  }
  // EnterPlanMode is only an internal mode-switch boundary; treating it as an ordinary tool in "Worked"
  // would show a "Tool call executed" row with no user value. Filter it only in the render unit and do not rewrite the protocol projection,
  // preserving the runtime and recovery semantics shared by desktop continuous and web remote replayable.
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  if (isUserInputRow(row)) return true;
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

// Placement (lane) is decided by the CLI projection and sent down; the UI must not infer it from the marker type.
// If lane is missing (should not happen), fall back to assistantWork: the row drops into the collapsed group and is not lost.
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/**
 * Artifact rows are outputs that the sharing projection appends to the turn tail (insertDiscoveredArtifacts places them after the last row of that
 * productTurn), but they are also AssistantWorkRow and become the last row of the flow.
 * That breaks the fallback condition of the collapse anchor, "the last row is assistantText": public projections forbid actions,
 * and the share page relies only on this fallback, so the final answer gets folded into "Worked" and the whole turn expands by default.
 *
 * They are appended outputs and not part of the conversation stream, so handling them as turn-tail content is enough; this is the same as browserTurnEndRows pulling turn-tail screenshots.
 * Do not change this to "take the last assistantText in the flow": that would promote body text from the middle of a CUA response
 * to the final answer and split the group that shares one assistantResponseId.
 */
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
  // Automatic screenshots are persisted as completed tool rows after the final body; the old grouping only treated
  // the timeline boundary as turn tail, which moved screenshots into the "Worked" collapsed area above where they were invisible.
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
    // turnHeader is the projection's authoritative turn boundary; a main turn in a terminal state must not be
    // pushed back to running by background tool/subagent rows of the same turn that are still running.
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // A cold snapshot that keeps only the tail window may cut off turnHeader; the old fallback would turn
    // an isolated inputStreaming/running tool row back into thinking, so the terminal control state must take priority.
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
  // The user row of a launch turn is represented by its run card; it enters neither the visible input nor the stream.
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

  // modelChange is a light boundary at the top of the turn, rendered before the user input and not part of the work flow.
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser automatic screenshots must come after the file-diff summary as the last content block, so extract them first;
  // the other rows are still processed in CLI order, and only a contiguous suffix of real turn-tail markers may be split out of the flow.
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
  // Do not use filter to pull out every turnTailBoundary or force ExitPlanMode into the tail,
  // because that would move the plan and intermediate markers from their tool rows to the bottom of the turn. All other rows must stay in the flow.
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // The old expansion rule only checked running and the final body; once an abnormal terminal state keeps partial assistant text,
  // it is treated as a normal completion and collapsed, hiding the interruption/failure context. The terminal state must be authoritative from the header; cold recovery
  // falls back to the session phase only when the tail window lacks a header; desktop continuous and mobile replayable share this boundary.
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // The final body of a product turn is still the only action target; visual work segments only change the collapse boundaries.
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
    // The main workSegments are rebuilt from orderedRows; if screenshots were extracted only from
    // bodyRows, they would be put back into the body flow and rendered again at the turn tail, causing duplicates and wrong order.
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
    // Light boundaries are already carried independently by leadingBoundaryRows and must not count as assistant work again.
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
    // renderRows is a flat view for lookup and diagnostics and must also follow the CLI row order.
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
    // A cold snapshot may cut in the middle of the assistant/tool rows of one turn; after the missing
    // turnHeader arrives, the first visible rowId changes. The virtual-list key must depend only on the protocol-stable turnId,
    // otherwise paging would remount the existing turn as a new node and lose the height-measurement cache and viewport anchor.
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
    // A direct-launch turn has an invisible user row and no assistant content, and is shown by its run card, so it must stay.
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
  const lastSegment = unit.workSegments?.at(-1);
  const lastSegmentDefaultOpen = lastSegment
    ? !unit.timelineOnly &&
      (forceOpenHistory ||
        (isLastTurn && lastSegment.workStatus?.state === "running") ||
        (unit.workSegments?.length === 1 &&
          unit.latestAssistantTextRow === undefined &&
          lastSegment.assistantWorkRows.length > 0))
    : undefined;
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    lastSegmentDefaultOpen === lastSegment?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  // The old implementation copied every turn's segments before deciding nothing changed; with long history that created many objects every frame and discarded them right after.
  const workSegments = unit.workSegments?.map((segment) =>
    segment === lastSegment && segment.assistantHistoryDefaultOpen !== lastSegmentDefaultOpen
      ? { ...segment, assistantHistoryDefaultOpen: lastSegmentDefaultOpen === true }
      : segment,
  );
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  return buildRenderUnits(rows, options, materializeDraftUnit);
}

// Root cause of the bug: the selector's reuse check used zustand shallow. Comparing arrays or objects builds a Map for each side,
// and that check runs for every history turn on every frame. During long-session streaming this became the top renderer main-thread hotspot
// (about 1.75ms per frame at roughly 8000 rows; after the wide-screen issue catalog filled in full history, the cost grew with history length).
// Reuse only needs item-by-item reference comparison, so it was changed to a comparison that allocates no objects.
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Same object semantics as shallow: the same set of own fields, each compared with Object.is; one field may be ignored. */
function sameFields(a: object | undefined, b: object | undefined, ignoredKey?: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let fieldCount = 0;
  for (const key in left) {
    if (key === ignoredKey) continue;
    if (!Object.hasOwn(right, key) || !Object.is(left[key], right[key])) return false;
    fieldCount += 1;
  }
  for (const key in right) {
    if (key !== ignoredKey) fieldCount -= 1;
  }
  return fieldCount === 0;
}

function groupDraftUnits(rows: readonly ConversationRow[]): DraftTurnRenderUnit[] {
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
  return units;
}

function buildRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions,
  materialize: typeof materializeDraftUnit,
): ConversationTurnRenderUnit[] {
  const units = groupDraftUnits(rows);
  const materializedUnits = units.map((unit, index) =>
    materialize(unit, index, units.length, options),
  );
  const keptUnits = materializedUnits.filter(shouldKeepRenderUnit);
  const normalizedUnits = keptUnits.map((unit, index) =>
    normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
  );
  return markHighspeedOutputFooterUnits(normalizedUnits, options.nowMs ?? Date.now());
}

function hasHighspeedCard(unit: ConversationTurnRenderUnit): boolean {
  return unit.visibleUserInputs.some((row) => row.highspeed !== undefined);
}

/** Render units corresponding to the rows partition (spec: docs/ui/chat-virtual-scroll.md, "per-frame derivation cost"). */
export interface ConversationTurnRenderUnitsPartition {
  /** Units of the history segment; the reference changes only when the history-derived result changes. */
  readonly history: readonly ConversationTurnRenderUnit[];
  /** Units of the tail turn (usually 0 to 1). */
  readonly tail: readonly ConversationTurnRenderUnit[];
}

/**
 * The output is item-for-item equal to a full build over history ++ tail, but only the tail turn is materialized each frame.
 *
 * Root cause of the bug: the old selector grouped all rows every frame and confirmed row by row that each history turn was unchanged,
 * so the cost grew linearly with history length; after the wide-screen issue catalog filled in full history, long-session streaming visibly stuttered.
 * Now the history-segment result is cached by the history array reference. The cache key adds an input only when history contains turns without a header (it reads the phase),
 * turns still running (it reads the clock), or pinnable plugin cards (it reads the pin resolution).
 * Cross-turn rules are handled when merging: when the tail unit is filtered out, the last history item is re-normalized as the last turn;
 * the highspeed footer is closed only on units that contain cards; units without cards neither affect nor receive the footer,
 * so closing on the subsequence of "history units with cards + tail unit" gives the same result as a full close.
 */
export function createConversationTurnRenderUnitsSelector() {
  type Entry = {
    draft: DraftTurnRenderUnit;
    isLast: boolean;
    phase: SessionPhase | undefined;
    clock: number | undefined;
    pinnedRows: ConversationRow[];
    unit: ConversationTurnRenderUnit;
  };
  type UnitMap = Map<string, ConversationTurnRenderUnit>;
  type HistoryCache = {
    rows: readonly ConversationRow[];
    draftCount: number;
    phaseDependent: boolean;
    phase: SessionPhase | undefined;
    clockDependent: boolean;
    clock: number;
    pinDependent: boolean;
    resolver: BuildConversationTurnRenderUnitsOptions["pluginUiPinResolver"];
    // Filtered and normalized as if a tail unit follows; the footer is not closed yet.
    units: ConversationTurnRenderUnit[];
    cardIndexes: number[];
    /**
     * When every tail unit is filtered out, the history array with its last item re-normalized as the last turn.
     * Root cause of the bug: this array used to be rebuilt on every call, so the history reference changed each time and every downstream derivation cached by history was invalidated.
     * Normalization reads only the unit and the session phase, so caching by phase is enough.
     */
    tailDropped?: { phase: SessionPhase | undefined; units: readonly ConversationTurnRenderUnit[] };
  };
  // The materialize reuse tables are split by turn key into the history segment and the tail segment; when a turn moves between the two, both are checked.
  let historyEntries = new Map<string, Entry>();
  let tailEntries = new Map<string, Entry>();
  // Reuse tables for the final units (after the footer is closed).
  let historyFinalByKey: UnitMap = new Map();
  let tailFinalByKey: UnitMap = new Map();
  let history: HistoryCache | null = null;
  let historyFinal: {
    base: readonly ConversationTurnRenderUnit[];
    units: ConversationTurnRenderUnit[];
  } | null = null;

  const materializeReusing = (
    draft: DraftTurnRenderUnit,
    index: number,
    total: number,
    options: BuildConversationTurnRenderUnitsOptions & { nowMs: number },
    lookup: (key: string) => Entry | undefined,
    next: Map<string, Entry>,
  ): Entry => {
    const old = lookup(draft.key);
    const isLast = index === total - 1;
    const phase = draft.header ? undefined : options.sessionPhase;
    const clock = resolveTurnRunning(draft, options) ? options.nowMs : undefined;
    // The resolver is rebuilt along with plugin derivation, but ordinary messages do not change the plugin's actual collapse decision.
    const pinnedRows = draft.orderedRows.filter((row) =>
      isPluginUiPinnedToolRow(row, options.pluginUiPinResolver),
    );
    const unchanged =
      old &&
      old.draft.header === draft.header &&
      sameItems(old.draft.orderedRows, draft.orderedRows) &&
      old.isLast === isLast &&
      old.phase === phase &&
      old.clock === clock &&
      sameItems(old.pinnedRows, pinnedRows);
    const entry: Entry = {
      draft,
      isLast,
      phase,
      clock,
      pinnedRows,
      unit: unchanged ? old.unit : materializeDraftUnit(draft, index, total, options),
    };
    next.set(draft.key, entry);
    return entry;
  };

  // The card-level footer is closed again each time; the previous final unit is reused only when its values and other derived fields are unchanged.
  const reuseFinal = (
    unit: ConversationTurnRenderUnit,
    lookup: (key: string) => ConversationTurnRenderUnit | undefined,
  ): ConversationTurnRenderUnit => {
    const old = lookup(unit.key);
    if (!old || old === unit) return unit;
    const target = unit.highspeedOutputFooterTarget;
    const oldTarget = old.highspeedOutputFooterTarget;
    return sameFields(unit, old, "highspeedOutputFooterTarget") &&
      target?.cardId === oldTarget?.cardId &&
      sameFields(target?.metrics, oldTarget?.metrics)
      ? old
      : unit;
  };

  const isHistoryReusable = (
    cache: HistoryCache | null,
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions & { nowMs: number },
  ): cache is HistoryCache =>
    cache !== null &&
    cache.rows === rows &&
    (!cache.phaseDependent || cache.phase === options.sessionPhase) &&
    (!cache.clockDependent || cache.clock === options.nowMs) &&
    (!cache.pinDependent || cache.resolver === options.pluginUiPinResolver);

  return (
    partition: ConversationRowsPartition,
    options: BuildConversationTurnRenderUnitsOptions = {},
  ): ConversationTurnRenderUnitsPartition => {
    const currentOptions = { ...options, nowMs: options.nowMs ?? Date.now() };
    const previousHistoryEntries = historyEntries;
    const previousTailEntries = tailEntries;
    const previousHistoryFinalByKey = historyFinalByKey;
    const previousTailFinalByKey = tailFinalByKey;
    const tailDrafts = groupDraftUnits(partition.tail);

    if (!isHistoryReusable(history, partition.history, currentOptions)) {
      const drafts = groupDraftUnits(partition.history);
      // When the tail is non-empty, no history draft is the last one; when the window is empty, both segments are empty.
      const total = drafts.length + tailDrafts.length;
      const next = new Map<string, Entry>();
      let clockDependent = false;
      const materialized = drafts.map((draft, index) => {
        const entry = materializeReusing(
          draft,
          index,
          total,
          currentOptions,
          (key) => previousHistoryEntries.get(key) ?? previousTailEntries.get(key),
          next,
        );
        if (entry.clock !== undefined) clockDependent = true;
        return entry.unit;
      });
      historyEntries = next;
      const kept = materialized.filter(shouldKeepRenderUnit);
      // Normalize first as if one tail unit follows; the case where the tail is filtered out is handled in the merge below.
      const units = kept.map((unit, index) =>
        normalizeRenderUnitPosition(unit, index, kept.length + 1, currentOptions),
      );
      history = {
        rows: partition.history,
        draftCount: drafts.length,
        phaseDependent: drafts.some((draft) => !draft.header),
        phase: currentOptions.sessionPhase,
        clockDependent,
        clock: currentOptions.nowMs,
        // Without a resolver, isPluginUiPinnedToolRow decides exactly whether the row is affected by the pin resolution.
        pinDependent: drafts.some((draft) =>
          draft.orderedRows.some((row) => isPluginUiPinnedToolRow(row)),
        ),
        resolver: currentOptions.pluginUiPinResolver,
        units,
        cardIndexes: units.flatMap((unit, index) => (hasHighspeedCard(unit) ? [index] : [])),
      };
    }

    const historyDraftCount = history.draftCount;
    const tailNext = new Map<string, Entry>();
    const tailKept = tailDrafts
      .map(
        (draft, index) =>
          materializeReusing(
            draft,
            historyDraftCount + index,
            historyDraftCount + tailDrafts.length,
            currentOptions,
            (key) => previousTailEntries.get(key) ?? previousHistoryEntries.get(key),
            tailNext,
          ).unit,
      )
      .filter(shouldKeepRenderUnit);
    tailEntries = tailNext;
    const historyCount = history.units.length;
    const tailUnits = tailKept.map((unit, index) =>
      normalizeRenderUnitPosition(
        unit,
        historyCount + index,
        historyCount + tailKept.length,
        currentOptions,
      ),
    );

    let historyUnits: readonly ConversationTurnRenderUnit[] = history.units;
    const lastIndex = historyCount - 1;
    if (tailUnits.length === 0 && lastIndex >= 0) {
      if (!history.tailDropped || history.tailDropped.phase !== currentOptions.sessionPhase) {
        // Normalization changes only isLastTurn and the default expansion and reads only the other fields, so doing it once more on an already normalized unit is enough.
        const last = normalizeRenderUnitPosition(
          history.units[lastIndex]!,
          lastIndex,
          historyCount,
          currentOptions,
        );
        history.tailDropped = {
          phase: currentOptions.sessionPhase,
          units:
            last === history.units[lastIndex]
              ? history.units
              : [...history.units.slice(0, -1), last],
        };
      }
      historyUnits = history.tailDropped.units;
    }

    const cardIndexes = history.cardIndexes;
    const marked = markHighspeedOutputFooterUnits(
      [...cardIndexes.map((index) => historyUnits[index]!), ...tailUnits],
      currentOptions.nowMs,
    );
    const historyLookup = (key: string) =>
      previousHistoryFinalByKey.get(key) ?? previousTailFinalByKey.get(key);
    const markedCards = cardIndexes.map((_, index) => reuseFinal(marked[index]!, historyLookup));
    const previousFinal = historyFinal;
    if (
      previousFinal?.base !== historyUnits ||
      cardIndexes.some((unitIndex, index) => previousFinal.units[unitIndex] !== markedCards[index])
    ) {
      const units = historyUnits.map((unit) => reuseFinal(unit, historyLookup));
      cardIndexes.forEach((unitIndex, index) => {
        units[unitIndex] = markedCards[index]!;
      });
      historyFinal = { base: historyUnits, units };
      historyFinalByKey = new Map(units.map((unit) => [unit.key, unit]));
    }
    const tailFinal = marked
      .slice(cardIndexes.length)
      .map((unit) =>
        reuseFinal(
          unit,
          (key) => previousTailFinalByKey.get(key) ?? previousHistoryFinalByKey.get(key),
        ),
      );
    tailFinalByKey = new Map(tailFinal.map((unit) => [unit.key, unit]));
    return { history: historyFinal!.units, tail: tailFinal };
  };
}
