import {
  sameItems,
  type ConversationTurnRenderUnit,
  type ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";

export type ConversationTurnNavigatorAssistantPreviewKind = "empty" | "running" | "text";

export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
  isPinned: boolean;
}

export interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

export interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
export type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

export interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

export interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

export interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

export const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

function collectRealUserQueryRowIds(units: readonly ConversationTurnRenderUnit[]): number[] {
  const rowIds: number[] = [];
  for (const unit of units) {
    for (const row of unit.visibleUserInputs) {
      if (row.origin === "realUser") rowIds.push(row.rowId);
    }
  }
  return rowIds;
}

/**
 * Keep identity while directory members are unchanged; body tokens or the clock must not make DOM anchor registration rebuild in full.
 * Input is partitioned into "history + tail turn" (docs/ui/chat-virtual-scroll.md, "per-frame derivation cost"): when the history reference is unchanged and
 * tail members are unchanged, reuse directly; stream frames collect only the tail, and the whole window is compared only when the history segment changes.
 */
export function createConversationTurnNavigatorQueryRowIdsSelector() {
  let previous: ReadonlySet<number> = new Set<number>();
  let previousHistory: readonly ConversationTurnRenderUnit[] | null = null;
  let previousTailRowIds: number[] = [];
  return (units: ConversationTurnRenderUnitsPartition): ReadonlySet<number> => {
    const tailRowIds = collectRealUserQueryRowIds(units.tail);
    if (previousHistory === units.history && sameItems(previousTailRowIds, tailRowIds)) {
      return previous;
    }
    previousHistory = units.history;
    previousTailRowIds = tailRowIds;
    const next = new Set([...collectRealUserQueryRowIds(units.history), ...tailRowIds]);
    if (next.size !== previous.size || [...next].some((rowId) => !previous.has(rowId))) {
      previous = next;
    }
    return previous;
  };
}

