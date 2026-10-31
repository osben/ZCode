import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationFindHighlights,
  applySearchResultHighlight,
  clearConversationFindHighlights,
  clearSearchResultHighlight,
  getMountedConversationFindRow,
  scrollConversationFindRangeIntoView,
} from "@/v4/conversationFindHighlightDom.js";
import {
  createConversationFindIndexBuilder,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveIndex,
  resolveSearchResultHighlightMatch,
  type ConversationFindMatch,
  type ConversationFindMatchKey,
} from "@/v4/conversationFindIndex.js";
import type {
  ConversationTurnRenderUnit,
  ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";

const FIND_AUTO_LOAD_ROW_LIMIT = 1200;
const SEARCH_RESULT_HIGHLIGHT_DURATION_MS = 3000;

export interface UseConversationTimelineFindOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  /** Render units partitioned into "history + tail turn"; the history segment's reference is stable across streaming frames. */
  renderUnits: ConversationTurnRenderUnitsPartition;
  rows: readonly ConversationRow[];
  mountedRowsKey: string;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => Promise<void> | void;
  sessionPhase?: SessionPhase;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  scrollToUnit: (unitIndex: number) => void;
  isMountedLayoutMeasured: () => boolean;
}

function normalizeSearchResultSnippet(text: string): string {
  return text
    .replace(/^\.{3}/, "")
    .replace(/\.{3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceTextContainsSnippet(sourceText: string, snippet: string): boolean {
  const normalizedSnippet = normalizeSearchResultSnippet(snippet).toLocaleLowerCase();
  if (!normalizedSnippet) {
    return false;
  }
  return normalizeSearchResultSnippet(sourceText).toLocaleLowerCase().includes(normalizedSnippet);
}

type UnitFindCache = Map<
  string,
  { unit: ConversationTurnRenderUnit; source: ConversationFindMatch[]; loadedRowCount: number }
>;

/**
 * Append one segment's unit matches to matches in global order and return the sum of those units' loadedRowCount.
 * Fix rationale: a streaming delta only changes the current running turn; a stable turn's full-text index is
 * reusable, avoiding a scan of the whole history per token that kept the renderer main thread saturated in
 * long sessions. Non-running units look up their previous matches in lookups and write them into nextCache;
 * running units are rebuilt every time.
 */
function appendUnitFindMatches({
  units,
  indexOffset,
  matches,
  cacheKeyPrefix,
  lookups,
  nextCache,
  build,
}: {
  units: readonly ConversationTurnRenderUnit[];
  indexOffset: number;
  matches: ConversationFindMatch[];
  cacheKeyPrefix: string;
  lookups: readonly UnitFindCache[];
  nextCache: UnitFindCache;
  build: (unit: ConversationTurnRenderUnit) => {
    matches: ConversationFindMatch[];
    loadedRowCount: number;
  };
}): number {
  let loadedRowCount = 0;
  units.forEach((unit, offset) => {
    const unitIndex = indexOffset + offset;
    const cacheKey = `${cacheKeyPrefix}:${unit.key}`;
    // A history revision keeps the turn key but the text changed; the cache must invalidate with the immutable projection identity.
    const cached = unit.isRunning
      ? undefined
      : lookups.map((cache) => cache.get(cacheKey)).find((entry) => entry?.unit === unit);
    const unitIndexResult = cached
      ? { matches: cached.source, loadedRowCount: cached.loadedRowCount }
      : build(unit);
    if (!unit.isRunning) {
      nextCache.set(
        cacheKey,
        cached ?? {
          unit,
          source: unitIndexResult.matches,
          loadedRowCount: unitIndexResult.loadedRowCount,
        },
      );
    }
    loadedRowCount += unitIndexResult.loadedRowCount;
    for (const match of unitIndexResult.matches) {
      // Freshly built matches are unpublished, so fill in positions directly; cached matches are copied only when their window position changed.
      // High-frequency short queries can produce huge result sets; never unconditionally copy every object again after building in the same round.
      if (!cached) {
        match.globalIndex = matches.length;
        match.unitIndex = unitIndex;
      }
      matches.push(
        match.globalIndex === matches.length && match.unitIndex === unitIndex
          ? match
          : { ...match, globalIndex: matches.length, unitIndex },
      );
    }
  });
  return loadedRowCount;
}

export function useConversationTimelineFind({
  rootRef,
  renderUnits,
  rows,
  mountedRowsKey,
  canLoadOlder,
  loadingOlder,
  onLoadOlder,
  sessionPhase,
  conversationFindQuery,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  scrollToUnit,
  isMountedLayoutMeasured,
}: UseConversationTimelineFindOptions) {
  const buildFindIndex = useMemo(() => createConversationFindIndexBuilder(), []);
  // Fixed empty index while not searching: effects depending on it do not rerun on every streaming frame.
  const emptyFindIndex = useMemo(() => buildFindIndex([], ""), [buildFindIndex]);
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const findStable = sessionPhase !== "running" && sessionPhase !== "prewarming";
  const normalizedFindQuery = conversationFindQuery.trim().toLocaleLowerCase();
  // History and tail caches each keep only their own segment's units; a unit migrating between segments is caught by the other table as a fallback.
  const historyFindCacheRef = useRef<UnitFindCache>(new Map());
  const tailFindCacheRef = useRef<UnitFindCache>(new Map());
  // Bug root cause: the index used to be built over all render units, assembling cache keys every round even
  // when not searching, so per-frame cost grew linearly with history. History matches are cached by the history
  // reference and only the tail is rebuilt per frame; when not searching, return the fixed empty index directly.
  const historyFindIndex = useMemo(() => {
    const matches: ConversationFindMatch[] = [];
    if (!normalizedFindQuery) {
      // When find closes, drop the previous query's units and matches (before the change, each call kept only the current window's units).
      if (historyFindCacheRef.current.size > 0) historyFindCacheRef.current = new Map();
      return { matches, loadedRowCount: 0 };
    }
    const nextCache: UnitFindCache = new Map();
    const loadedRowCount = appendUnitFindMatches({
      units: renderUnits.history,
      indexOffset: 0,
      matches,
      cacheKeyPrefix: `${normalizedFindQuery}:${codeCommentCardsEnabled}`,
      lookups: [historyFindCacheRef.current, tailFindCacheRef.current],
      nextCache,
      build: (unit) =>
        buildFindIndex([unit], conversationFindQuery, {
          projectAssistantCodeComments: codeCommentCardsEnabled,
        }),
    });
    // Keep only the current window; trimmed-away history matches must not keep occupying the cache.
    historyFindCacheRef.current = nextCache;
    return { matches, loadedRowCount };
  }, [
    buildFindIndex,
    codeCommentCardsEnabled,
    conversationFindQuery,
    normalizedFindQuery,
    renderUnits.history,
  ]);
  const conversationFindIndex = useMemo(() => {
    if (!normalizedFindQuery) {
      if (tailFindCacheRef.current.size > 0) tailFindCacheRef.current = new Map();
      return emptyFindIndex;
    }
    const matches = [...historyFindIndex.matches];
    const nextCache: UnitFindCache = new Map();
    // The tail is usually the still-running last turn; running units are not cached; finished units in the tail reuse cache like the history segment.
    const tailRowCount = appendUnitFindMatches({
      units: renderUnits.tail,
      indexOffset: renderUnits.history.length,
      matches,
      cacheKeyPrefix: `${normalizedFindQuery}:${codeCommentCardsEnabled}`,
      lookups: [tailFindCacheRef.current, historyFindCacheRef.current],
      nextCache,
      build: (unit) =>
        buildFindIndex([unit], conversationFindQuery, {
          projectAssistantCodeComments: codeCommentCardsEnabled,
        }),
    });
    tailFindCacheRef.current = nextCache;
    return {
      query: normalizedFindQuery,
      matches,
      matchCount: matches.length,
      loadedRowCount: historyFindIndex.loadedRowCount + tailRowCount,
    };
  }, [
    buildFindIndex,
    codeCommentCardsEnabled,
    conversationFindQuery,
    emptyFindIndex,
    historyFindIndex,
    normalizedFindQuery,
    renderUnits,
  ]);
  const searchResultFindIndex = useMemo(
    () =>
      findStable && searchResultHighlightRequest
        ? buildFindIndex(
            [...renderUnits.history, ...renderUnits.tail],
            searchResultHighlightRequest.query,
            { projectAssistantCodeComments: codeCommentCardsEnabled },
          )
        : emptyFindIndex,
    [
      buildFindIndex,
      codeCommentCardsEnabled,
      emptyFindIndex,
      findStable,
      renderUnits,
      searchResultHighlightRequest,
    ],
  );
  const [resolvedFindActiveIndex, setResolvedFindActiveIndex] = useState(-1);
  const findActiveKeyRef = useRef<ConversationFindMatchKey | null>(null);
  const lastFindQueryRef = useRef("");
  const lastExternalActiveIndexRef = useRef(conversationFindActiveIndex);
  const lastFindScrollKeyRef = useRef("");
  const lastFindHighlightScrollKeyRef = useRef("");
  const lastFindAutoLoadAttemptRef = useRef("");
  const lastSearchResultAutoLoadAttemptRef = useRef("");
  const searchResultAppliedRequestRef = useRef<number | null>(null);
  const searchResultScrollRequestRef = useRef<number | null>(null);
  const searchResultCleanupTimerRef = useRef<number | undefined>(undefined);
  const activeFindMatch =
    resolvedFindActiveIndex >= 0
      ? (conversationFindIndex.matches[resolvedFindActiveIndex] ?? null)
      : null;

  useEffect(() => {
    if (!conversationFindIndex.query) {
      findActiveKeyRef.current = null;
      lastFindQueryRef.current = "";
      lastFindScrollKeyRef.current = "";
      lastFindHighlightScrollKeyRef.current = "";
      setResolvedFindActiveIndex(-1);
      clearConversationFindHighlights();
      onConversationFindMatchStateChange?.({ matchCount: 0, activeIndex: -1 });
      return;
    }

    const queryChanged = lastFindQueryRef.current !== conversationFindIndex.query;
    const externalActiveIndexChanged =
      lastExternalActiveIndexRef.current !== conversationFindActiveIndex;
    let nextActiveIndex = resolveConversationFindActiveIndex(
      conversationFindIndex,
      conversationFindActiveIndex,
    );

    if (!queryChanged && !externalActiveIndexChanged) {
      const rebasedIndex = findConversationMatchIndexByKey(
        conversationFindIndex,
        findActiveKeyRef.current,
      );
      if (rebasedIndex >= 0) {
        nextActiveIndex = rebasedIndex;
      }
    }

    const activeMatch =
      nextActiveIndex >= 0 ? (conversationFindIndex.matches[nextActiveIndex] ?? null) : null;
    findActiveKeyRef.current = getConversationFindMatchKey(activeMatch);
    lastFindQueryRef.current = conversationFindIndex.query;
    lastExternalActiveIndexRef.current = nextActiveIndex;
    setResolvedFindActiveIndex(nextActiveIndex);
    onConversationFindMatchStateChange?.({
      matchCount: conversationFindIndex.matchCount,
      activeIndex: nextActiveIndex,
    });
  }, [conversationFindActiveIndex, conversationFindIndex, onConversationFindMatchStateChange]);

  useEffect(() => {
    if (
      !findStable ||
      !conversationFindIndex.query ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const attemptKey = `${conversationFindIndex.query}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
    if (lastFindAutoLoadAttemptRef.current === attemptKey) {
      return;
    }
    lastFindAutoLoadAttemptRef.current = attemptKey;
    void onLoadOlder?.();
  }, [canLoadOlder, conversationFindIndex.query, findStable, loadingOlder, onLoadOlder, rows]);

  useEffect(() => {
    if (!conversationFindIndex.query || !activeFindMatch) {
      return;
    }
    // Bug root cause: the single-match loop only updated the DOM highlight request; once the match left the
    // virtual window there was no Range left to scroll. Explicit navigation now also drives virtual-window
    // positioning; passive match reports are still deduplicated by the same request key.
    const scrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch.rowId}:${activeFindMatch.rowMatchIndex}:${activeFindMatch.unitIndex}`;
    if (lastFindScrollKeyRef.current === scrollKey) {
      return;
    }
    lastFindScrollKeyRef.current = scrollKey;
    scrollToUnit(activeFindMatch.unitIndex);
  }, [
    activeFindMatch,
    conversationFindIndex.query,
    conversationFindNavigationRequestId,
    scrollToUnit,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !conversationFindIndex.query) {
      clearConversationFindHighlights();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const activeRange = applyConversationFindHighlights({
        root,
        query: conversationFindQuery,
        matches: conversationFindIndex.matches,
        activeMatch: activeFindMatch,
      });
      const highlightScrollKey = `${conversationFindNavigationRequestId}:${conversationFindIndex.query}:${activeFindMatch?.rowId ?? "none"}:${activeFindMatch?.rowMatchIndex ?? -1}:${activeFindMatch?.unitIndex ?? -1}`;
      // Mounted does not mean layout is booked; while sizes are still estimates, centering would use
      // soon-stale coordinates. Confirm the handoff with this batch's actual layout; size commits wake via
      // mountedRowsKey, with no fixed delay.
      if (
        lastFindHighlightScrollKeyRef.current !== highlightScrollKey &&
        isMountedLayoutMeasured()
      ) {
        // Height-measurement compensation pauses on width changes; the target may get pushed out of the
        // virtual window by taller rows ahead. Only unfinished requests reposition on measurement commits;
        // once settled, the user scrolling away must not be pulled back again.
        // Source Markdown markers and link targets may have no DOM Range; a mounted target must finish the
        // request, otherwise window updates triggered by the user scrolling away would pull it back
        // repeatedly. Coarse positioning continues only when the target row is not mounted.
        if (
          !activeRange &&
          activeFindMatch &&
          !getMountedConversationFindRow(root, activeFindMatch.rowId)
        ) {
          scrollToUnit(activeFindMatch.unitIndex);
          return;
        }
        lastFindHighlightScrollKeyRef.current = highlightScrollKey;
        if (activeRange) scrollConversationFindRangeIntoView(activeRange);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    activeFindMatch,
    conversationFindIndex,
    conversationFindQuery,
    conversationFindNavigationRequestId,
    mountedRowsKey,
    isMountedLayoutMeasured,
    scrollToUnit,
    rootRef,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (
      !request ||
      !findStable ||
      !canLoadOlder ||
      loadingOlder ||
      rows.length >= FIND_AUTO_LOAD_ROW_LIMIT
    ) {
      return;
    }
    const snippet = request.snippet?.trim();
    const shouldLoadMore = snippet
      ? !searchResultFindIndex.matches.some((match) =>
          sourceTextContainsSnippet(match.sourceText, snippet),
        )
      : searchResultFindIndex.matchCount === 0;
    if (shouldLoadMore) {
      const attemptKey = `${request.requestId}:${rows[0]?.rowId ?? "none"}:${rows.length}`;
      if (lastSearchResultAutoLoadAttemptRef.current === attemptKey) {
        return;
      }
      lastSearchResultAutoLoadAttemptRef.current = attemptKey;
      void onLoadOlder?.();
    }
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    onLoadOlder,
    rows,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    const request = searchResultHighlightRequest;
    if (!request || !findStable) {
      clearSearchResultHighlight();
      searchResultAppliedRequestRef.current = null;
      searchResultScrollRequestRef.current = null;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      return;
    }

    const match = resolveSearchResultHighlightMatch(searchResultFindIndex, request);
    const snippet = request.snippet?.trim();
    const snippetFound = snippet
      ? searchResultFindIndex.matches.some((candidate) =>
          sourceTextContainsSnippet(candidate.sourceText, snippet),
        )
      : true;
    const canStillLoad = canLoadOlder && rows.length < FIND_AUTO_LOAD_ROW_LIMIT && !loadingOlder;
    if (snippet && !snippetFound && (canStillLoad || loadingOlder)) {
      return;
    }
    if (!match) {
      if (!canStillLoad) {
        onSearchResultHighlightDone?.(request.requestId);
      }
      return;
    }

    if (searchResultScrollRequestRef.current !== request.requestId) {
      searchResultScrollRequestRef.current = request.requestId;
      scrollToUnit(match.unitIndex);
    }

    if (searchResultAppliedRequestRef.current === request.requestId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const range = applySearchResultHighlight({
        root,
        query: request.query,
        match,
      });
      if (!isMountedLayoutMeasured()) {
        return;
      }
      // History search results likewise distinguish not-mounted from not-highlightable, so Range-less requests never hold the scroll forever.
      if (!range && !getMountedConversationFindRow(root, match.rowId)) {
        scrollToUnit(match.unitIndex);
        return;
      }
      searchResultAppliedRequestRef.current = request.requestId;
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
        searchResultCleanupTimerRef.current = undefined;
      }
      if (!range) {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        return;
      }
      scrollConversationFindRangeIntoView(range);
      searchResultCleanupTimerRef.current = window.setTimeout(() => {
        clearSearchResultHighlight();
        onSearchResultHighlightDone?.(request.requestId);
        searchResultCleanupTimerRef.current = undefined;
      }, SEARCH_RESULT_HIGHLIGHT_DURATION_MS);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    canLoadOlder,
    findStable,
    loadingOlder,
    mountedRowsKey,
    isMountedLayoutMeasured,
    onSearchResultHighlightDone,
    rootRef,
    rows,
    scrollToUnit,
    searchResultFindIndex,
    searchResultHighlightRequest,
  ]);

  useEffect(() => {
    return () => {
      clearConversationFindHighlights();
      clearSearchResultHighlight();
      if (searchResultCleanupTimerRef.current !== undefined) {
        window.clearTimeout(searchResultCleanupTimerRef.current);
      }
    };
  }, []);
}
