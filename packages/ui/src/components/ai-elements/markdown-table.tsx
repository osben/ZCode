"use client";

import type {
  ComponentProps,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeftFromLine,
  ArrowRightToLine,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type MarkdownTableNodeProp = {
  node?: unknown;
};

type MarkdownTableEdgeShadowState = "none" | "left" | "right" | "both";

export type MarkdownTableRows = string[][];

type MarkdownTableFrameDistances = {
  leftDistance: number;
  maxLeftOffset: number;
  scrollbarWidth: number;
  rightDistance: number;
  maxViewportWidth: number;
};

type MarkdownTableVirtualScrollbarMetrics = {
  contentWidth: number;
  thumbLeft: number;
  thumbWidth: number;
};

type MarkdownTableObservedRect = {
  left: number;
  right: number;
  width: number;
};

const MARKDOWN_TABLE_ROOT_SELECTOR =
  '[data-markdown-table-layout-root="true"], [data-testid="chat-view"]';
const MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR = '[data-markdown-table-sticky-scrollbar="disabled"]';
const MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR = '[data-v4-composer-dock="true"]';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR =
  '[data-v4-back-to-bottom-anchor="composer-dock"] button';
const MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX = 8;
const MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX = 32;
const MARKDOWN_TABLE_CONTENT_PADDING_LG_PX = 16;
const MARKDOWN_TABLE_CONTENT_PADDING_MD_PX = 8;
const MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO = 0.8;
const MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY = "--markdown-table-layout-left-inset";
const MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY = "--markdown-table-layout-right-inset";

function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeCsvCell(value: string): string {
  // Assistant Markdown is untrusted input. Excel/Numbers/LibreOffice interpret formula prefixes
  // when opening CSV files, so downgrade formula-like cells to plain text before download.
  const safeValue = /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] ?? "")),
  );
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);

  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  // A Blob charset does not affect file bytes. Excel parses UTF-8 CSV without a BOM using the local code page,
  // producing mojibake; add a UTF-8 BOM so spreadsheet software reliably detects the encoding.
  return `\uFEFF${csv}`;
}

function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) {
    return [];
  }

  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        normalizeTableCellText(cell.textContent ?? ""),
      ),
    )
    .filter((row) => row.length > 0);
}

function resolveMarkdownTableRoot(
  frame: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  // V4 no longer renders data-testid="chat-view" after removing the legacy ChatView, so the table falls back to its own width
  // and incorrectly concludes that enhanced horizontal scrolling provides no benefit. Prefer the explicit cross-version layout boundary; keep the legacy selector only for compatibility.
  return frame?.closest<HTMLElement>(MARKDOWN_TABLE_ROOT_SELECTOR) ?? fallbackRoot;
}

function getMarkdownTableContentInlineInsetPx() {
  if (typeof window === "undefined") {
    return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
  }

  // When the table borrows space to the right of the ChatView root, subtract the message column's responsive right padding.
  // This matches px-8 max-lg:px-4 max-md:px-2 on ChatConversationContent.
  if (window.innerWidth < 768) {
    return MARKDOWN_TABLE_CONTENT_PADDING_MD_PX;
  }

  if (window.innerWidth < 1024) {
    return MARKDOWN_TABLE_CONTENT_PADDING_LG_PX;
  }

  return MARKDOWN_TABLE_CONTENT_PADDING_DEFAULT_PX;
}

function getMarkdownTableRootInlineInsets(root: HTMLElement) {
  if (typeof window !== "undefined" && root.matches('[data-markdown-table-layout-root="true"]')) {
    return {
      leftInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_LEFT_INSET_PROPERTY),
      rightInset: readCssPixelValue(root, MARKDOWN_TABLE_LAYOUT_RIGHT_INSET_PROPERTY),
    };
  }

  const legacyInset = getMarkdownTableContentInlineInsetPx();
  return { leftInset: legacyInset, rightInset: legacyInset };
}

function readMarkdownTableObservedRect(
  element: HTMLElement | null,
): MarkdownTableObservedRect | null {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
  };
}

function isMarkdownTableObservedRectEqual(
  leftRect: MarkdownTableObservedRect | null,
  rightRect: MarkdownTableObservedRect | null,
) {
  return (
    leftRect?.left === rightRect?.left &&
    leftRect?.right === rightRect?.right &&
    leftRect?.width === rightRect?.width
  );
}

function readCssPixelValue(element: HTMLElement | null, propertyName: string) {
  if (!element || typeof window === "undefined") {
    return 0;
  }

  const value = window.getComputedStyle(element).getPropertyValue(propertyName);
  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
}

function readMarkdownTableDockHeight(root: HTMLElement | null) {
  const legacyDockHeight = readCssPixelValue(root, "--chat-bottom-dock-height");
  if (legacyDockHeight > 0) return legacyDockHeight;

  // The V4 composer dock is inside the timeline scroll viewport but no longer sets the legacy ChatView
  // CSS variable. Read the actual dock height directly so the bottom-pinned scrollbar is not covered by the input area.
  return (
    root
      ?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR)
      ?.getBoundingClientRect().height ?? 0
  );
}

function readMarkdownTableBackToBottomClearance(root: HTMLElement | null) {
  const button = root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_SELECTOR);
  if (!button) return 0;

  return button.getBoundingClientRect().height + MARKDOWN_TABLE_V4_BACK_TO_BOTTOM_GAP_PX;
}

