import { useBotTopicPreparations } from "@/v4/BotTopicPreparation.js";
import { withTopicPreparationMessages } from "@/v4/topicPreparationRenderUnits.js";
/* oxlint-disable eslint(max-lines) -- ConversationTimeline coordinates virtual scrolling, scroll anchoring, loadOlder, and find highlighting; splitting it would pass the same scroll state across files. */
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  QueueItem,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import {
  deriveLogicalUiInstances,
  getPluginUiDisclosureVersion,
  getPluginUiManualPin,
  setPluginUiInstanceDerivation,
  subscribePluginUiDisclosure,
  type PluginUiRowPinResolver,
} from "@/plugin-ui/index.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import type { AssistantFeedbackHandler } from "@/v4/ConversationRowView.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { syncConversationShareSelectionPanelLayout } from "@/v4/conversationShareSelectionPanelLayout.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";
import { armHighspeedFooterExpiryClock } from "@/highspeed/highspeedFooterExpiryClock.js";
import {
  getConversationContentWidthClassName,
  getConversationStatusPanelOffsetClassName,
} from "@/v4/conversationLayout.js";
import {
  buildConversationTurnRenderUnits,
  resolveNextHighspeedExpiryMs,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import {
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
  type ConversationTurnNavigatorHydrationResult,
  type ConversationTurnNavigatorQueryPosition,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  TimelineRowHeightCache,
} from "@/v4/timelineRowHeightCache.js";
import {
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  anchorActionAfterContentChange,
  historyPrefetchTriggerPx,
  initialFollowing,
  isAtBottom,
  prependScrollAdjustment,
  prependVirtualAnchorAdjustment,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  shouldTriggerLoadOlder,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type PrependVirtualAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

// `pendingGuides = []` in memoized component parameters creates a new reference on every call,
// bypassing the stable-reference boundary when the prop is omitted; a shared readonly empty array keeps the default constant.
const EMPTY_PENDING_GUIDES: readonly QueueItem[] = [];

const ROW_OVERSCAN = 8;
const RUNNING_WORK_DURATION_TICK_MS = 1000;
const COMPOSER_MESSAGE_MASK_FADE_PX = 24;
const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
const USER_SCROLL_INTENT_TTL_MS = 1200;
const LAYOUT_SCROLL_GUARD_MS = 250;
const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
const SCROLL_MEMORY_RESTORE_TOLERANCE_PX = 1;

function scheduleMicrotask(callback: () => void): void {
  // Some WebViews/minimal DOM runtimes do not have window.queueMicrotask; inject the scheduler from
  // globalThis and retain a Promise-microtask fallback to avoid interrupting scroll restoration during commit.
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

// The v4 timeline rewrite accidentally rendered the accessible name as visible text, deviating from the old
// circular down-arrow style; render the icon button centrally to prevent visual differences between the two positioning branches.
function ConversationBackToBottomButton({
  className,
  label,
  onClick,
}: {
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      title={label}
      type="button"
      size="icon"
      variant="outline"
      className={cn("rounded-full bg-card hover:bg-card-selected", className)}
      data-testid={TID_V4_TIMELINE_BOTTOM}
      onClick={() =>
        runUserAction({
          input: { featureId: "conversation.navigation", action: "jump_bottom", trigger: "button" },
          operation: onClick,
          completed: { resultSource: "local_commit" },
          failureStage: "timeline_scroll",
        })
      }
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}

interface ConversationScrollMemoryScopeSnapshot {
  key: string;
  state: ChatSessionScrollMemoryState;
}

type PendingScrollMemoryRestoreWait = "rows" | "content";

interface PendingScrollMemoryRestore extends ConversationScrollMemoryScopeSnapshot {
  rowWindowKey: string;
  waitFor: PendingScrollMemoryRestoreWait;
}

function resolvePendingScrollMemoryRestoreWait(
  state: ChatSessionScrollMemoryState | null,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  hasRows: boolean,
): PendingScrollMemoryRestoreWait | null {
  if (!state || state.wasPinnedToBottom !== false) return null;
  if (!hasRows || !element) return "rows";

  const restoredTop = resolveChatSessionScrollRestoreTop(state, element);
  return restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX < state.scrollTop ? "content" : null;
}

function canReleasePendingScrollMemoryRestore(
  pendingRestore: PendingScrollMemoryRestore,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  rowCount: number,
  hasOlderRows: boolean,
  rowWindowKey: string,
): boolean {
  if (!element) return false;
  if (pendingRestore.waitFor === "rows" && rowCount === 0) return false;
  const restoredTop = resolveChatSessionScrollRestoreTop(pendingRestore.state, element);
  const targetIsRepresentable =
    restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX >= pendingRestore.state.scrollTop;
  if (targetIsRepresentable || element.scrollHeight >= pendingRestore.state.scrollHeight) {
    return true;
  }
  // The first rows for a new lease may still be a truncated tail window; while earlier history is available, preserve the original
  // restoration intent so the temporarily clamped scrollTop is not mistaken for the final reading anchor.
  return rowCount > 0 && !hasOlderRows && pendingRestore.rowWindowKey !== rowWindowKey;
}

interface ConversationScrollMemoryScopeCaptureProps {
  scopeKey: string | null;
  capture: (previousKey: string | null) => ConversationScrollMemoryScopeSnapshot | null;
  commit: (snapshot: ConversationScrollMemoryScopeSnapshot | null) => void;
}

/** React before-mutation snapshot: during scope cleanup, an ordinary layout effect would already see the new DOM. */
class ConversationScrollMemoryScopeCapture extends Component<
  ConversationScrollMemoryScopeCaptureProps,
  unknown,
  ConversationScrollMemoryScopeSnapshot | null
> {
  getSnapshotBeforeUpdate(
    previousProps: ConversationScrollMemoryScopeCaptureProps,
  ): ConversationScrollMemoryScopeSnapshot | null {
    if (previousProps.scopeKey === this.props.scopeKey) return null;
    return this.props.capture(previousProps.scopeKey);
  }

  componentDidUpdate(
    _previousProps: ConversationScrollMemoryScopeCaptureProps,
    _previousState: unknown,
    snapshot: ConversationScrollMemoryScopeSnapshot | null,
  ): void {
    this.props.commit(snapshot);
  }

  render(): null {
    return null;
  }
}

/** Vertical equivalent of TanStack's default measurement: prefer ResizeObserver entries (do not trigger synchronous layout). */
function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  const boxSize = entry?.borderBoxSize?.[0];
  if (boxSize) {
    return Math.round(boxSize.blockSize);
  }
  return Math.round(element.getBoundingClientRect().height);
}

function getUnitHeightCacheKey(unit: ConversationTurnRenderUnit | undefined): string | undefined {
  return unit?.key;
}

export interface ConversationTimelineProps {
  rows: readonly ConversationRow[];
  /** On narrow mobile remote-control screens, allow the entire conversation flex chain to shrink to drawer width; keep desktop layout unchanged. */
  compactForRemoteControl?: boolean;
  /** Guide awaiting model-step injection in the CLI-authoritative queue; affects only renderer placement. */
  pendingGuides?: readonly QueueItem[];
  /** Runtime memory state, passed only to the current live turn and excluded from the historical virtual list. */
  apiRetry?: ApiRetryState | null;
  /** Total rows in the projection order (rows.totalCount; exceeds rows.length when the window is truncated, used only for scrollbar estimates/diagnostics). */
  totalCount: number;
  /**
   * Session identity key (sessionId ?? "draft"). Reset scroll anchoring and measurement caches on change:
   * rowId values can repeat between sessions, and measurement caches must not leak across sessions.
   */
  sessionKey: string;
  /** Renderer-local scroll-memory key; null for drafts, which are neither saved nor restored. */
  scrollMemoryKey?: string | null;
  /** Row-rendering context (theme/codePreviewSettings/workspacePath); the host guarantees a stable reference. */
  rowContext: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onPinChange?: import("@/v4/ConversationRowView.js").RowPinChangeHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** Earlier history is available to fetch (the window's first row is after the first row in the full order). */
  canLoadOlder?: boolean;
  /** loadOlder is in flight; suppress repeated triggers. */
  loadingOlder?: boolean;
  /** Fetch an earlier history window (automatically prefetched near the top). */
  onLoadOlder?: () => Promise<void> | void;
  /** After mounting the wide-screen question navigator, load all history for the current active branch in one pass. */
  onLoadAllOlder?: () => Promise<ConversationTurnNavigatorHydrationResult>;
  /**
   * Question-navigation directory invalidation generation (store turnNavigatorDirectoryRevision).
   * Terminal state must be invalidated and queried again after real-user queries are added/removed; include this revision
   * in the component hydration key to avoid a permanent block within the same logEpoch.
   */
  turnNavigatorDirectoryRevision?: number;
  /** Match the old ChatView: the composer dock belongs to the same scroll viewport and sticks to the bottom of the scroll container. */
  bottomDock?: ReactNode;
  /** Shared parent container for the share-selection panel; used to write the dock's actual position in the same coordinate space. */
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  /**
   * Lock background scrolling.
   *
   * The share-selection panel uses only a scrim to isolate pointer events from the body, while the scroll container remains overflow-y-auto.
   * Dragging the native scrollbar or pressing PageUp/Down can still change scrollTop, causing selected targets to drift below the panel.
   */
  backgroundScrollLocked?: boolean;
  /** Optional content when rows are empty; normal empty sessions pass nothing, while draft mode passes a greeting. */
  emptyState?: ReactNode;
  /**
   * Persistent content inside the scroll container, above the message layer (readonly imported-share block + divider).
   *
   * It must be inside the container rather than a fixed banner so it scrolls with the live conversation; it must also render when rows are empty,
   * so it sits outside the emptyState branch.
   */
  headerSlot?: ReactNode;
  /** In draft mode, center emptyState and the same bottomDock together without remounting the composer. */
  centerEmptyStateWithDock?: boolean;
  /** Keep a compact centered layout on narrow/coarse-pointer viewports; do not reuse desktop draft safe spacing. */
  compactEmptyStateWithDock?: boolean;
  /** Layout mode for the right status panel relative to the message column; auto is decided by the conversation container query. */
  summaryPanelLayout?: "none" | "auto" | "inline";
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  sessionPhase?: SessionPhase;
  /** One-time "scroll to bottom" action callable by the host; holds no conversation or cross-renderer state. */
  scrollToBottomActionRef?: { current: (() => void) | null };
  /** One-time query-positioning action callable by the host; does not change the share-panel view. */
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex: number; rowId: number }) => void) | null;
  };
  /** One-time row-positioning action callable by the host (pinned-bar jump); resolves the unit from rowId. */
  scrollToRowActionRef?: { current: ((rowId: number) => void) | null };
  selectionActions?: {
    enabled: boolean;
    sideActionDisabled?: boolean;
    onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
    onAskInSideChat: (reference: ConversationSelectionReference) => void;
  };
  /** Current turn's selection state during share selection; passed only by the desktop share timeline. */
  shareSelection?: {
    eligibleRowIds: ReadonlySet<number>;
    selectedRowIds: ReadonlySet<number>;
    onToggle: (rowId: number) => void;
  };
  /** While share selection is active, the share panel or reopen button exclusively owns the left rail. */
  hideTurnNavigator?: boolean;
}