export type ConversationTurnNavigatorHydrationResult =
  | { status: "hydrated"; logEpoch: string }
  | { status: "not-enough-queries"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

export function shouldHydrateConversationTurnNavigatorDirectory(params: {
  canLoadOlder: boolean;
  containerWidthPx: number;
  hasLoadHandler: boolean;
  loadingOlder: boolean;
}): boolean {
  return (
    params.canLoadOlder &&
    !params.loadingOlder &&
    params.hasLoadHandler &&
    params.containerWidthPx >= CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX
  );
}

export function resolveConversationTurnNavigatorHydrationRetryDelayMs(
  failedAttemptCount: number,
): number | null {
  if (failedAttemptCount === 1) return 250;
  if (failedAttemptCount === 2) return 1_000;
  return null;
}

const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

function truncatePreview(text: string, maxChars: number): string {
  const normalizedMaxChars = Math.max(8, maxChars);
  if (text.length <= normalizedMaxChars) {
    return text;
  }
  return `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function buildPreviewText({
  texts,
  fallback,
  maxPreviewChars,
  maxPreviewParagraphs,
}: {
  texts: readonly string[];
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}): string {
  const maxChars = Math.max(8, maxPreviewChars);
  const maxParagraphs = Math.trunc(Math.max(1, maxPreviewParagraphs));
  let preview = "";
  let paragraphs = 1;
  let whitespace = false;
  let newlines = 0;
  // The old implementation joined and regex-normalized the whole text before truncating, so every streamed delta rescanned the long history.
  // Reading one extra significant character is enough to decide whether to elide, which keeps the original whitespace, blank-line paragraph and UTF-16 truncation semantics.
  for (const text of texts) {
    if (preview) {
      whitespace = true;
      newlines = 2;
    }
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]!;
      if (/\s/u.test(character)) {
        whitespace = true;
        if (character === "\n") newlines += 1;
        continue;
      }
      if (whitespace && preview) {
        if (newlines >= 2) {
          if (paragraphs >= maxParagraphs) return truncatePreview(preview, maxChars);
          paragraphs += 1;
          preview += "\n";
        } else {
          preview += " ";
        }
      }
      preview += character;
      whitespace = false;
      newlines = 0;
      if (preview.length > maxChars) return truncatePreview(preview, maxChars);
    }
  }
  return preview || fallback;
}

function buildAssistantPreview(
  unit: ConversationTurnRenderUnit,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
): {
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
} {
  if (unit.assistantTextRows.length > 0) {
    return {
      assistantPreview: buildPreviewText({
        texts: unit.assistantTextRows.map((row) => row.text),
        fallback: options.assistantEmptyPreview,
        maxPreviewChars: options.maxPreviewChars,
        maxPreviewParagraphs: options.maxPreviewParagraphs,
      }),
      assistantPreviewKind: "text",
    };
  }

  if (unit.isRunning) {
    return {
      assistantPreview: options.assistantRunningPreview,
      assistantPreviewKind: "running",
    };
  }

  return {
    assistantPreview: options.assistantEmptyPreview,
    assistantPreviewKind: "empty",
  };
}

export function buildConversationTurnNavigatorItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
): ConversationTurnNavigatorItem[] {
  const resolvedOptions: Required<BuildConversationTurnNavigatorItemsOptions> = {
    ...options,
    maxPreviewChars: options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: options.maxPreviewParagraphs ?? DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  };

  return units.flatMap((unit, unitIndex) => {
    // The provider/store's physical role=user also includes system context such as background/goal/mailbox;
    // the navigator represents user-initiated queries and must use only realUser, as explicitly classified by the projection.
    const realUserInputs = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
    if (unit.timelineOnly || realUserInputs.length === 0) {
      return [];
    }

    // Split navigator items by query, but preserve the old product semantics for the assistant hover summary:
    // use the text result from the owning product turn; do not infer guide-response segments in the renderer.
    const { assistantPreview, assistantPreviewKind } = buildAssistantPreview(unit, resolvedOptions);
    // Pinned lookup mirrors PinnedConversationRow (userInput/assistantText only); all of a unit's assistantText
    // rows live in assistantTextRows, because turn-tail rows are only markers/artifacts.
    const turnHasPinnedAssistantText = unit.assistantTextRows.some(
      (row) => row.pinnedAt !== undefined,
    );
    return realUserInputs.map((row, queryIndex) => ({
      // Do not use product turns as navigator entries and concatenate every steer query from the same turn into one preview.
      // The navigator represents user-visible queries, so create one entry per query using stable row identity;
      // turnId only locates the owning container in the virtual list.
      key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
      turnId: unit.turnId,
      unitIndex,
      rowId: row.rowId,
      userPreview: buildPreviewText({
        texts: [row.text],
        fallback: resolvedOptions.userFallbackPreview,
        maxPreviewChars: resolvedOptions.maxPreviewChars,
        maxPreviewParagraphs: resolvedOptions.maxPreviewParagraphs,
      }),
      assistantPreview,
      assistantPreviewKind,
      // One running product turn may already contain several completed guide segments; only the last
      // query represents current work, preventing all old queries from appearing highlighted as running.
      isRunning: unit.isRunning && queryIndex === realUserInputs.length - 1,
      // A pinned answer marks the query that produced it, so pinned content stays findable from the rail.
      isPinned: row.pinnedAt !== undefined || turnHasPinnedAssistantText,
    }));
  });
}

/**
 * The cache covers only the current directory; unchanged history turns must not rescan body text because of a tail token or the clock.
 * Input is partitioned into "history + tail turn": history-segment entries are cached by history reference, and each frame rebuilds entries only for the tail,
 * returning the previous directory directly when tail entry values are unchanged (the preview is at most 220 characters; beyond that, streamed body text no longer changes the entry).
 */
export function createConversationTurnNavigatorItemsSelector() {
  type UnitCache = Map<
    string,
    { unit: ConversationTurnRenderUnit; index: number; items: ConversationTurnNavigatorItem[] }
  >;
  let historyCache: UnitCache = new Map();
  let tailCache: UnitCache = new Map();
  let previousOptions: BuildConversationTurnNavigatorItemsOptions | undefined;
  let history: {
    units: readonly ConversationTurnRenderUnit[];
    items: ConversationTurnNavigatorItem[];
  } | null = null;
  let previousTailItems: ConversationTurnNavigatorItem[] = [];
  let previousItems: ConversationTurnNavigatorItem[] = [];

  const selectUnitItems = (
    units: readonly ConversationTurnRenderUnit[],
    indexOffset: number,
    options: BuildConversationTurnNavigatorItemsOptions,
    lookup: (key: string) => ReturnType<UnitCache["get"]>,
    next: UnitCache,
  ) =>
    units.flatMap((unit, offset) => {
      const index = indexOffset + offset;
      const cached = lookup(unit.key);
      if (cached?.unit === unit && cached.index === index) {
        next.set(unit.key, cached);
        return cached.items;
      }
      const built = buildConversationTurnNavigatorItems([unit], options).map((item) => ({
        ...item,
        unitIndex: index,
      }));
      // A running clock or a change to the invisible body tail does not necessarily change the directory's displayed values.
      const stable = built.map((item, i) => {
        const old = cached?.items[i];
        return old &&
          Object.keys(item).every(
            (key) => item[key as keyof typeof item] === old[key as keyof typeof item],
          )
          ? old
          : item;
      });
      next.set(unit.key, { unit, index, items: stable });
      return stable;
    });

  return (
    units: ConversationTurnRenderUnitsPartition,
    options: BuildConversationTurnNavigatorItemsOptions,
  ) => {
    if (
      !previousOptions ||
      Object.keys({ ...previousOptions, ...options }).some(
        (key) =>
          options[key as keyof typeof options] !== previousOptions?.[key as keyof typeof options],
      )
    ) {
      historyCache.clear();
      tailCache.clear();
      history = null;
    }
    previousOptions = options;
    const previousHistoryCache = historyCache;
    const previousTailCache = tailCache;
    let historyChanged = false;
    if (history?.units !== units.history) {
      historyCache = new Map();
      history = {
        units: units.history,
        items: selectUnitItems(
          units.history,
          0,
          options,
          (key) => previousHistoryCache.get(key) ?? previousTailCache.get(key),
          historyCache,
        ),
      };
      historyChanged = true;
    }
    tailCache = new Map();
    const tailItems = selectUnitItems(
      units.tail,
      units.history.length,
      options,
      (key) => previousTailCache.get(key) ?? previousHistoryCache.get(key),
      tailCache,
    );
    if (!historyChanged && sameItems(tailItems, previousTailItems)) {
      return previousItems;
    }
    previousTailItems = tailItems;
    const items = [...history.items, ...tailItems];
    if (sameItems(items, previousItems)) return previousItems;
    previousItems = items;
    return items;
  };
}

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex({
  items,
  virtualItems,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveUnitIndexOptions): number | undefined {
  if (items.length === 0) {
    return undefined;
  }

  // items are generated in renderUnits order (one turn may have several queries). Scrolling looks up only a few visible turns,
  // so binary search over the existing order is enough; a full-directory Map must not be reallocated on every scroll pixel.
  const lowerBound = (unitIndex: number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (items[middle]!.unitIndex < unitIndex) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = items[lowerBound(virtualItem.index)];
    if (item?.unitIndex !== virtualItem.index) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart = rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeUnitIndex = item.unitIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeUnitIndex !== undefined) {
    return activeUnitIndex;
  }

  const topVirtualIndex = virtualItems.find((item) => {
    const rowStart = resolveFiniteNonNegative(item.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(item.size));
    return rowEnd >= viewportStart && rowStart <= viewportEnd;
  })?.index;
  if (topVirtualIndex === undefined) {
    return items[0]?.unitIndex;
  }

  return (
    items[lowerBound(topVirtualIndex)]?.unitIndex ?? items.at(-1)?.unitIndex ?? items[0]?.unitIndex
  );
}

export function resolveConversationTurnNavigatorActiveQueryRowId({
  positions,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveQueryRowIdOptions): number | undefined {
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  let nearest: ConversationTurnNavigatorQueryPosition | undefined;
  let distance = Number.POSITIVE_INFINITY;
  let before: ConversationTurnNavigatorQueryPosition | undefined;
  let after: ConversationTurnNavigatorQueryPosition | undefined;
  // Keep the original distance and tie rules after sorting by start/rowId; no need to allocate and sort three arrays on every scroll.
  for (const position of positions) {
    const start = resolveFiniteNonNegative(position.start);
    const end = Math.max(start, resolveFiniteNonNegative(position.end));
    const candidate =
      start === position.start && end === position.end ? position : { ...position, start, end };
    const delta = Math.abs(start - viewportStart);
    if (
      end >= viewportStart &&
      start <= viewportEnd &&
      (delta < distance ||
        (delta === distance &&
          nearest &&
          (start < nearest.start || (start === nearest.start && position.rowId < nearest.rowId))))
    ) {
      nearest = candidate;
      distance = delta;
    }
    if (
      start <= viewportStart &&
      (!before || start > before.start || (start === before.start && position.rowId > before.rowId))
    )
      before = candidate;
    if (
      start > viewportStart &&
      (!after || start < after.start || (start === after.start && position.rowId < after.rowId))
    )
      after = candidate;
  }
  return nearest?.rowId ?? before?.rowId ?? after?.rowId;
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}