function resolveMarkdownTableVerticalViewport(
  element: HTMLElement | null,
  fallbackRoot: HTMLElement | null,
): HTMLElement | null {
  if (typeof window === "undefined") {
    return fallbackRoot;
  }

  let currentElement = element?.parentElement ?? null;
  while (currentElement) {
    const style = window.getComputedStyle(currentElement);
    const canScrollY = /auto|scroll|overlay/u.test(style.overflowY);
    // Because of overflow-x-auto, the browser may compute overflow-y as auto for a horizontally scrolling viewport.
    // Without confirming there is actual vertical scroll space, a short table may mistake its own height for the viewport height, making the 80% check always pass.
    const hasVerticalScrollRange = currentElement.scrollHeight > currentElement.clientHeight + 1;
    if (canScrollY && currentElement.clientHeight > 0 && hasVerticalScrollRange) {
      return currentElement;
    }
    currentElement = currentElement.parentElement;
  }

  return fallbackRoot;
}

export function resolveMarkdownTableStickyScrollbarMode({
  stickyScrollbarDisabled,
  viewportHeight,
  dockHeight,
  tableHeight,
}: {
  stickyScrollbarDisabled: boolean;
  viewportHeight: number;
  dockHeight: number;
  tableHeight: number;
}) {
  if (stickyScrollbarDisabled) {
    return false;
  }

  const visibleHeight = Math.max(0, viewportHeight - dockHeight);
  return (
    visibleHeight > 0 && tableHeight > visibleHeight * MARKDOWN_TABLE_STICKY_SCROLLBAR_HEIGHT_RATIO
  );
}

export function resolveMarkdownTableStickyScrollbarOffset({
  frameTop,
  frameBottom,
  scrollbarHeight,
  viewportBottom,
}: {
  frameTop: number;
  frameBottom: number;
  scrollbarHeight: number;
  viewportBottom: number;
}) {
  const minimumBottom = Math.min(frameBottom, frameTop + Math.max(0, scrollbarHeight));
  const pinnedBottom = Math.min(frameBottom, Math.max(minimumBottom, viewportBottom));
  return Math.min(0, pinnedBottom - frameBottom);
}

function shouldUseMarkdownTableStickyScrollbar({
  root,
  table,
}: {
  root: HTMLElement | null;
  table: HTMLTableElement | null;
}) {
  if (!table) {
    return false;
  }

  const viewport = resolveMarkdownTableVerticalViewport(table, root);
  const viewportHeight =
    viewport?.clientHeight ||
    viewport?.getBoundingClientRect().height ||
    (typeof window === "undefined" ? 0 : window.innerHeight);
  const dockHeight = readMarkdownTableDockHeight(root);
  const tableHeight = table.getBoundingClientRect().height;

  // Subagent prompts/output inherit the session dock height. If sticky is also enabled, the virtual scrollbar
  // is incorrectly lifted to the middle of the table inside the nested container. Explicitly opt out regardless of whether the container currently has vertical overflow.
  return resolveMarkdownTableStickyScrollbarMode({
    stickyScrollbarDisabled: table.closest(MARKDOWN_TABLE_STICKY_DISABLED_SELECTOR) !== null,
    viewportHeight,
    dockHeight,
    tableHeight,
  });
}

export function resolveMarkdownTableFrameDistances({
  frameWidth,
  frameLeft,
  frameRight,
  rootLeft,
  rootRight,
  leftInset = 0,
  rightInset = 0,
}: {
  frameWidth: number;
  frameLeft: number;
  frameRight: number;
  rootLeft: number;
  rootRight: number;
  leftInset?: number;
  rightInset?: number;
}): MarkdownTableFrameDistances {
  const leftDistance = Math.max(0, frameLeft - rootLeft);
  const rightDistance = Math.max(0, rootRight - frameRight);
  const maxLeftOffset = Math.max(0, leftDistance - leftInset);
  const scrollbarWidth = Math.max(0, frameWidth + rightDistance - rightInset);

  return {
    leftDistance,
    maxLeftOffset,
    scrollbarWidth,
    rightDistance,
    maxViewportWidth: scrollbarWidth,
  };
}

export function resolveMarkdownTableVirtualScrollbarMetrics({
  scrollLeft,
  scrollMax,
  tableWidth,
  trackWidth,
}: {
  scrollLeft: number;
  scrollMax: number;
  tableWidth: number;
  trackWidth: number;
}): MarkdownTableVirtualScrollbarMetrics {
  const safeTableWidth = Math.max(0, tableWidth);
  const safeTrackWidth = Math.max(0, trackWidth);
  const safeScrollMax = Math.max(0, scrollMax);
  const contentWidth = Math.max(safeTrackWidth, safeTableWidth);

  if (safeTrackWidth <= 0 || safeScrollMax <= 1 || safeTableWidth <= safeTrackWidth) {
    return {
      contentWidth: safeTrackWidth,
      thumbLeft: 0,
      thumbWidth: safeTrackWidth,
    };
  }

  const thumbWidth = Math.min(
    safeTrackWidth,
    Math.max(0, safeTrackWidth * (safeTrackWidth / safeTableWidth)),
  );
  const maxThumbLeft = Math.max(0, safeTrackWidth - thumbWidth);
  const thumbLeft = Math.min(
    maxThumbLeft,
    Math.max(0, Math.max(0, scrollLeft) * (safeTrackWidth / safeTableWidth)),
  );

  return {
    contentWidth,
    thumbLeft,
    thumbWidth,
  };
}

export function resolveMarkdownTableVirtualScrollMax({
  tableWidth,
  trackWidth,
}: {
  tableWidth: number;
  trackWidth: number;
}): number {
  return Math.max(0, tableWidth - trackWidth);
}

export type MarkdownTableProps = ComponentProps<"table"> & MarkdownTableNodeProp;