/**
 * Virtual-scrolling timeline: dynamic measurement (ResizeObserver-driven remeasure) + bottom anchoring +
 * "scroll to bottom". Scroll position/follow state/measurement caches all belong to the component instance; multiple panes
 * (same or different sessions) remain independent. Data subscriptions are shared through a sessionDataLayer lease.
 *
 * React performance: rows change frequently (streaming deltas), so scroll-related callbacks read current values through refs
 * to keep stable references. Follow state is stored in a ref (per-frame changes do not render); only "scroll to bottom" visibility uses state.
 */
function ConversationTimelineImpl({
  rows,
  compactForRemoteControl = false,
  pendingGuides = EMPTY_PENDING_GUIDES,
  apiRetry = null,
  totalCount,
  sessionKey,
  scrollMemoryKey = null,
  rowContext,
  onFork,
  onRetry,
  onFeedbackChange,
  onPinChange,
  onEdit,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadAllOlder,
  turnNavigatorDirectoryRevision = 0,
  bottomDock,
  selectionPanelLayoutContainerRef,
  backgroundScrollLocked = false,
  emptyState,
  headerSlot,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
  summaryPanelLayout = "none",
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  sessionPhase,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  scrollToRowActionRef,
  selectionActions,
  shareSelection,
  hideTurnNavigator = false,
}: ConversationTimelineProps) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  // headerSlot height contributes to virtual-window calculations (scrollMargin) and must track content and width changes,
  // or virtual rows will shift when the readonly block loads or text wraps after the window widens.
  //
  // Depend on whether a slot exists, not headerSlot itself: it is a ReactNode and the host passes inline JSX,
  // so each render creates a new object that would recreate ResizeObserver on every streaming frame.
  const hasHeaderSlot = Boolean(headerSlot);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  useEffect(() => {
    const element = headerSlotRef.current;
    if (!element) {
      setHeaderSlotHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      setHeaderSlotHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasHeaderSlot]);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  // Plugin-card display model—same-resource replacement, automatic expansion for the last three turns, and manual pinning; publish the derived result for cards to read.
  const pluginUiDerivation = useMemo(() => deriveLogicalUiInstances(rows), [rows]);
  useEffect(() => {
    setPluginUiInstanceDerivation(sessionKey, pluginUiDerivation);
  }, [pluginUiDerivation, sessionKey]);
  const pluginUiDisclosureVersion = useSyncExternalStore(
    subscribePluginUiDisclosure,
    getPluginUiDisclosureVersion,
    getPluginUiDisclosureVersion,
  );
  const pluginUiPinResolver = useMemo<PluginUiRowPinResolver>(() => {
    // Rebuild the resolver when manual pin/collapse state changes (version increments), and recompute the collapse boundary.
    void pluginUiDisclosureVersion;
    return (toolCallId) => ({
      disposition: pluginUiDerivation.byToolCallId[toolCallId],
      manualPinned: getPluginUiManualPin(sessionKey, toolCallId),
    });
  }, [pluginUiDerivation, sessionKey, pluginUiDisclosureVersion]);
  const topicPreparations = useBotTopicPreparations();
  const renderUnits = useMemo(
    () =>
      withTopicPreparationMessages(
        buildConversationTurnRenderUnits(rows, {
          nowMs: liveNowMs,
          sessionPhase,
          pluginUiPinResolver,
        }),
        rows,
        topicPreparations,
      ),
    [liveNowMs, pluginUiPinResolver, rows, sessionPhase, topicPreparations],
  );
  const { virtualizedUnits, liveUnit, liveUnitIndex } = useMemo(
    () => splitConversationTimelineLiveTail(renderUnits),
    [renderUnits],
  );
  const hasRunningUnit = useMemo(() => renderUnits.some((unit) => unit.isRunning), [renderUnits]);
  const nextHighspeedExpiryMs = useMemo(
    () => resolveNextHighspeedExpiryMs(rows, liveNowMs),
    [liveNowMs, rows],
  );
  const turnNavigatorQueryRowIds = useMemo(
    () =>
      new Set(
        renderUnits.flatMap((unit) =>
          unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId),
        ),
      ),
    [renderUnits],
  );
  const turnNavigatorQueryRowIdsRef = useRef(turnNavigatorQueryRowIds);
  turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;
  const centeredEmptyLayout = centerEmptyStateWithDock && renderUnits.length === 0;
  const responsiveCenteredEmptyLayout = centeredEmptyLayout && !compactEmptyStateWithDock;
  // High-frequency values are read from refs by stable callbacks (not added to dependency arrays).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const unitsRef = useRef(renderUnits);
  unitsRef.current = renderUnits;
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;
  const liveTailRef = useRef<HTMLDivElement>(null);
  const messageLayerRef = useRef<HTMLDivElement>(null);
  const virtualHistoryRef = useRef<HTMLDivElement>(null);
  const stableContentWidthRef = useRef<number | null>(null);
  const contentWidthResizeActiveRef = useRef(false);
  const contentWidthResizeSettleTimerRef = useRef<number | null>(null);
  const committingMeasuredLayoutRef = useRef(false);
  const messageLayerMaskObserverRef = useRef<ResizeObserver | null>(null);
  const isContentWidthChanging = useCallback(() => {
    const currentContentWidth = virtualHistoryRef.current?.clientWidth ?? null;
    const stableContentWidth = stableContentWidthRef.current;
    return (
      committingMeasuredLayoutRef.current ||
      contentWidthResizeActiveRef.current ||
      (currentContentWidth !== null &&
        stableContentWidth !== null &&
        currentContentWidth !== stableContentWidth)
    );
  }, []);
  // Read loadOlder-related values from refs to keep handleScroll's reference stable.
  const loadOlderRef = useRef({ canLoadOlder, loadingOlder, onLoadOlder });
  loadOlderRef.current = { canLoadOlder, loadingOlder, onLoadOlder };
  const followingRef = useRef(initialFollowing());
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  const userAdjustedScrollSinceRestoreRef = useRef(false);
  const suppressVirtualizerAdjustmentDuringRestoreRef = useRef(false);
  const latestScrollMemoryStateRef = useRef<{
    key: string;
    state: ChatSessionScrollMemoryState;
  } | null>(null);
  const pendingDetachedScrollRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  // scrollTop last accounted for by the component: either read from a scroll event or read back after the component's own
  // programmatic write (bottom anchoring/prepend shift). The bottom effect uses it to reconcile an unobserved scroll
  // (scrolling occurred but no scroll event was dispatched), preventing stale following=true from pulling a user's/test's upward scroll back to the bottom.
  const lastObservedScrollTopRef = useRef(0);
  // Prepend anchoring baseline (first row/total height from the previous commit); see the reconciliation effect below.
  const prependAnchorRef = useRef<{
    firstRowId: number | null;
    totalSize: number;
  }>({ firstRowId: null, totalSize: 0 });
  const pendingPrependVirtualAnchorRef = useRef<PrependVirtualAnchor | null>(null);
  const heightCacheRef = useRef<TimelineRowHeightCache | null>(null);
  if (heightCacheRef.current === null) {
    heightCacheRef.current = new TimelineRowHeightCache();
  }
  const [backToBottomVisible, setBackToBottomVisible] = useState(false);
  const [turnNavigatorViewport, setTurnNavigatorViewport] = useState({
    scrollOffsetPx: 0,
    viewportHeightPx: 0,
    activeQueryRowId: undefined as number | undefined,
  });
  const [turnNavigatorContainerWidthPx, setTurnNavigatorContainerWidthPx] = useState(0);
  const turnNavigatorJumpFrameRef = useRef<number | null>(null);
  const turnNavigatorHydrationAttemptRef = useRef<{
    attemptCount: number;
    key: string | null;
    retryTimer: number | null;
    status: "idle" | "in-flight" | "waiting" | "terminal";
  }>({ attemptCount: 0, key: null, retryTimer: null, status: "idle" });
  const [turnNavigatorHydrationRetryRevision, setTurnNavigatorHydrationRetryRevision] = useState(0);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const shareSelectionPanelLayoutRef = useRef<{
    centerYPx: number;
    maxHeightPx: number;
  } | null>(null);
  // When the right status panel is fully expanded inline, the center message column and input dock must use the same offset;
  // otherwise the panel covers the body instead of appearing side by side.
  const summaryPanelInlineOffsetClassName =
    getConversationStatusPanelOffsetClassName(summaryPanelLayout);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout,
    statusPanelLayout: summaryPanelLayout,
  });

  const syncShareSelectionPanelLayout = useCallback(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    // The selection panel is a sibling of SessionPane, so CSS variables cannot live on Timeline itself
    // or the panel will not receive the dock's actual boundaries. Write them to the shared parent for both to use.
    const layout = syncConversationShareSelectionPanelLayout(container, dock);
    const previous = shareSelectionPanelLayoutRef.current;
    if (previous?.centerYPx === layout.centerYPx && previous.maxHeightPx === layout.maxHeightPx) {
      return;
    }
    shareSelectionPanelLayoutRef.current = layout;
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef]);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    syncShareSelectionPanelLayout();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncShareSelectionPanelLayout);
      resizeObserver.observe(container);
      resizeObserver.observe(timelineRootRef.current ?? container);
      if (scrollRef.current) resizeObserver.observe(scrollRef.current);
      resizeObserver.observe(dock);
    }

    // In some Electron flex layouts, ResizeObserver may run after the window-size callback,
    // so window resize also always triggers a geometry sync to keep the panel aligned as the window grows/shrinks.
    window.addEventListener("resize", syncShareSelectionPanelLayout);
    return () => {
      window.removeEventListener("resize", syncShareSelectionPanelLayout);
      resizeObserver?.disconnect();
    };
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef, syncShareSelectionPanelLayout]);

  useEffect(() => {
    if (!hasRunningUnit) {
      return;
    }

    // Running assistant work should show "Working for N seconds" and advance over time;
    // completed duration is fixed by protocol facts, and the builder rejects this UI clock for ended turns.
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, RUNNING_WORK_DURATION_TICK_MS);

    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);

  useEffect(() => {
    if (nextHighspeedExpiryMs === undefined) return;

    // Root cause: the work clock stops after a session completes. If a Highspeed card expires later,
    // the footer would not appear on its own. Subscribe only to the nearest card-expiry boundary
    // instead of continuously refreshing the entire history list for a countdown.
    // Spec §9.3: expiry wakeups use renderer setTimeout, which Chromium freezes when the window is
    // hidden or occluded. The helper also listens for the window becoming visible/focused and
    // immediately catches liveNowMs up, allowing the footer to appear without another user message.
    // This complements SessionPane's highspeedAutoShareClock wake compensation: that refreshes
    // sharing entry/view-button completion data; this refreshes the visibility clock for the turn footer.
    return armHighspeedFooterExpiryClock(nextHighspeedExpiryMs, () => setLiveNowMs(Date.now()));
  }, [nextHighspeedExpiryMs]);

  useLayoutEffect(() => {
    const element = timelineRootRef.current;
    if (!element) return;

    // After CSS container queries hide the rail, full-history fetching no longer shared its width-eligibility boundary,
    // so mobile remote control and narrow splits also requested every row. Sync only readonly-pagination eligibility here;
    // CSS still decides rail visibility, spacing, and transitions, without restoring composer geometry measurement.
    const commitWidth = (width: number) => {
      const normalizedWidth = Math.max(0, Math.round(width));
      setTurnNavigatorContainerWidthPx((current) =>
        current === normalizedWidth ? current : normalizedWidth,
      );
    };
    const readWidth = () => commitWidth(element.clientWidth);
    readWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const borderBox = entry?.borderBoxSize?.[0];
        commitWidth(borderBox?.inlineSize ?? entry?.contentRect.width ?? element.clientWidth);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", readWidth);
    return () => window.removeEventListener("resize", readWidth);
  }, []);

  useEffect(() => {
    if (
      !shouldHydrateConversationTurnNavigatorDirectory({
        canLoadOlder,
        containerWidthPx: turnNavigatorContainerWidthPx,
        hasLoadHandler: Boolean(onLoadAllOlder),
        loadingOlder,
      })
    ) {
      return;
    }
    // The terminal key must stay in sync with store turnNavigatorDirectoryRevision.
    // With only sessionKey + logEpoch, real-user query changes do not change the epoch,
    // so the component permanently blocks terminal state and the store cannot re-query even after invalidating its cache.
    const hydrationKey = `${sessionKey}:${rowContext.logEpoch ?? "unknown"}:${turnNavigatorDirectoryRevision}`;
    const attempt = turnNavigatorHydrationAttemptRef.current;
    if (attempt.key !== hydrationKey) {
      if (attempt.retryTimer !== null) window.clearTimeout(attempt.retryTimer);
      Object.assign(attempt, {
        attemptCount: 0,
        key: hydrationKey,
        retryTimer: null,
        status: "idle" as const,
      });
    }
    if (attempt.status !== "idle" || !onLoadAllOlder) return;
    attempt.status = "in-flight";
    logger.debug("[v4-turn-navigator] 目录请求补齐完整历史", {
      attempt: attempt.attemptCount + 1,
      loadedRows: rows.length,
      sessionKey,
      totalRows: totalCount,
    });
    void onLoadAllOlder().then((result) => {
      if (attempt.key !== hydrationKey) return;
      if (result.status === "hydrated" || result.status === "not-enough-queries") {
        attempt.status = "terminal";
        return;
      }
      if (result.status === "stale") {
        attempt.status = "idle";
        return;
      }
      attempt.attemptCount += 1;
      const retryDelayMs = resolveConversationTurnNavigatorHydrationRetryDelayMs(
        attempt.attemptCount,
      );
      if (retryDelayMs === null) {
        attempt.status = "terminal";
        return;
      }
      attempt.status = "waiting";
      attempt.retryTimer = window.setTimeout(() => {
        if (attempt.key !== hydrationKey) return;
        attempt.retryTimer = null;
        attempt.status = "idle";
        setTurnNavigatorHydrationRetryRevision((revision) => revision + 1);
      }, retryDelayMs);
    });
  }, [
    canLoadOlder,
    loadingOlder,
    onLoadAllOlder,
    rowContext.logEpoch,
    rows,
    sessionKey,
    totalCount,
    turnNavigatorContainerWidthPx,
    turnNavigatorDirectoryRevision,
    turnNavigatorHydrationRetryRevision,
  ]);

  useEffect(
    () => () => {
      const timer = turnNavigatorHydrationAttemptRef.current.retryTimer;
      if (timer !== null) window.clearTimeout(timer);
    },
    [],
  );

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback(
    (index: number) => virtualizedUnitsRef.current[index]?.key ?? index,
    [],
  );
  // Measurement-cache fallback: when a row unmounts/remounts (or the virtualizer is rebuilt), use its last measured height instead of the fixed estimate.
  const estimateSize = useCallback(
    (index: number) =>
      heightCacheRef.current?.estimate(
        getUnitHeightCacheKey(virtualizedUnitsRef.current[index]),
        DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
      ) ?? DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
    [],
  );
  // Dynamic measurement: the virtualizer attaches ResizeObserver to window elements and calls this when a streaming row grows;
  // also store the actual height in the stable turnId cache.
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
    const height = measureRowHeight(element, entry);
    const indexAttr = element.getAttribute("data-index");
    const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
    const cacheKey = getUnitHeightCacheKey(unit);
    if (cacheKey !== undefined) {
      heightCacheRef.current?.set(cacheKey, height);
    }
    return height;
  }, []);

  const [, commitMeasuredLayout] = useState(0);
  const virtualizer = useVirtualizer({
    count: virtualizedUnits.length,
    getScrollElement,
    estimateSize,
    overscan: ROW_OVERSCAN,
    getItemKey,
    measureElement,
    // headerSlot (read-only imported-share block) and the virtual list share one scroll container,
    // and the header has measurable height. Without accounting for its offset, the virtual window indexes items directly from scrollTop,
    // shifting the rendered window by the header height and leaving the user's scroll position blank.
    scrollMargin: headerSlotHeight,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    return shouldAdjustVirtualizerForItemSizeChange({
      suppressAdjustment: suppressVirtualizerAdjustmentDuringRestoreRef.current,
      following: followingRef.current,
      contentWidthChanging: isContentWidthChanging(),
      itemEnd: item.end,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    });
  };
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const turnNavigatorVirtualItems: ConversationTurnNavigatorVirtualItem[] = useMemo(() => {
    const historyItems = virtualRows.map((row) => ({
      index: row.index,
      size: row.size,
      start: row.start,
    }));
    if (liveUnitIndex === null) return historyItems;
    return [
      ...historyItems,
      {
        index: liveUnitIndex,
        start: totalSize,
        // The live tail is not measured by the virtualizer; filling the remaining scroll area is enough for the directory to determine the current turn.
        size: Number.MAX_SAFE_INTEGER - totalSize,
      },
    ];
  }, [liveUnitIndex, totalSize, virtualRows]);
  const mountedRowsKey = useMemo(
    () =>
      [
        ...virtualRows.map((row) => String(row.key)),
        ...(liveUnit === null ? [] : [String(liveUnit.key)]),
      ].join(":"),
    [liveUnit, virtualRows],
  );

  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);

  const commitFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    setBackToBottomVisible(shouldShowBackToBottom(following, unitsRef.current.length));
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    const interactionActive =
      touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const markLayoutScrollGuard = useCallback(() => {
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);

  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent) => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      const element = scrollRef.current;
      // running → terminal migrates the live tail, collapses work history, and triggers virtualizer measurement in the same frame.
      // An upward scroll must claim scroll ownership before the scroll event; otherwise the terminal layout effect uses stale following=true and pulls the user back to the bottom.
      if (intent === "awayFromBottom" && element && element.scrollHeight > element.clientHeight) {
        commitFollowing(false);
      }
    },
    [commitFollowing],
  );

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      markUserScrollIntent(timelineWheelScrollIntent(event.deltaY));
    },
    [markUserScrollIntent],
  );

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touchClientYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextClientY = event.touches[0]?.clientY;
      const previousClientY = touchClientYRef.current;
      if (nextClientY === undefined || previousClientY === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, nextClientY));
      touchClientYRef.current = nextClientY;
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(() => {
    touchClientYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      markUserScrollIntent(
        timelineKeyboardScrollIntent({
          key: event.key,
          shiftKey: event.shiftKey,
          editableTarget: isEditableScrollTarget(event.target),
        }),
      );
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Clicking content (especially sending from Composer) is not scroll intent. Record an unknown direction only when a scrollbar/blank area
      // hits the scroll container itself, then let the actual scroll position decide.
      if (event.target !== event.currentTarget) return;
      scrollbarPointerIdRef.current = event.pointerId;
      markUserScrollIntent("unknown");
    },
    [markUserScrollIntent],
  );

  const handlePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrollbarPointerIdRef.current === event.pointerId) {
      scrollbarPointerIdRef.current = null;
    }
  }, []);

  const syncMessageLayerMask = useCallback((element: HTMLDivElement) => {
    const messageLayer = messageLayerRef.current;
    if (!messageLayer) return;

    if (
      isAtBottom({
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      })
    ) {
      // At the bottom, messages already end in normal document flow and do not pass behind sticky Composer.
      // Keeping the mask would needlessly fade the last message; apply it only when scrolled away from the bottom.
      messageLayer.style.maskImage = "none";
      messageLayer.style.webkitMaskImage = "none";
      return;
    }

    const viewportHeight = element.clientHeight;
    const transparentStart = Math.max(
      0,
      viewportHeight - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
    );
    const opaqueEnd = Math.max(0, transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX);
    const viewportTopInLayer = Math.max(0, element.scrollTop - messageLayer.offsetTop);
    const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;

    // Transparent dock padding preserves the split-view focus ring, but messages show through the empty area.
    // Align the mask to the scroll viewport and clip only the message layer, never sticky Composer or its buttons.
    messageLayer.style.maskImage = maskImage;
    messageLayer.style.webkitMaskImage = maskImage;
    messageLayer.style.maskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.webkitMaskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.maskSize = `100% ${viewportHeight}px`;
    messageLayer.style.webkitMaskSize = `100% ${viewportHeight}px`;
  }, []);

  const syncTurnNavigatorViewport = useCallback(
    (element: HTMLDivElement) => {
      syncMessageLayerMask(element);
      const viewportRect = element.getBoundingClientRect();
      const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];
      for (const rowElement of element.querySelectorAll<HTMLElement>("[data-row-id]")) {
        const rowId = Number(rowElement.dataset.rowId);
        if (!Number.isSafeInteger(rowId) || !turnNavigatorQueryRowIdsRef.current.has(rowId)) {
          continue;
        }
        const rowRect = rowElement.getBoundingClientRect();
        const start = element.scrollTop + rowRect.top - viewportRect.top;
        queryPositions.push({ rowId, start, end: start + rowRect.height });
      }
      const nextViewport = {
        scrollOffsetPx: element.scrollTop,
        viewportHeightPx: element.clientHeight,
        // Turn-level active can target only the first query in that turn. Derive the current query from the mounted,
        // stable row anchor here; if the virtual turn is not mounted, the component falls back to its unit.
        activeQueryRowId: resolveConversationTurnNavigatorActiveQueryRowId({
          positions: queryPositions,
          scrollOffsetPx: element.scrollTop,
          viewportHeightPx: element.clientHeight,
        }),
      };
      setTurnNavigatorViewport((current) =>
        current.scrollOffsetPx === nextViewport.scrollOffsetPx &&
        current.viewportHeightPx === nextViewport.viewportHeightPx &&
        current.activeQueryRowId === nextViewport.activeQueryRowId
          ? current
          : nextViewport,
      );
    },
    [syncMessageLayerMask],
  );

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const messageLayer = messageLayerRef.current;
    if (!scrollElement || !messageLayer) return;

    const sync = () => syncMessageLayerMask(scrollElement);
    sync();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(sync);
      messageLayerMaskObserverRef.current = observer;
      observer.observe(scrollElement);
      observer.observe(messageLayer);
      return () => {
        observer.disconnect();
        if (messageLayerMaskObserverRef.current === observer)
          messageLayerMaskObserverRef.current = null;
      };
    }

    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [syncMessageLayerMask, renderUnits.length === 0]);

  const buildCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const metrics = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      };
      const wasPinnedToBottom = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
      });
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        wasPinnedToBottom,
        updatedAt: Date.now(),
      };
    },
    [],
  );

  const cacheCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const state = buildCurrentScrollMemoryState(element);
      if (scrollMemoryKey) {
        latestScrollMemoryStateRef.current = { key: scrollMemoryKey, state };
      }
      return state;
    },
    [buildCurrentScrollMemoryState, scrollMemoryKey],
  );

  const notifyScrollObserversAfterCommit = useCallback((element: HTMLDivElement) => {
    scheduleMicrotask(() => {
      if (scrollRef.current !== element) return;
      element.dispatchEvent(new Event("scroll"));
    });
  }, []);

  const captureScrollMemoryBeforeScopeMutation = useCallback(
    (previousKey: string | null): ConversationScrollMemoryScopeSnapshot | null => {
      const pendingRestore = pendingDetachedScrollRestoreRef.current;
      if (pendingRestore?.key === previousKey) {
        // Before session data arrives, the DOM exposes only the clamped scrollTop=0. A task switch must not overwrite
        // the previous memory with an empty timeline; keep the detached restoration intent that has not been applied yet.
        return pendingRestore;
      }
      const element = scrollRef.current;
      if (!previousKey || !element) return null;
      return {
        key: previousKey,
        state: buildCurrentScrollMemoryState(element),
      };
    },
    [buildCurrentScrollMemoryState],
  );

  const commitCapturedScrollMemory = useCallback(
    (snapshot: ConversationScrollMemoryScopeSnapshot | null) => {
      if (!snapshot) return;
      latestScrollMemoryStateRef.current = snapshot;
      saveChatSessionScrollMemoryState(snapshot.key, snapshot.state);
    },
    [],
  );

  // Bottom alignment must be instant (assign scrollTop); smooth intermediate frames would be misclassified as "away from bottom" by scroll handling.
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll();
    // Draft safe-centering allows content to overflow downward when height is low; using real-session bottom alignment
    // would scroll away the safe space above. Drafts always show the top; real sessions continue to follow the bottom.
    element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight;
    // Read back and record the clamped destination (the browser clamps assignments to the maximum scrollable distance).
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    userAdjustedScrollSinceRestoreRef.current = false;
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
  }, [
    cacheCurrentScrollMemoryState,
    responsiveCenteredEmptyLayout,
    markProgrammaticScroll,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
  ]);

  useLayoutEffect(() => {
    const contentColumn = virtualHistoryRef.current;
    if (!contentColumn || typeof ResizeObserver === "undefined") return;

    stableContentWidthRef.current = contentColumn.clientWidth;
    let observedViewportHeight = scrollRef.current?.clientHeight ?? 0;
    let observeContentFrame: number | null = null;
    let disposed = false;
    const observer = new ResizeObserver(() => {
      const nextWidth = contentColumn.clientWidth;
      const element = scrollRef.current;
      if (!element) return;
      const viewportHeightChanged = observedViewportHeight !== element.clientHeight;
      observedViewportHeight = element.clientHeight;
      if (nextWidth === stableContentWidthRef.current && !viewportHeightChanged) return;
      markLayoutScrollGuard();
      commitFollowing(
        reconcileFollowingForContentAnchor({
          following: followingRef.current,
          metrics: {
            scrollTop: element.scrollTop,
            viewportHeight: element.clientHeight,
            contentHeight: element.scrollHeight,
          },
          lastObservedScrollTop: lastObservedScrollTopRef.current,
          userScrollIntent: getActiveUserScrollIntent(),
        }),
      );
      if (followingRef.current) {
        if (contentWidthResizeSettleTimerRef.current !== null) {
          window.clearTimeout(contentWidthResizeSettleTimerRef.current);
          contentWidthResizeSettleTimerRef.current = null;
        }
        // Commit layout and scroll-to-bottom together for this batch; other content effects must not scroll using an intermediate height.
        observer.unobserve(contentColumn);
        const messageLayer = messageLayerRef.current;
        const maskObserver = messageLayerMaskObserverRef.current;
        // Synchronously updating the placeholder height also changes the parent message layer's
        // height, so pause its overlay observer too. Otherwise, changing the parent from a deeper
        // ResizeObserver notification can produce undelivered notifications.
        if (messageLayer) maskObserver?.unobserve(messageLayer);
        committingMeasuredLayoutRef.current = true;
        try {
          // The virtualizer's ResizeObserver normally commits React updates asynchronously. Scrolling
          // to the bottom first would use the old placeholder height, then jump again after the next
          // frame's measurement. Measure in a batch and commit synchronously inside the observer to avoid catching up across frames.
          const measurements = Array.from(
            contentColumn.querySelectorAll(":scope > [data-index]"),
            (node) => ({
              index: Number(node.getAttribute("data-index")),
              height: measureElement(node, undefined),
            }),
          );
          flushSync(() => {
            for (const item of measurements) virtualizer.resizeItem(item.index, item.height);
            // The cache may already be updated with no delta; still commit explicitly instead of relying on an empty callback to flush old work.
            commitMeasuredLayout((revision) => revision + 1);
          });
        } finally {
          committingMeasuredLayoutRef.current = false;
          // Pause only the observer target whose height this batch updates; do not defer measurement
          // or scrolling to the bottom. Continue observing the content-column width next frame to
          // cover CSS width transitions that continue after viewport resizing stops.
          if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
          if (!disposed) {
            observeContentFrame = window.requestAnimationFrame(() => {
              observeContentFrame = null;
              observer.observe(contentColumn);
              if (
                messageLayer &&
                messageLayerRef.current === messageLayer &&
                messageLayerMaskObserverRef.current === maskObserver
              )
                maskObserver?.observe(messageLayer);
            });
          }
        }
        if (disposed) return;
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        // Synchronous commits may trigger other layout work; user scrolling up or navigating to a position always takes precedence.
        if (followingRef.current && getActiveUserScrollIntent() !== "awayFromBottom")
          scrollToBottom();
        return;
      }
      if (nextWidth === stableContentWidthRef.current) return;

      // Width changes make virtual rows remeasure in batches; compensating per row or following the bottom per batch
      // would repeatedly rewrite scrollTop. Pause both during resize and align once after dimensions stabilize.
      contentWidthResizeActiveRef.current = true;
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
      }
      contentWidthResizeSettleTimerRef.current = window.setTimeout(() => {
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        contentWidthResizeSettleTimerRef.current = null;
        if (followingRef.current) {
          scrollToBottom();
        }
      }, CONTENT_WIDTH_RESIZE_SETTLE_MS);
    });
    observer.observe(contentColumn);
    if (scrollRef.current) observer.observe(scrollRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
        contentWidthResizeSettleTimerRef.current = null;
      }
      contentWidthResizeActiveRef.current = false;
    };
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    markLayoutScrollGuard,
    measureElement,
    renderUnits.length === 0,
    scrollToBottom,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = getUnitHeightCacheKey(liveUnit ?? undefined);
    if (!element || cacheKey === undefined) return;

    const cacheHeight = (entry?: ResizeObserverEntry) => {
      const height = measureRowHeight(element, entry);
      heightCacheRef.current?.set(cacheKey, height);
      return height;
    };
    let observedHeight = cacheHeight();
    if (typeof ResizeObserver === "undefined") return;

    // The parent layout effect for a projection revision may run before the Markdown subtree finishes measuring.
    // The old observer only cached height, so content first pushed the loading slot away and corrected scrollTop in a later commit.
    // ResizeObserver gets the true height before paint; align to the bottom here only while following still owns scroll control.
    // If the user has scrolled up (including a race before the scroll event is recorded), cache the height without taking back their reading position.
    const observer = new ResizeObserver((entries) => {
      const nextHeight = cacheHeight(entries[0]);
      if (nextHeight === observedHeight) return;
      observedHeight = nextHeight;

      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      markLayoutScrollGuard();
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: scrollElement.scrollTop,
          viewportHeight: scrollElement.clientHeight,
          contentHeight: scrollElement.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
      if (anchorActionAfterContentChange(following, isContentWidthChanging()) === "stickToBottom") {
        scrollToBottom();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    liveUnit?.key,
    markLayoutScrollGuard,
    scrollToBottom,
  ]);

  const saveCurrentScrollMemory = useCallback(() => {
    const key = scrollMemoryKey;
    const element = scrollRef.current;
    if (!key) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const cached = latestScrollMemoryStateRef.current;
    const cachedState = cached?.key === key ? cached.state : null;
    const state =
      pendingRestore?.key === key
        ? pendingRestore.state
        : element
          ? cacheCurrentScrollMemoryState(element)
          : cachedState;
    if (state) saveChatSessionScrollMemoryState(key, state);
  }, [cacheCurrentScrollMemoryState, scrollMemoryKey]);

  const restoreScrollMemory = useCallback(
    (state: ChatSessionScrollMemoryState) => {
      const element = scrollRef.current;
      if (!element) return;
      clearUserScrollIntent();
      markProgrammaticScroll();
      element.scrollTop = resolveChatSessionScrollRestoreTop(state, element);
      lastObservedScrollTopRef.current = element.scrollTop;
      followingRef.current = false;
      setBackToBottomVisible(shouldShowBackToBottom(false, unitsRef.current.length));
      syncTurnNavigatorViewport(element);
      userAdjustedScrollSinceRestoreRef.current = false;
      cacheCurrentScrollMemoryState(element);
    },
    [
      cacheCurrentScrollMemoryState,
      clearUserScrollIntent,
      markProgrammaticScroll,
      syncTurnNavigatorViewport,
    ],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // User input takes priority. Other scrolls inside content/measurement guards count as layout compensation; unclassified events outside
    // those guards remain real user scrolling, preserving native scrollbar and assistive-technology behavior.
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : Date.now() <= layoutScrollGuardUntilRef.current
            ? "layout"
            : "user";
    // The virtualizer's native offset observer records before React onScroll; at this point it has seen the restored scrollTop.
    // A user scroll should also end the protection window immediately and return scroll ownership to the user.
    if (scrollSource !== "layout") {
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    }
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    const following = resolveFollowingAfterScroll({
      following: followingRef.current,
      source: scrollSource,
      metrics: {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      },
    });
    commitFollowing(following);
    if (scrollSource === "user") {
      pendingDetachedScrollRestoreRef.current = null;
      userAdjustedScrollSinceRestoreRef.current = true;
      saveCurrentScrollMemory();
    }
    // If paging starts only at the 64px top edge, the user reaches the window boundary before seeing new content appear.
    // Prefetch two viewports ahead so the shared Desktop/mobile Web renderer loads the page before the user reaches the edge.
    const loadOlder = loadOlderRef.current;
    const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
    if (
      shouldTriggerLoadOlder({
        scrollTop: element.scrollTop,
        canLoadOlder: loadOlder.canLoadOlder,
        loadingOlder: loadOlder.loadingOlder,
        triggerPx,
      })
    ) {
      // If the prepend exceeds viewport + overscan, the old visible turn unmounts and cannot serve as a DOM anchor across
      // commits; save the measurement start maintained by the virtualizer's stable turn key instead.
      const anchorMeasurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
      const anchorUnit = anchorMeasurement
        ? virtualizedUnitsRef.current[anchorMeasurement.index]
        : undefined;
      pendingPrependVirtualAnchorRef.current =
        anchorMeasurement && anchorUnit?.key === anchorMeasurement.key
          ? {
              key: anchorUnit.key,
              offsetTop: anchorMeasurement.start - element.scrollTop,
              start: anchorMeasurement.start,
            }
          : null;
      logger.debug("[v4-timeline] 接近历史窗口顶部，自动预取更早行", {
        scrollTop: element.scrollTop,
        triggerPx,
      });
      loadOlder.onLoadOlder?.();
    }
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    saveCurrentScrollMemory,
    syncTurnNavigatorViewport,
    virtualizer,
  ]);

  const handleBackToBottom = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    clearUserScrollIntent();
    commitFollowing(true);
    scrollToBottom();
    // scrollToBottom updates only a component ref. If the user switches tasks immediately afterward, scope cleanup/scroll
    // handling may not have run yet, and the old Map could restore the next task to the middle or top.
    saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, saveCurrentScrollMemory, scrollToBottom]);

  useLayoutEffect(() => {
    if (!scrollToBottomActionRef) return;
    scrollToBottomActionRef.current = handleBackToBottom;
    return () => {
      // Clear only actions registered by this instance so an old cleanup after a pane switch cannot override the new timeline.
      if (scrollToBottomActionRef.current === handleBackToBottom) {
        scrollToBottomActionRef.current = null;
      }
    };
  }, [handleBackToBottom, scrollToBottomActionRef]);

  const scrollToQuery = useCallback(
    (target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }

      const scrollMountedQuery = (element: HTMLDivElement): boolean => {
        const rowElement = element.querySelector<HTMLElement>(`[data-row-id="${target.rowId}"]`);
        if (!rowElement) return false;
        const targetTop =
          element.scrollTop +
          rowElement.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        logger.debug("[v4-turn-navigator] 定位用户 query", {
          behavior,
          rowId: target.rowId,
          unitIndex: target.unitIndex,
        });
        return true;
      };

      const element = scrollRef.current;
      if (!element || scrollMountedQuery(element)) return;

      // A product turn is the virtual list's smallest mounted unit; the steer query is an anchor within it. If the target is not mounted,
      // first mount its turn without animation, then scroll precisely to the row according to the user's motion preference; do not fall back to the turn's start.
      if (target.unitIndex === liveUnitIndex) {
        const liveTail = liveTailRef.current;
        if (liveTail) {
          element.scrollTop =
            element.scrollTop +
            liveTail.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
        }
      } else {
        virtualizer.scrollToIndex(target.unitIndex, {
          align: "start",
          behavior: "auto",
        });
      }

      let remainingAttempts = 12;
      const alignMountedQuery = () => {
        turnNavigatorJumpFrameRef.current = null;
        const currentElement = scrollRef.current;
        if (currentElement && scrollMountedQuery(currentElement)) return;
        remainingAttempts -= 1;
        if (remainingAttempts <= 0) {
          logger.warn("[v4-turn-navigator] query 锚点挂载超时", {
            rowId: target.rowId,
            unitIndex: target.unitIndex,
          });
          return;
        }
        turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
      };
      turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useLayoutEffect(() => {
    if (!scrollToQueryActionRef) return;
    const action = (target: { unitIndex: number; rowId: number }) => {
      scrollToQuery(target);
    };
    scrollToQueryActionRef.current = action;
    return () => {
      if (scrollToQueryActionRef.current === action) {
        scrollToQueryActionRef.current = null;
      }
    };
  }, [scrollToQuery, scrollToQueryActionRef]);

  // Pinned-bar jump: reuse the query-positioning path, resolving the row's product-turn unit first so
  // virtualized (unmounted) targets still land precisely on the row.
  const scrollToRow = useCallback(
    (rowId: number) => {
      const unitIndex = renderUnits.findIndex((unit) =>
        unit.renderRows.some((row) => row.rowId === rowId),
      );
      if (unitIndex === -1) {
        logger.warn("[v4-pinned-bar] 目标消息不在当前渲染单元中", { rowId });
        return;
      }
      scrollToQuery({ unitIndex, rowId }, "smooth");
    },
    [renderUnits, scrollToQuery],
  );

  useLayoutEffect(() => {
    if (!scrollToRowActionRef) return;
    scrollToRowActionRef.current = scrollToRow;
    return () => {
      if (scrollToRowActionRef.current === scrollToRow) {
        scrollToRowActionRef.current = null;
      }
    };
  }, [scrollToRow, scrollToRowActionRef]);

  useEffect(
    () => () => {
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
    },
    [sessionKey],
  );

  const scrollToUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (unitIndex === liveUnitIndex) {
        const element = scrollRef.current;
        const liveTail = liveTailRef.current;
        if (!element || !liveTail) return;
        const targetTop =
          element.scrollTop +
          liveTail.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      virtualizer.scrollToIndex(unitIndex, { align: "start", behavior });
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useConversationTimelineFind({
    rootRef: scrollRef,
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
  });

  const saveCurrentScrollMemoryRef = useRef(saveCurrentScrollMemory);
  saveCurrentScrollMemoryRef.current = saveCurrentScrollMemory;

  useLayoutEffect(() => {
    return () => {
      // During real unmount, the DOM is still present; for scope updates, before-mutation capture reads the old DOM.
      saveCurrentScrollMemoryRef.current();
    };
  }, []);

  const rowCount = renderUnits.length;
  const rowWindowKey = `${rows.length}:${rows[0]?.rowId ?? "none"}:${rows[rows.length - 1]?.rowId ?? "none"}`;
  const pendingGuideKey = pendingGuides.map((item) => item.queueItemId).join(":");

  // After V4 migration removed the old ChatView scroll hook, the sessionKey effect still always scrolled to the bottom,
  // disconnecting the remaining renderer-local memory module. Clear measurements, remeasure, then restore by scope here.
  // Write immediately in the first layout to avoid a flash, correct asynchronous measurements next frame, and leave scroll control with the user.
  useLayoutEffect(() => {
    clearUserScrollIntent();
    heightCacheRef.current?.clear();
    // Reset the prepend-anchor baseline too: rowId may repeat across sessions, so never compare against the old session's first row.
    prependAnchorRef.current = { firstRowId: null, totalSize: 0 };
    pendingPrependVirtualAnchorRef.current = null;
    // Draft's default bottom alignment can leave an old virtualizer.scrollOffset. Before restoration writes and dispatches a scroll event,
    // continued correction using that old offset could push the restored history position back to the draft location.
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    virtualizer.measure();
    userAdjustedScrollSinceRestoreRef.current = false;

    const restoredState = readChatSessionScrollMemoryState(scrollMemoryKey);
    const pendingRestoreWait = resolvePendingScrollMemoryRestoreWait(
      restoredState,
      scrollRef.current,
      unitsRef.current.length > 0,
    );
    pendingDetachedScrollRestoreRef.current =
      scrollMemoryKey && restoredState && pendingRestoreWait
        ? {
            key: scrollMemoryKey,
            rowWindowKey,
            state: restoredState,
            waitFor: pendingRestoreWait,
          }
        : null;
    const restore = () => {
      if (!restoredState || restoredState.wasPinnedToBottom === true) {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
        followingRef.current = initialFollowing();
        setBackToBottomVisible(false);
        scrollToBottom();
        return;
      }
      restoreScrollMemory(restoredState);
    };

    restore();
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (!userAdjustedScrollSinceRestoreRef.current) {
        restore();
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    clearUserScrollIntent,
    restoreScrollMemory,
    scrollMemoryKey,
    scrollToBottom,
    sessionKey,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    if (rowCount === 0 || !pendingRestore || pendingRestore.key !== scrollMemoryKey) {
      return;
    }

    // Session scope often commits before the rows subscription completes. Restoring only at the scope commit and next frame
    // clamps historical scrollTop to 0. Apply restoration again when the first content arrives, then wait one more frame to correct measurements.
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    restoreScrollMemory(pendingRestore.state);
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (
        pendingDetachedScrollRestoreRef.current === pendingRestore &&
        !userAdjustedScrollSinceRestoreRef.current
      ) {
        restoreScrollMemory(pendingRestore.state);
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        if (
          pendingDetachedScrollRestoreRef.current === pendingRestore &&
          canReleasePendingScrollMemoryRestore(
            pendingRestore,
            scrollRef.current,
            rowCount,
            canLoadOlder || totalCount > rows.length,
            rowWindowKey,
          )
        ) {
          pendingDetachedScrollRestoreRef.current = null;
        }
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    canLoadOlder,
    restoreScrollMemory,
    rowCount,
    rowWindowKey,
    scrollMemoryKey,
    totalCount,
    totalSize,
  ]);

  // Prepend anchoring: shift scrollTop when loadOlder inserts history before the current rows so the reading position does not jump.
  // Existing turns keep turnId keys and valid measurements; prepending increases total height by delta, so scrollTop += delta restores the anchor
  // before paint without flicker. This effect is declared after the session-switch effect, which resets the baseline before reconciliation on a switch,
  // preventing a rowId from another session from being mistaken for a prepend.
  useLayoutEffect(() => {
    const prev = prependAnchorRef.current;
    const nextFirstRowId = rowsRef.current[0]?.rowId ?? null;
    const nextTotalSize = virtualizer.getTotalSize();
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const pendingRestoreOwnsAnchor = pendingRestore?.key === scrollMemoryKey;
    const didPrepend =
      prev.firstRowId !== null && nextFirstRowId !== null && nextFirstRowId < prev.firstRowId;
    let viewportAdjustment: number | null = null;
    if (didPrepend && !pendingRestoreOwnsAnchor && scrollRef.current) {
      const previousVirtualAnchor = pendingPrependVirtualAnchorRef.current;
      const nextAnchorMeasurement = previousVirtualAnchor
        ? virtualizer.measurementsCache.find(
            (measurement) => measurement.key === previousVirtualAnchor.key,
          )
        : undefined;
      if (previousVirtualAnchor && nextAnchorMeasurement) {
        viewportAdjustment = prependVirtualAnchorAdjustment(
          previousVirtualAnchor,
          {
            key: previousVirtualAnchor.key,
            offsetTop: previousVirtualAnchor.offsetTop,
            start: nextAnchorMeasurement.start,
          },
          scrollRef.current.scrollTop,
        );
      }
    }
    if (didPrepend) pendingPrependVirtualAnchorRef.current = null;
    const adjustment = pendingRestoreOwnsAnchor
      ? null
      : (viewportAdjustment ??
        prependScrollAdjustment({
          prevFirstRowId: prev.firstRowId,
          nextFirstRowId,
          prevTotalSize: prev.totalSize,
          nextTotalSize,
        }));
    if (adjustment !== null && scrollRef.current) {
      const element = scrollRef.current;
      markLayoutScrollGuard();
      element.scrollTop += adjustment;
      // Record programmatic shifts too so the bottom-alignment reconciliation below does not misread them as an unobserved scroll.
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      cacheCurrentScrollMemoryState(element);
      // When thousands of rows are prepended at once, measurement cache and scrollTop update in one commit. Chromium may coalesce the native scroll event,
      // leaving the virtualizer to mount the first screen using the old offset: the scrollbar is at the bottom but the body is blank.
      // After commit, dispatch a read-only notification for the final position. If user wheel/pointer intent exists in the same frame,
      // handleScroll still recognizes it as user input and does not take back scroll control.
      notifyScrollObserversAfterCommit(element);
    }
    // A pending away-from-bottom memory uses this commit's coordinate system; do not let prepend shift its temporary clamped value again.
    // The restoration effect replays the original position on the next frame of this commit using the final content height.
    prependAnchorRef.current = {
      firstRowId: nextFirstRowId,
      totalSize: nextTotalSize,
    };
  });

  // Bottom anchoring: when content changes (new row/streaming delta/dynamic height correction → totalSize change),
  // follow the bottom if following is active; otherwise preserve reading position. useLayoutEffect aligns before paint to avoid flicker.
  // A terminal transition moves the live tail, auto-collapses work history, and triggers multi-stage virtualizer measurement;
  // these scrollTop shifts are layout changes and must preserve following. If the user scrolls up in the same frame,
  // the capture handler records awayFromBottom first and this effect must yield.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    markLayoutScrollGuard();
    if (element) {
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
    }
    if (
      anchorActionAfterContentChange(followingRef.current, isContentWidthChanging()) ===
      "stickToBottom"
    ) {
      scrollToBottom();
    }
  }, [
    getActiveUserScrollIntent,
    isContentWidthChanging,
    markLayoutScrollGuard,
    commitFollowing,
    headerSlotHeight,
    pendingGuideKey,
    rowCount,
    rows,
    scrollToBottom,
    totalSize,
  ]);

  useLayoutEffect(() => {
    if (scrollRef.current) {
      syncTurnNavigatorViewport(scrollRef.current);
    }
  }, [pendingGuideKey, rowCount, syncTurnNavigatorViewport, totalSize]);

  // When rows are cleared (for example, a broad editUserQuery rewind), reset to following and hide the button;
  // when rows return, the bottom-anchor effect above aligns them.
  useEffect(() => {
    if (rowCount === 0) {
      if (pendingDetachedScrollRestoreRef.current?.key === scrollMemoryKey) {
        return;
      }
      followingRef.current = initialFollowing();
      if (backToBottomVisible) {
        setBackToBottomVisible(false);
      }
    }
  }, [rowCount, backToBottomVisible, scrollMemoryKey]);

  useEffect(() => {
    return () => {
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
        programmaticScrollFrameRef.current = null;
      }
    };
  }, []);

  // Raw projection rows and render units merged by turn use different units.
  // Expose them separately so restoration/paging checks do not mistake visible units for persisted rows.
  return (
    <div
      ref={timelineRootRef}
      className={cn("relative flex min-h-0 flex-1 flex-col", compactForRemoteControl && "min-w-0")}
    >
      {selectionActions ? (
        <ConversationSelectionTooltip
          rootRef={scrollRef}
          rows={rows}
          sourceSessionId={sessionKey}
          enabled={selectionActions.enabled}
          sideActionDisabled={selectionActions.sideActionDisabled}
          onAddToCurrentTask={selectionActions.onAddToCurrentTask}
          onAskInSideChat={selectionActions.onAskInSideChat}
        />
      ) : null}
      <ConversationScrollMemoryScopeCapture
        scopeKey={scrollMemoryKey}
        capture={captureScrollMemoryBeforeScopeMutation}
        commit={commitCapturedScrollMemory}
      />
      {/* Bugfix: During share selection, the share panel or reopen button owns the left rail whether the
          panel is expanded or collapsed. Hide turn navigation to prevent the absolutely
          positioned controls from overlapping; it returns automatically when share selection ends. */}
      {hideTurnNavigator ? null : (
        <ConversationTurnNavigator
          renderUnits={renderUnits}
          isHydratingDirectory={loadingOlder}
          scrollOffsetPx={virtualizer.scrollOffset ?? turnNavigatorViewport.scrollOffsetPx}
          viewportHeightPx={
            virtualizer.scrollRect?.height ?? turnNavigatorViewport.viewportHeightPx
          }
          virtualItems={turnNavigatorVirtualItems}
          activeQueryRowId={turnNavigatorViewport.activeQueryRowId}
          onJumpToQuery={scrollToQuery}
        />
      )}
      <div
        ref={scrollRef}
        data-testid={TID_V4_TIMELINE}
        data-v4-timeline-scroll="true"
        data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}
        data-markdown-table-layout-root="true"
        data-row-count={rows.length}
        data-window-row-count={rows.length}
        data-render-unit-count={renderUnits.length}
        data-total-row-count={totalCount}
        data-following={backToBottomVisible ? "false" : "true"}
        data-loading-older={loadingOlder ? "true" : "false"}
        onKeyDownCapture={handleKeyDownCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onScroll={handleScroll}
        onTouchCancelCapture={handleTouchEndCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onWheelCapture={handleWheelCapture}
        className={cn(
          // When the native scrollbar appears based on content height, it narrows the conversation viewport and makes messages/Composer shift horizontally.
          // Reserve a stable gutter so Desktop and mobile Web keep the same scroll-area width.
          // Declaring only overflow-y-auto makes the browser calculate the horizontal axis as auto, allowing wide content to create horizontal scrolling for the whole Conversation.
          // Tables and code blocks should scroll inside their own containers.
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px] max-md:[--markdown-table-layout-left-inset:8px] max-md:[--markdown-table-layout-right-inset:8px]",
          // When the share-selection panel is open, switch to overflow-hidden. scrollTop and scrollbar-gutter stay unchanged,
          // but the native scrollbar, wheel, and keyboard paging can no longer move the background, so selection targets do not drift.
          backgroundScrollLocked && "!overflow-y-hidden",
          compactForRemoteControl && "min-w-0",
          // Root cause: Conversation turn map covers the leftmost 48px of the timeline; if table-enhanced scrolling still uses
          // the normal 16px margin, 32px falls underneath the turn map; include the full occupied width in the left boundary.
          turnNavigatorQueryRowIds.size >= 2 &&
            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]",
        )}
      >
        <div
          className={cn(
            // A fixed-height breakpoint makes the greeting and Composer jump together when the window crosses the threshold.
            // Scale top whitespace with viewport height so the input position is independent of the recommendation list below;
            // when space is short, the top can shrink to its minimum while the bottom follows content naturally.
            responsiveCenteredEmptyLayout
              ? // Bugfix root cause: dynamically changing the native window minimum feeds content reflow back into window dragging and causes lag;
                // Keep the container's intrinsic minimum height; the outer timeline handles overflow when height is constrained.
                "flex min-h-full flex-col items-center px-4 before:block before:min-h-[52px] before:w-full before:shrink before:basis-[29dvh] before:content-[''] after:block after:min-h-4 after:w-full after:flex-1 after:content-['']"
              : centeredEmptyLayout
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-4"
                : "flex min-h-full flex-col",
          )}
          // When a session switches to draft, content height drops sharply. Chrome may select sticky Composer in the subtree
          // as the native scroll anchor and overwrite layout/RAF restoration values on the way back.
          // V4 manages prepend, bottom alignment, and memory anchors itself; as with other virtual lists, disable anchor candidates in the content subtree.
          style={{ overflowAnchor: "none" }}
        >
          {renderUnits.length === 0 && !headerSlot ? (
            <div
              className={cn(
                centeredEmptyLayout
                  ? "flex w-full max-w-2xl shrink-0 items-center justify-center"
                  : "min-h-0 flex-1",
                !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
              )}
            >
              {emptyState}
            </div>
          ) : (
            <div
              ref={messageLayerRef}
              data-v4-timeline-message-layer="true"
              data-sandbox-page-container="true"
              className="relative w-full flex-1 [mask-repeat:no-repeat] [-webkit-mask-repeat:no-repeat]"
            >
              {/*
               * headerSlot must be inside the masked message layer and use the same width classes as the live message column;
               * outside that layer it would be wider than the body and show through beneath sticky Composer.
               */}
              {headerSlot ? (
                <div
                  ref={headerSlotRef}
                  data-v4-timeline-header-slot="true"
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  {headerSlot}
                </div>
              ) : null}
              <div
                ref={virtualHistoryRef}
                data-v4-timeline-virtual-history="true"
                data-v4-timeline-content-column="true"
                className={cn(
                  // By default (< 1280px), transition width/max-width/transform for a smooth switch between w-full and max-w-4xl.
                  // At ≥1280px, the panel-reveal layout (max-w-6xl + 168px left shift) uses @min-[1280px] to transition only transform,
                  // avoiding a large width jump stacked with the movement animation.
                  "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  summaryPanelInlineOffsetClassName,
                )}
                style={{ height: totalSize }}
              >
                {virtualRows.map((virtualRow) => {
                  const unit = virtualizedUnits[virtualRow.index];
                  if (!unit) return null;
                  return (
                    <div
                      key={`${virtualRow.key}:${rowContext.logEpoch ?? ""}`}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      // Virtual-history children are absolutely positioned, so parent padding does not shrink
                      // their containing block. Responsive body padding must live on the turn wrapper itself.
                      className="absolute left-0 top-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start - headerSlotHeight}px)` }}
                    >
                      <ConversationTurnGroup
                        unit={unit}
                        nowMs={liveNowMs}
                        apiRetry={null}
                        context={rowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onPinChange={onPinChange}
                        onEdit={onEdit}
                        shareSelection={shareSelection}
                      />
                    </div>
                  );
                })}
              </div>
              {liveUnit !== null && liveUnitIndex !== null ? (
                <div
                  key={`${liveUnit.key}:${rowContext.logEpoch ?? ""}`}
                  ref={liveTailRef}
                  data-index={liveUnitIndex}
                  data-v4-running-live-tail="true"
                  data-v4-turn-unit="true"
                  data-turn-id={liveUnit.turnId}
                  data-v4-timeline-content-column="true"
                  className={cn(
                    // At ≥1280px, when the panel is revealed, transition only transform to avoid a large jump combined with movement jitter.
                    "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationTurnGroup
                    unit={liveUnit}
                    nowMs={liveNowMs}
                    apiRetry={apiRetry}
                    context={rowContext}
                    onFork={onFork}
                    onRetry={onRetry}
                    onFeedbackChange={onFeedbackChange}
                    onPinChange={onPinChange}
                    onEdit={onEdit}
                    shareSelection={shareSelection}
                  />
                </div>
              ) : null}
              {pendingGuides.length > 0 ? (
                <div
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationPendingGuideList
                    context={rowContext}
                    items={pendingGuides}
                    turnId={
                      liveUnit?.turnId ??
                      rows.at(-1)?.productTurnId ??
                      rows.at(-1)?.turnId ??
                      "pending-guide"
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
          {bottomDock ? (
            <div
              ref={composerDockRef}
              data-v4-composer-dock="true"
              className={cn(
                // The sticky dock is a full-width transparent z-20 layer and used to cover z-10 rail buttons in Composer's left padding.
                // The shell does not receive events; only the actual content column restores hit testing.
                "pointer-events-none z-20 flex w-full justify-center",
                responsiveCenteredEmptyLayout
                  ? "mt-3 shrink-0"
                  : centeredEmptyLayout
                    ? "shrink-0"
                    : "sticky bottom-0",
              )}
            >
              <div
                data-v4-composer-dock-content="true"
                className={cn(
                  // As with virtual history/live tail, restore the width transition to avoid a hard jump.
                  // At ≥1280px, when the panel is revealed, transition only transform to avoid a large jump combined with movement jitter.
                  "pointer-events-auto relative z-10 w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  !centeredEmptyLayout && "px-4 pb-4",
                  !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
                )}
              >
                <div data-v4-back-to-bottom-anchor="composer-dock" className="relative">
                  {backToBottomVisible ? (
                    <ConversationBackToBottomButton
                      // In split view, Composer is a sticky dock inside the scroll viewport. If the button is attached to the outer timeline's absolute bottom,
                      // it is positioned relative to the entire pane and lands below the input.
                      //
                      // The round button has its own centered positioning. Keep `pointer-events-auto`:
                      // it is the only contract guaranteeing the button can be clicked.
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 shadow-sm"
                      label={intl.formatMessage({ id: "chat.scrollToBottom" })}
                      onClick={handleBackToBottom}
                    />
                  ) : null}
                  {bottomDock}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {backToBottomVisible && !bottomDock ? (
        <ConversationBackToBottomButton
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          label={intl.formatMessage({ id: "chat.scrollToBottom" })}
          onClick={handleBackToBottom}
        />
      ) : null}
    </div>
  );
}

export const ConversationTimeline = memo(ConversationTimelineImpl);