export function MarkdownTable({ className, children, node: _node, ...props }: MarkdownTableProps) {
  const { intl } = useZCodeIntl();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expandedScrollEnabled, setExpandedScrollEnabled] = useState(false);
  const [canToggleExpandedScroll, setCanToggleExpandedScroll] = useState(false);
  const [edgeShadowState, setEdgeShadowState] = useState<MarkdownTableEdgeShadowState>("none");
  const [viewportMaxWidth, setViewportMaxWidth] = useState<string>("100%");
  const [scrollbarWidth, setScrollbarWidth] = useState<string>("100%");
  const [viewportLeftOffset, setViewportLeftOffset] = useState(0);
  const [virtualScrollbarSticky, setVirtualScrollbarSticky] = useState(false);
  const [virtualScrollbarVisible, setVirtualScrollbarVisible] = useState(false);
  const [virtualScrollThumbStyle, setVirtualScrollThumbStyle] = useState<CSSProperties>({
    transform: "translateX(0px)",
    width: "100%",
  });
  const edgeShadowStateRef = useRef<MarkdownTableEdgeShadowState>("none");
  const expandedScrollEnabledRef = useRef(expandedScrollEnabled);
  const canToggleExpandedScrollRef = useRef(canToggleExpandedScroll);
  const viewportMaxWidthRef = useRef(viewportMaxWidth);
  const scrollbarWidthRef = useRef(scrollbarWidth);
  const viewportLeftOffsetRef = useRef(viewportLeftOffset);
  const virtualScrollbarStickyRef = useRef(virtualScrollbarSticky);
  const virtualScrollbarVisibleRef = useRef(virtualScrollbarVisible);
  const maxViewportLeftOffsetRef = useRef(0);
  const virtualScrollTrackWidthRef = useRef(0);
  const virtualScrollLeftRef = useRef(0);
  const virtualScrollThumbLeftRef = useRef(0);
  const virtualScrollThumbStyleRef = useRef(virtualScrollThumbStyle);
  const isVirtualScrollbarDraggingRef = useRef(false);
  const virtualScrollbarDragOffsetRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollTrackRef = useRef<HTMLDivElement | null>(null);
  const virtualScrollbarWrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const setNextEdgeShadowState = useCallback(
    (nextEdgeShadowState: MarkdownTableEdgeShadowState) => {
      if (edgeShadowStateRef.current === nextEdgeShadowState) {
        return;
      }

      edgeShadowStateRef.current = nextEdgeShadowState;
      setEdgeShadowState(nextEdgeShadowState);
    },
    [],
  );
  const commitExpandedScrollEnabled = useCallback((nextExpandedScrollEnabled: boolean) => {
    if (expandedScrollEnabledRef.current === nextExpandedScrollEnabled) {
      return;
    }

    expandedScrollEnabledRef.current = nextExpandedScrollEnabled;
    setExpandedScrollEnabled(nextExpandedScrollEnabled);
  }, []);
  const commitCanToggleExpandedScroll = useCallback((nextCanToggleExpandedScroll: boolean) => {
    if (canToggleExpandedScrollRef.current === nextCanToggleExpandedScroll) {
      return;
    }

    canToggleExpandedScrollRef.current = nextCanToggleExpandedScroll;
    setCanToggleExpandedScroll(nextCanToggleExpandedScroll);
  }, []);
  const commitViewportMaxWidth = useCallback((nextViewportMaxWidth: string) => {
    if (viewportMaxWidthRef.current === nextViewportMaxWidth) {
      return;
    }

    viewportMaxWidthRef.current = nextViewportMaxWidth;
    setViewportMaxWidth(nextViewportMaxWidth);
  }, []);
  const commitScrollbarWidth = useCallback((nextScrollbarWidth: string) => {
    if (scrollbarWidthRef.current === nextScrollbarWidth) {
      return;
    }

    scrollbarWidthRef.current = nextScrollbarWidth;
    setScrollbarWidth(nextScrollbarWidth);
  }, []);
  const commitViewportLeftOffset = useCallback((nextViewportLeftOffset: number) => {
    if (viewportLeftOffsetRef.current === nextViewportLeftOffset) {
      return;
    }

    viewportLeftOffsetRef.current = nextViewportLeftOffset;
    setViewportLeftOffset(nextViewportLeftOffset);
  }, []);
  const commitVirtualScrollbarSticky = useCallback((nextVirtualScrollbarSticky: boolean) => {
    if (virtualScrollbarStickyRef.current === nextVirtualScrollbarSticky) {
      return;
    }

    virtualScrollbarStickyRef.current = nextVirtualScrollbarSticky;
    setVirtualScrollbarSticky(nextVirtualScrollbarSticky);
  }, []);
  const commitVirtualScrollbarVisible = useCallback((nextVirtualScrollbarVisible: boolean) => {
    if (virtualScrollbarVisibleRef.current === nextVirtualScrollbarVisible) {
      return;
    }

    virtualScrollbarVisibleRef.current = nextVirtualScrollbarVisible;
    setVirtualScrollbarVisible(nextVirtualScrollbarVisible);
  }, []);
  const commitVirtualScrollThumbStyle = useCallback(
    (nextVirtualScrollThumbStyle: CSSProperties) => {
      const currentStyle = virtualScrollThumbStyleRef.current;
      if (
        currentStyle.width === nextVirtualScrollThumbStyle.width &&
        currentStyle.transform === nextVirtualScrollThumbStyle.transform
      ) {
        return;
      }

      virtualScrollThumbStyleRef.current = nextVirtualScrollThumbStyle;
      setVirtualScrollThumbStyle(nextVirtualScrollThumbStyle);
    },
    [],
  );
  const resolveTableWidth = useCallback((viewport: HTMLDivElement) => {
    return tableRef.current?.getBoundingClientRect().width ?? viewport.scrollWidth;
  }, []);
  const resolveVirtualScrollLayoutWidth = useCallback((viewport: HTMLDivElement) => {
    return virtualScrollTrackWidthRef.current || viewport.clientWidth;
  }, []);
  const resolveRenderedVirtualScrollTrackWidth = useCallback(
    (viewport: HTMLDivElement) => {
      const trackWidth = virtualScrollTrackRef.current?.getBoundingClientRect().width ?? 0;
      if (trackWidth > 0) {
        return trackWidth;
      }

      return resolveVirtualScrollLayoutWidth(viewport);
    },
    [resolveVirtualScrollLayoutWidth],
  );
  const resolveVirtualScrollMax = useCallback(
    (viewport: HTMLDivElement) => {
      // Total virtual scroll distance should depend only on the table element's width minus the scrollbar track width.
      // Including viewportLeftOffset made left borrowing change the maximum, desynchronizing the thumb from content scroll progress.
      // A conditionally mounted DOM track uses CSS width; if its precision differs from the saved floating-point layout width,
      // visibility can oscillate around the same threshold. Always measure overflow against the same stable track width for a given layout pass.
      return resolveMarkdownTableVirtualScrollMax({
        tableWidth: resolveTableWidth(viewport),
        trackWidth: resolveVirtualScrollLayoutWidth(viewport),
      });
    },
    [resolveTableWidth, resolveVirtualScrollLayoutWidth],
  );
  const commitVirtualScrollLeft = useCallback(
    (nextVirtualScrollLeft: number) => {
      const viewport = scrollViewportRef.current;
      if (!viewport) {
        virtualScrollLeftRef.current = 0;
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const clampedVirtualScrollLeft = Math.min(
        Math.max(0, nextVirtualScrollLeft),
        virtualScrollMax,
      );
      const nextViewportLeftOffset = Math.min(
        clampedVirtualScrollLeft,
        maxViewportLeftOffsetRef.current,
      );
      const nextViewportScrollLeft = clampedVirtualScrollLeft - nextViewportLeftOffset;

      virtualScrollLeftRef.current = clampedVirtualScrollLeft;
      commitViewportLeftOffset(nextViewportLeftOffset);
      viewport.scrollLeft = nextViewportScrollLeft;
    },
    [commitViewportLeftOffset, resolveVirtualScrollMax],
  );
  const syncVirtualScrollMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollThumbStyle({
        transform: "translateX(0px)",
        width: "100%",
      });
      virtualScrollLeftRef.current = 0;
      virtualScrollThumbLeftRef.current = 0;
      return;
    }

    const virtualScrollMax = resolveVirtualScrollMax(viewport);
    // A virtual scrollbar is useful only when the table is wider than the visible track; rendering a pill for a small table
    // would mislead users into thinking there is more horizontal content to scroll.
    commitVirtualScrollbarVisible(virtualScrollMax > 1);
    const nextVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    const clampedVirtualScrollLeft = Math.min(Math.max(0, nextVirtualScrollLeft), virtualScrollMax);
    if (clampedVirtualScrollLeft !== nextVirtualScrollLeft) {
      // Collapsing/expanding the status panel or resizing the window changes the track width, and the old virtual scroll position may exceed the new bounds.
      // Write the clamped value back through the shared entry point immediately so the thumb and content do not end up at different positions.
      commitVirtualScrollLeft(clampedVirtualScrollLeft);
      return;
    }

    virtualScrollLeftRef.current = clampedVirtualScrollLeft;
    // The rendered track's actual width is used only for thumb size and position; it must not determine whether the track is mounted.
    const virtualScrollViewportWidth = resolveRenderedVirtualScrollTrackWidth(viewport);
    const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
      scrollLeft: clampedVirtualScrollLeft,
      scrollMax: virtualScrollMax,
      tableWidth: resolveTableWidth(viewport),
      trackWidth: virtualScrollViewportWidth,
    });
    commitVirtualScrollThumbStyle({
      transform: `translateX(${Math.round(metrics.thumbLeft)}px)`,
      width: `${Math.ceil(metrics.thumbWidth)}px`,
    });
    virtualScrollThumbLeftRef.current = metrics.thumbLeft;
  }, [
    commitVirtualScrollLeft,
    commitVirtualScrollbarVisible,
    commitVirtualScrollThumbStyle,
    resolveTableWidth,
    resolveVirtualScrollMax,
    resolveRenderedVirtualScrollTrackWidth,
  ]);
  const measureViewportMaxWidth = useCallback(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      commitCanToggleExpandedScroll(false);
      commitVirtualScrollbarVisible(false);
      commitVirtualScrollbarSticky(false);
      maxViewportLeftOffsetRef.current = 0;
      virtualScrollTrackWidthRef.current = 0;
      commitViewportLeftOffset(0);
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    let maxLeftOffset = 0;
    let maxViewportWidth = frameRect.width;
    let measuredScrollbarWidth = frameRect.width;
    let expandedMaxLeftOffset = 0;
    let expandedScrollbarWidth = frameRect.width;

    if (root) {
      const rootRect = root.getBoundingClientRect();
      // V4's expansion boundary is the full timeline viewport, not the centered message column. The explicit root
      // provides responsive safe margins through CSS variables; legacy roots keep the existing compatibility rule.
      const { leftInset, rightInset } = getMarkdownTableRootInlineInsets(root);
      const measuredDistances = resolveMarkdownTableFrameDistances({
        frameWidth: frameRect.width,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
        leftInset,
        rightInset,
      });
      expandedMaxLeftOffset = measuredDistances.maxLeftOffset;
      expandedScrollbarWidth = measuredDistances.scrollbarWidth;

      if (expandedScrollEnabledRef.current) {
        maxLeftOffset = measuredDistances.maxLeftOffset;
        maxViewportWidth = measuredDistances.maxViewportWidth;
        measuredScrollbarWidth = measuredDistances.scrollbarWidth;
      }
    }

    const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 0;
    const hasFrameHorizontalOverflow = tableWidth > frameRect.width + 1;
    const hasExpandedScrollBenefit =
      expandedScrollbarWidth > frameRect.width + 1 || expandedMaxLeftOffset > 1;
    // The toggle is useful only when content overflows horizontally at the normal frame width and enhanced mode adds visible width or left borrowing.
    // Keep the button visible when enabled so users can return to the normal scroll range.
    commitCanToggleExpandedScroll(
      expandedScrollEnabledRef.current || (hasFrameHorizontalOverflow && hasExpandedScrollBenefit),
    );

    maxViewportLeftOffsetRef.current = maxLeftOffset;
    virtualScrollTrackWidthRef.current = measuredScrollbarWidth;
    commitViewportMaxWidth(`${Math.ceil(maxViewportWidth)}px`);
    // Rounding up can make a mounted track up to 1px wider than the track width used for overflow detection.
    // Subpixel overflow near the 1px threshold can then mount/unmount the track every frame and disturb timeline height.
    commitScrollbarWidth(`${measuredScrollbarWidth}px`);
    commitVirtualScrollbarSticky(
      shouldUseMarkdownTableStickyScrollbar({
        root,
        table: tableRef.current,
      }),
    );
    if (scrollViewportRef.current) {
      commitVirtualScrollLeft(virtualScrollLeftRef.current);
    } else {
      commitViewportLeftOffset(Math.min(viewportLeftOffsetRef.current, maxLeftOffset));
    }
    syncVirtualScrollMetrics();
  }, [
    commitScrollbarWidth,
    commitCanToggleExpandedScroll,
    commitVirtualScrollLeft,
    commitVirtualScrollbarSticky,
    commitVirtualScrollbarVisible,
    commitViewportLeftOffset,
    commitViewportMaxWidth,
    syncVirtualScrollMetrics,
  ]);

  const measureEdgeShadowState = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const maxScrollLeft = resolveVirtualScrollMax(viewport);
    if (maxScrollLeft <= 1) {
      setNextEdgeShadowState("none");
      return;
    }

    const currentVirtualScrollLeft = viewportLeftOffsetRef.current + viewport.scrollLeft;
    // Left borrowing expands the table area to the left; it does not mean table content is clipped on the left side of the scroll container.
    // Show the left shadow only after internal scrollLeft becomes nonzero; continue basing the right shadow on total virtual progress.
    const hasHiddenLeft = viewport.scrollLeft > 1;
    const hasHiddenRight = currentVirtualScrollLeft < maxScrollLeft - 1;
    setNextEdgeShadowState(
      hasHiddenLeft && hasHiddenRight
        ? "both"
        : hasHiddenLeft
          ? "left"
          : hasHiddenRight
            ? "right"
            : "none",
    );
  }, [resolveVirtualScrollMax, setNextEdgeShadowState]);
  const latestMeasureEdgeShadowStateRef = useRef(measureEdgeShadowState);

  useEffect(() => {
    latestMeasureEdgeShadowStateRef.current = measureEdgeShadowState;
  });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!root || !frame || !viewport || !table) {
      commitViewportMaxWidth("100%");
      commitScrollbarWidth("100%");
      return;
    }

    // Lay out the table viewport at its natural content width first, then expand it at most to the current frame width
    // plus borrowable space on the right; w-full would remove the content-sized layout behavior for small tables.
    let rafId: number | null = null;
    let rectWatchRafId: number | null = null;
    let rectWatchUntil = 0;
    let latestRootRect = readMarkdownTableObservedRect(root);
    let latestFrameRect = readMarkdownTableObservedRect(frame);
    const scheduleMeasure = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestRootRect = readMarkdownTableObservedRect(root);
        latestFrameRect = readMarkdownTableObservedRect(frame);
        measureViewportMaxWidth();
        latestMeasureEdgeShadowStateRef.current();
      });
    };
    const watchRectChanges = () => {
      rectWatchRafId = null;
      const nextRootRect = readMarkdownTableObservedRect(root);
      const nextFrameRect = readMarkdownTableObservedRect(frame);
      const rectChanged =
        !isMarkdownTableObservedRectEqual(latestRootRect, nextRootRect) ||
        !isMarkdownTableObservedRectEqual(latestFrameRect, nextFrameRect);

      if (rectChanged) {
        // Collapsing/expanding the status panel may change only the chat root's left/right position,
        // which may not trigger ResizeObserver. Polling the rect signature keeps left/right borrowing and track width in sync with layout animation.
        latestRootRect = nextRootRect;
        latestFrameRect = nextFrameRect;
        scheduleMeasure();
      }

      if (performance.now() < rectWatchUntil) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const scheduleMeasureAndWatchRect = () => {
      scheduleMeasure();
      rectWatchUntil = performance.now() + 800;
      if (rectWatchRafId === null) {
        rectWatchRafId = requestAnimationFrame(watchRectChanges);
      }
    };
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasureAndWatchRect);
    mutationObserver?.observe(root, {
      attributeFilter: ["style"],
      attributes: true,
    });

    measureViewportMaxWidth();
    scheduleMeasureAndWatchRect();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasureAndWatchRect);
      return () => {
        window.removeEventListener("resize", scheduleMeasureAndWatchRect);
        mutationObserver?.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
      };
    }

    const resizeObserver = new ResizeObserver(scheduleMeasureAndWatchRect);
    resizeObserver.observe(root);
    resizeObserver.observe(frame);
    resizeObserver.observe(viewport);
    resizeObserver.observe(table);
    window.addEventListener("resize", scheduleMeasureAndWatchRect);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasureAndWatchRect);
      mutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (rectWatchRafId !== null) cancelAnimationFrame(rectWatchRafId);
    };
  }, [commitScrollbarWidth, commitViewportMaxWidth, measureViewportMaxWidth]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const table = tableRef.current;
    if (!viewport || !table) {
      setNextEdgeShadowState("none");
      return;
    }

    const updateViewportLayout = () => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    };
    const updateEdgeShadowState = () => {
      syncVirtualScrollMetrics();
      latestMeasureEdgeShadowStateRef.current();
    };
    const handleWheel = (event: WheelEvent) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) {
        return;
      }

      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      if (virtualScrollMax <= 1) {
        return;
      }

      event.preventDefault();
      // Left borrowing and table-content scrolling used to track positions separately, which overwrote each other at boundaries and prevented scrolling back.
      // Map through virtual scrollLeft now: consume leftOffset first, then apply the remainder to the real viewport.scrollLeft.
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      updateViewportLayout();
    };

    // Performance fix: the p12 trace showed that streaming table-child changes recreated the observer and synchronously read layout.
    // Bind the observer lifetime only to the DOM node; let ResizeObserver batch content changes into the next-frame measurement.
    let rafId: number | null = null;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateEdgeShadowState();
      });
    };

    updateEdgeShadowState();
    viewport.addEventListener("scroll", updateEdgeShadowState, {
      passive: true,
    });
    viewport.addEventListener("wheel", handleWheel, { passive: false });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateEdgeShadowState);
        viewport.removeEventListener("wheel", handleWheel);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(table);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateEdgeShadowState);
      viewport.removeEventListener("wheel", handleWheel);
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    commitVirtualScrollLeft,
    measureViewportMaxWidth,
    resolveVirtualScrollMax,
    setNextEdgeShadowState,
    syncVirtualScrollMetrics,
  ]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const table = tableRef.current;
    const wrapper = virtualScrollbarWrapperRef.current;
    const root = resolveMarkdownTableRoot(frame, rootRef.current);
    if (!frame || !table || !wrapper || !virtualScrollbarSticky) {
      if (wrapper) wrapper.style.transform = "";
      return;
    }

    const verticalViewport = resolveMarkdownTableVerticalViewport(table, root);
    if (!verticalViewport) return;

    let rafId: number | null = null;
    let observedDock: HTMLElement | null = null;
    const updateStickyOffset = () => {
      rafId = null;
      const frameRect = frame.getBoundingClientRect();
      const viewportRect = verticalViewport.getBoundingClientRect();
      const dockHeight = readMarkdownTableDockHeight(root);
      // When scrolled away from the bottom, the "back to bottom" button sits above the composer dock. Subtracting only the dock
      // makes a long table's sticky scrollbar share the button's horizontal band, hiding the button behind the wide track.
      const backToBottomClearance = readMarkdownTableBackToBottomClearance(root);
      const offset = resolveMarkdownTableStickyScrollbarOffset({
        frameTop: frameRect.top,
        frameBottom: frameRect.bottom,
        scrollbarHeight: wrapper.getBoundingClientRect().height,
        viewportBottom: viewportRect.bottom - dockHeight - backToBottomClearance,
      });
      wrapper.style.transform = offset === 0 ? "" : `translateY(${Math.round(offset)}px)`;
    };
    const scheduleStickyOffset = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateStickyOffset);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleStickyOffset);
    const syncDockObservation = () => {
      const nextDock =
        root?.querySelector<HTMLElement>(MARKDOWN_TABLE_V4_COMPOSER_DOCK_SELECTOR) ?? null;
      // MutationObserver also detects when the back-to-bottom button inside the dock mounts/unmounts; schedule a geometry update even if the dock node itself does not change.
      if (nextDock === observedDock) {
        scheduleStickyOffset();
        return;
      }
      if (observedDock) resizeObserver?.unobserve(observedDock);
      observedDock = nextDock;
      if (observedDock) resizeObserver?.observe(observedDock);
      scheduleStickyOffset();
    };

    // V4 virtual rows are positioned with transforms, which constrain native sticky positioning to the natural position under a transformed ancestor.
    // Instead, calculate vertical compensation from timeline scroll while keeping it within the table's current top/bottom bounds.
    updateStickyOffset();
    verticalViewport.addEventListener("scroll", scheduleStickyOffset, { passive: true });
    window.addEventListener("resize", scheduleStickyOffset);
    resizeObserver?.observe(frame);
    resizeObserver?.observe(verticalViewport);
    syncDockObservation();
    // Switching draft/empty states conditionally mounts or replaces the V4 composer dock. Watching only the initial node means
    // increased input height in the new dock no longer triggers bottom-position recalculation, so track root subtree changes and rebind as needed.
    const dockMutationObserver =
      typeof MutationObserver === "undefined" || !root
        ? null
        : new MutationObserver(syncDockObservation);
    if (dockMutationObserver && root) {
      dockMutationObserver.observe(root, { childList: true, subtree: true });
    }

    return () => {
      verticalViewport.removeEventListener("scroll", scheduleStickyOffset);
      window.removeEventListener("resize", scheduleStickyOffset);
      resizeObserver?.disconnect();
      dockMutationObserver?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      wrapper.style.transform = "";
    };
  }, [virtualScrollbarSticky, virtualScrollbarVisible]);

  const getRows = useCallback(() => readRowsFromTable(tableRef.current), []);
  const commitVirtualScrollLeftFromClientX = useCallback(
    (clientX: number, thumbDragOffset: number | null = null) => {
      const track = virtualScrollTrackRef.current;
      const viewport = scrollViewportRef.current;
      if (!track || !viewport) return;

      const trackRect = track.getBoundingClientRect();
      const trackWidth = trackRect.width;
      const virtualScrollMax = resolveVirtualScrollMax(viewport);
      const metrics = resolveMarkdownTableVirtualScrollbarMetrics({
        scrollLeft: virtualScrollLeftRef.current,
        scrollMax: virtualScrollMax,
        tableWidth: resolveTableWidth(viewport),
        trackWidth,
      });
      const maxThumbLeft = Math.max(0, trackWidth - metrics.thumbWidth);
      const rawThumbLeft =
        thumbDragOffset === null
          ? clientX - trackRect.left - metrics.thumbWidth / 2
          : clientX - trackRect.left - thumbDragOffset;
      const nextThumbLeft = Math.min(maxThumbLeft, Math.max(0, rawThumbLeft));
      const nextVirtualScrollLeft =
        maxThumbLeft <= 0 ? 0 : (nextThumbLeft / maxThumbLeft) * virtualScrollMax;

      commitVirtualScrollLeft(nextVirtualScrollLeft);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveTableWidth, resolveVirtualScrollMax],
  );
  const handleVirtualScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = true;
      virtualScrollbarDragOffsetRef.current = null;
      event.currentTarget.setPointerCapture(event.pointerId);
      commitVirtualScrollLeftFromClientX(event.clientX);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      isVirtualScrollbarDraggingRef.current = false;
      virtualScrollbarDragOffsetRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const track = virtualScrollTrackRef.current;
      if (!track) return;

      const trackRect = track.getBoundingClientRect();
      isVirtualScrollbarDraggingRef.current = true;
      // The thumb is a child of the track; pointer-down on it must not bubble to the track's click-to-jump handler.
      // Record the pointer's offset within the thumb and preserve it while dragging to prevent the thumb from jumping to the center.
      virtualScrollbarDragOffsetRef.current = Math.max(
        0,
        event.clientX - trackRect.left - virtualScrollThumbLeftRef.current,
      );
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );
  const handleVirtualScrollbarThumbPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (!isVirtualScrollbarDraggingRef.current) return;

      commitVirtualScrollLeftFromClientX(event.clientX, virtualScrollbarDragOffsetRef.current);
    },
    [commitVirtualScrollLeftFromClientX],
  );
  const handleVirtualScrollbarThumbPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      handleVirtualScrollbarPointerEnd(event);
    },
    [handleVirtualScrollbarPointerEnd],
  );
  const handleVirtualScrollbarWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (horizontalDelta === 0) return;

      const viewport = scrollViewportRef.current;
      if (!viewport || resolveVirtualScrollMax(viewport) <= 1) return;

      event.preventDefault();
      commitVirtualScrollLeft(virtualScrollLeftRef.current + horizontalDelta);
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    },
    [commitVirtualScrollLeft, measureViewportMaxWidth, resolveVirtualScrollMax],
  );

  const handleCopyMarkdown = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage({ id: "markdownTable.copyFailed" }, { error: "clipboard-unavailable" }),
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(buildMarkdownTableText(getRows()));
      toast(intl.formatMessage({ id: "markdownTable.copySucceeded" }));
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "markdownTable.copyFailed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }, [getRows, intl]);

  const handleDownloadCsv = useCallback(() => {
    if (
      typeof document === "undefined" ||
      typeof Blob === "undefined" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      toast(intl.formatMessage({ id: "markdownTable.downloadFailed" }));
      return;
    }

    const blob = new Blob([buildCsvTableText(getRows())], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "table.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [getRows, intl]);
  const handleToggleExpandedScroll = useCallback(() => {
    const nextExpandedScrollEnabled = !expandedScrollEnabledRef.current;
    commitExpandedScrollEnabled(nextExpandedScrollEnabled);

    if (!nextExpandedScrollEnabled) {
      maxViewportLeftOffsetRef.current = 0;
      commitViewportLeftOffset(0);
      const viewport = scrollViewportRef.current;
      if (viewport) {
        // When leaving enhanced mode, left borrowing may have consumed part of the virtual scroll position.
        // Clear leftOffset first, then map the same virtual scrollLeft back to real scrollLeft so table content does not jump to the start.
        viewport.scrollLeft = virtualScrollLeftRef.current;
      }
    }

    requestAnimationFrame(() => {
      measureViewportMaxWidth();
      latestMeasureEdgeShadowStateRef.current();
    });
  }, [commitExpandedScrollEnabled, commitViewportLeftOffset, measureViewportMaxWidth]);

  const copyLabel = intl.formatMessage({ id: "markdownTable.copyMarkdown" });
  const downloadLabel = intl.formatMessage({ id: "markdownTable.downloadCsv" });
  const previewLabel = intl.formatMessage({ id: "markdownTable.openPreview" });
  const scrollModeLabel = intl.formatMessage({
    id: expandedScrollEnabled
      ? "markdownTable.collapseScrollMode"
      : "markdownTable.expandScrollMode",
  });
  const previewTitle = intl.formatMessage({ id: "markdownTable.previewTitle" });
  const previewDescription = intl.formatMessage({
    id: "markdownTable.previewDescription",
  });
  // viewportMaxWidth is the virtual track width used to calculate virtualScrollMax and the thumb.
  // The content layer translates left to borrow space, so add the borrowed width back on the right to keep the visible right edge from moving left.
  const contentViewportMaxWidth =
    viewportLeftOffset > 0
      ? `calc(${viewportMaxWidth} + ${Math.ceil(viewportLeftOffset)}px)`
      : viewportMaxWidth;

  return (
    <div ref={rootRef} className="my-0 flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-end gap-1" data-markdown-table-toolbar="">
        <MarkdownTableActionButton
          label={copyLabel}
          onClick={() => {
            void handleCopyMarkdown();
          }}
        >
          <CopyIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={downloadLabel} onClick={handleDownloadCsv}>
          <DownloadIcon className="size-3.5" />
        </MarkdownTableActionButton>
        <MarkdownTableActionButton label={previewLabel} onClick={() => setPreviewOpen(true)}>
          <Maximize2Icon className="size-3.5" />
        </MarkdownTableActionButton>
        {canToggleExpandedScroll ? (
          <MarkdownTableActionButton label={scrollModeLabel} onClick={handleToggleExpandedScroll}>
            {expandedScrollEnabled ? (
              <ArrowLeftFromLine className="size-3.5" />
            ) : (
              <ArrowRightToLine className="size-3.5" />
            )}
          </MarkdownTableActionButton>
        ) : null}
      </div>
      <div
        ref={frameRef}
        className="group/markdown-table-frame relative w-full"
        data-markdown-table-frame=""
        data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
      >
        <div
          className={cn(
            "min-w-full w-max",
            viewportLeftOffset <= 0 &&
              "transition-[max-width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={{
            maxWidth: contentViewportMaxWidth,
            transform: viewportLeftOffset > 0 ? `translateX(-${viewportLeftOffset}px)` : undefined,
          }}
        >
          <div
            // The table already uses edge shadows to indicate horizontal overflow; a system scrollbar would add visual noise at the bottom of the message block.
            // The outer width container is capped at frame width + rightDistance, and the scroll viewport fills that container.
            className="relative w-full overflow-hidden rounded-xl border border-border"
          >
            <div
              ref={scrollViewportRef}
              className="!scrollbar-hide w-full overflow-x-auto overflow-y-visible"
            >
              <table
                ref={tableRef}
                className={cn(
                  "w-max min-w-full border-separate border-spacing-0 text-ui-base",
                  className,
                )}
                {...props}
                data-streamdown="table"
              >
                {children}
              </table>
            </div>
            <MarkdownTableEdgeShadow side="left" state={edgeShadowState} />
            <MarkdownTableEdgeShadow side="right" state={edgeShadowState} />
          </div>
        </div>
        <div
          ref={virtualScrollbarWrapperRef}
          aria-hidden={!virtualScrollbarVisible}
          // Under V4 transformed virtual rows, sticky is simulated with relative + translateY, so computed position cannot express product semantics.
          // Expose explicit state for cross-implementation E2E and accessibility diagnostics.
          data-markdown-table-virtual-scroll-sticky={virtualScrollbarSticky ? "true" : "false"}
          data-markdown-table-virtual-scroll-visible={virtualScrollbarVisible ? "true" : "false"}
          // The scrollbar track width must be frameRect.width + rightDistance minus the message column's responsive right padding.
          // Long tables need horizontal scrolling during vertical reading; the sticky bottom must avoid the composer and bottom panel.
          // When overflow measurements change, toggle visibility only; keep the node and vertical space to avoid disturbing timeline height.
          style={{ width: scrollbarWidth }}
          className={cn(
            "pointer-events-none py-1 opacity-0 transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
            virtualScrollbarVisible
              ? "visible group-hover/markdown-table-frame:pointer-events-auto group-hover/markdown-table-frame:opacity-100"
              : "invisible",
            virtualScrollbarSticky && "relative z-20",
          )}
        >
          <div
            ref={virtualScrollTrackRef}
            aria-hidden="true"
            className="mt-1 h-3.5 w-full touch-none rounded-full bg-foreground/3"
            data-markdown-table-virtual-scroll-track=""
            onPointerCancel={handleVirtualScrollbarPointerEnd}
            onPointerDown={handleVirtualScrollbarPointerDown}
            onPointerMove={handleVirtualScrollbarPointerMove}
            onPointerUp={handleVirtualScrollbarPointerEnd}
            onWheel={handleVirtualScrollbarWheel}
          >
            <div
              className="h-3 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/40"
              onPointerCancel={handleVirtualScrollbarThumbPointerEnd}
              onPointerDown={handleVirtualScrollbarThumbPointerDown}
              onPointerMove={handleVirtualScrollbarThumbPointerMove}
              onPointerUp={handleVirtualScrollbarThumbPointerEnd}
              style={virtualScrollThumbStyle}
            />
          </div>
        </div>
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] w-max max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden rounded-2xl p-4 sm:max-h-[calc(100vh-8rem)] sm:max-w-[calc(100vw-8rem)] md:min-w-[640px] lg:min-w-[720px]">
          <DialogHeader className="pr-8">
            <DialogTitle>{previewTitle}</DialogTitle>
            <DialogDescription>{previewDescription}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-auto rounded-xl border border-border bg-background">
            <table
              className={cn(
                "w-max min-w-full border-separate border-spacing-0 text-ui-base [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background",
                className,
              )}
              {...props}
              data-streamdown="table-preview"
            >
              {children}
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MarkdownTableEdgeShadow({
  side,
  state,
}: {
  side: "left" | "right";
  state: MarkdownTableEdgeShadowState;
}) {
  const visible = state === side || state === "both";
  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-6",
        side === "left"
          ? "left-0 rounded-l-xl shadow-[inset_12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]"
          : "right-0 rounded-r-xl shadow-[inset_-12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]",
      )}
      data-markdown-table-edge-shadow={side}
    />
  );
}

function MarkdownTableActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <Button type="button" variant="ghost" size="icon-md" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

export type MarkdownTableHeaderProps = ComponentProps<"thead"> & MarkdownTableNodeProp;

export function MarkdownTableHeader({
  className,
  node: _node,
  ...props
}: MarkdownTableHeaderProps) {
  return <thead className={cn("", className)} {...props} />;
}

export type MarkdownTableBodyProps = ComponentProps<"tbody"> & MarkdownTableNodeProp;

export function MarkdownTableBody({ className, node: _node, ...props }: MarkdownTableBodyProps) {
  return <tbody className={cn("", className)} {...props} />;
}

export type MarkdownTableRowProps = ComponentProps<"tr"> & MarkdownTableNodeProp;

export function MarkdownTableRow({ className, node: _node, ...props }: MarkdownTableRowProps) {
  return (
    <tr
      className={cn("transition-colors last:[&>td]:border-b-0 hover:bg-hover/20", className)}
      {...props}
    />
  );
}

export type MarkdownTableHeadProps = ComponentProps<"th"> & MarkdownTableNodeProp;

export function MarkdownTableHead({ className, node: _node, ...props }: MarkdownTableHeadProps) {
  return (
    <th
      className={cn(
        "border-border border-b px-3 py-2 text-left font-normal text-foreground-subtlest min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}

export type MarkdownTableCellProps = ComponentProps<"td"> & MarkdownTableNodeProp;

export function MarkdownTableCell({ className, node: _node, ...props }: MarkdownTableCellProps) {
  return (
    <td
      className={cn(
        "border-border border-b px-3 py-2 text-foreground align-top min-w-16 max-w-md whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}
