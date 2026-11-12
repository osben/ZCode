/*
 * Derived from vercel/ai-elements (packages/elements/src/reasoning.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { SummaryPreviewContext } from "@/v4/conversationRowContext.js";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import { TID_CHAT_REASONING_CONTENT, TID_CHAT_REASONING_TRIGGER } from "@zcode/shared/test-ids";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { QueuedSummaryContent } from "@/ToolCallBlocks/QueuedSummaryContent.js";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { useBottomFollowingScroll } from "@/mentions/components/scrollMask.js";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  shouldRenderContent: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  autoCollapseKey?: string | number | null;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const MS_IN_S = 1000;
const REASONING_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;

export function shouldAutoCollapseReasoning({
  autoCollapseKey,
  previousAutoCollapseKey,
  userInteracted,
}: {
  autoCollapseKey: string | number | null | undefined;
  previousAutoCollapseKey: string | number | null | undefined;
  userInteracted: boolean;
}) {
  return autoCollapseKey != null && autoCollapseKey !== previousAutoCollapseKey && !userInteracted;
}

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    autoCollapseKey = null,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const preview = useContext(SummaryPreviewContext);
    const isOpenControlled = preview || open !== undefined;
    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: preview ? false : open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const startTimeRef = useRef<number | null>(null);
    const contentUnmountDelayRef = useRef<number | null>(null);
    const userInteractedRef = useRef(false);
    const previousAutoCollapseKeyRef = useRef<string | number | null>(null);
    const [shouldRenderContent, setShouldRenderContent] = useState(() => isOpen);
    const handleOpenChange = useCallback(
      (nextOpen: boolean) => {
        userInteractedRef.current = true;
        if (nextOpen) {
          setShouldRenderContent(true);
        }
        setIsOpen(nextOpen);
      },
      [setIsOpen],
    );

    useEffect(() => {
      if (!isStreaming) {
        if (startTimeRef.current !== null) {
          setDuration(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S)));
        }
        startTimeRef.current = null;
        return;
      }

      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }

      // In the collapsed state, show a streaming summary without rerendering the whole reasoning block every second for a hidden elapsed time.
      // When expanded, calculate from the same start time and keep updating it.
      if (!isOpen) {
        return;
      }

      const updateDuration = () => {
        if (startTimeRef.current === null) {
          return;
        }
        setDuration(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S)));
      };

      updateDuration();
      const durationTimer = window.setInterval(updateDuration, MS_IN_S);
      return () => window.clearInterval(durationTimer);
    }, [isOpen, isStreaming, setDuration]);

    useEffect(() => {
      const previousAutoCollapseKey = previousAutoCollapseKeyRef.current;
      previousAutoCollapseKeyRef.current = autoCollapseKey;

      if (isOpenControlled) {
        return;
      }

      // The output boundary is an additional signal to collapse after completion; automatic rules must not override the user's manual choice.
      if (
        shouldAutoCollapseReasoning({
          autoCollapseKey,
          previousAutoCollapseKey,
          userInteracted: userInteractedRef.current,
        })
      ) {
        setIsOpen(false);
      }
    }, [autoCollapseKey, isOpenControlled, setIsOpen]);

    useEffect(() => {
      if (isOpen) {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
          contentUnmountDelayRef.current = null;
        }
        setShouldRenderContent(true);
        return;
      }

      if (!shouldRenderContent) {
        return;
      }

      // Do not unmount children immediately when reasoning is collapsed. Radix's height animation needs
      // access to the real content height during the closed phase; finish the 300ms collapse before unmounting the heavy DOM.
      contentUnmountDelayRef.current = window.setTimeout(() => {
        setShouldRenderContent(false);
        contentUnmountDelayRef.current = null;
      }, REASONING_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);

      return () => {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
          contentUnmountDelayRef.current = null;
        }
      };
    }, [isOpen, shouldRenderContent]);

    useEffect(() => {
      return () => {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
        }
      };
    }, []);

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen, shouldRenderContent }),
      [duration, isOpen, isStreaming, setIsOpen, shouldRenderContent],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose min-w-0 flex flex-col", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
  streamingText?: string;
};

export function scrollReasoningSummaryToEnd(
  viewport: Pick<HTMLElement, "scrollLeft" | "scrollWidth">,
) {
  viewport.scrollLeft = viewport.scrollWidth;
}

export function isReasoningSummaryOverflowing({
  clientWidth,
  scrollWidth,
}: Pick<HTMLElement, "clientWidth" | "scrollWidth">) {
  return scrollWidth > clientWidth + 1;
}

export function resolveReasoningStreamingSummary(
  streamingText: string,
): { key: string; text: string } | null {
  const lines = streamingText.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]?.trim() ?? "";
    if (text.length > 0) {
      return { key: String(index), text };
    }
  }
  return null;
}

const REASONING_SUMMARY_MASK =
  "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

export function getReasoningSummaryMaskStyle(isOverflowing: boolean): CSSProperties | undefined {
  if (!isOverflowing) {
    return undefined;
  }
  return {
    WebkitMaskImage: REASONING_SUMMARY_MASK,
    maskImage: REASONING_SUMMARY_MASK,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    streamingText = "",
    ...props
  }: ReasoningTriggerProps) => {
    const preview = useContext(SummaryPreviewContext);
    const { isStreaming, isOpen, duration } = useReasoning();
    const { intl } = useZCodeIntl();
    const streamingSummary =
      isStreaming && !isOpen ? resolveReasoningStreamingSummary(streamingText) : null;
    const streamingSummaryRef = useRef<HTMLSpanElement | null>(null);
    const streamingSummaryTextRef = useRef<HTMLSpanElement | null>(null);
    const [isStreamingSummaryOverflowing, setIsStreamingSummaryOverflowing] = useState(false);

    useEffect(() => {
      const viewport = streamingSummaryRef.current;
      if (!viewport || !streamingSummary) {
        return;
      }

      const syncSummaryViewport = () => {
        const next = isReasoningSummaryOverflowing(viewport);
        if (next !== isStreamingSummaryOverflowing) setIsStreamingSummaryOverflowing(next);
        // When a streaming summary exceeds available width, ordinary overflow-hidden keeps showing the old prefix
        // and clips the latest token on the right. After content grows, move the single-line viewport to the end so old content shifts left.
        scrollReasoningSummaryToEnd(viewport);
      };

      syncSummaryViewport();
      if (typeof ResizeObserver === "undefined") {
        return;
      }
      const resizeObserver = new ResizeObserver(syncSummaryViewport);
      resizeObserver.observe(viewport);
      if (streamingSummaryTextRef.current) {
        resizeObserver.observe(streamingSummaryTextRef.current);
      }
      return () => resizeObserver.disconnect();
    }, [streamingSummary?.text, isStreamingSummaryOverflowing]);

    // 末尾思考完成后，未闭合的收起组头仍需扫光；保留真实完成文案和耗时。
    const thoughtLabelClassName = cn(
      "font-normal text-foreground-subtle",
      preview && "animated-gradient-text animated-gradient-text-foreground",
    );
    const thinkingMessage =
      getThinkingMessage?.(isStreaming, duration) ??
      (isStreaming && !isOpen ? (
        <span className="animated-gradient-text animated-gradient-text-foreground font-normal text-foreground-subtle">
          {intl.formatMessage({ id: "chat.reasoning.thinking" })}
        </span>
      ) : duration === undefined ? (
        <span className="inline-flex items-center gap-2">
          <span className={thoughtLabelClassName}>
            {intl.formatMessage({ id: "chat.reasoning.thought" })}
          </span>
          <span className="font-normal text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.reasoning.durationFewSeconds" })}
          </span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className={thoughtLabelClassName}>
            {intl.formatMessage({ id: "chat.reasoning.thought" })}
          </span>
          <span className="font-normal text-foreground-subtlest">
            {intl.formatPlural({ id: "chat.reasoning.durationSeconds" }, duration)}
          </span>
        </span>
      ));

    const summaryClassName = cn(
      "summary-hover-text group/reasoning inline-flex max-w-full min-w-0 items-center gap-2 self-start text-ui-base transition-colors",
      className,
    );
    const summaryContent = (
      <>
        {children ?? (
          <>
            {/* Thinking can remain visible during long streaming replies, so a rotating loader would consume rendering resources for a long time.
            Keep the text shimmer while running, and use a static thinking icon. */}
            <BrainIcon
              data-summary-leading-icon
              className="size-4 shrink-0 text-foreground-subtle group-hover/reasoning:text-foreground"
            />
            {/* The streaming summary on the right can shrink; if the label on the left also shrinks,
                a long summary can wrap the Thinking label onto multiple lines. Keep the semantic label fixed-width and let only the summary use the remaining space. */}
            <span className="shrink-0 whitespace-nowrap" data-reasoning-label="true">
              {thinkingMessage}
            </span>
            {streamingSummary ? (
              <span
                ref={streamingSummaryRef}
                className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-foreground-subtlest"
                data-reasoning-streaming-mask={isStreamingSummaryOverflowing ? "both" : "none"}
                data-reasoning-streaming-line="true"
                data-reasoning-streaming-roll="true"
                style={getReasoningSummaryMaskStyle(isStreamingSummaryOverflowing)}
              >
                <QueuedSummaryContent
                  contentKey={`reasoning-line:${streamingSummary.key}`}
                  contentRefreshVersion={streamingSummary.text}
                  primaryText={
                    <span
                      ref={streamingSummaryTextRef}
                      className="inline-block min-w-max"
                      data-reasoning-streaming-text="true"
                    >
                      {streamingSummary.text}
                    </span>
                  }
                  enabled={!preview}
                />
              </span>
            ) : null}
            {!preview ? (
              <ChevronRightIcon
                data-summary-chevron
                className={cn(
                  "size-4 shrink-0 text-foreground-subtlest transition-opacity transition-transform",
                  isOpen
                    ? "rotate-90 opacity-100"
                    : "rotate-0 opacity-0 group-hover/reasoning:opacity-100",
                )}
              />
            ) : null}
          </>
        )}
      </>
    );
    if (preview) return <div className={summaryClassName}>{summaryContent}</div>;
    return (
      <CollapsibleTrigger
        data-testid={TID_CHAT_REASONING_TRIGGER}
        className={summaryClassName}
        {...props}
      >
        {summaryContent}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
  variant?: "default" | "nested";
};

export const ReasoningContent = memo(
  ({ className, children, forceMount, variant = "default", ...props }: ReasoningContentProps) => {
    const { isOpen, shouldRenderContent } = useReasoning();
    const shouldRenderChildren = isOpen || shouldRenderContent || Boolean(forceMount);
    const {
      scrollRef,
      contentRef,
      onScroll: handleScroll,
      maskData: scrollMaskData,
      maskStyle: scrollMaskStyle,
    } = useBottomFollowingScroll(shouldRenderChildren, children);

    return (
      <CollapsibleContent
        data-reasoning-content="true"
        data-reasoning-content-variant={variant}
        data-testid={TID_CHAT_REASONING_CONTENT}
        forceMount={forceMount}
        className={className}
        {...props}
      >
        {shouldRenderChildren ? (
          <div className="pt-3">
            <div
              ref={scrollRef}
              className={cn(
                "max-h-60 space-y-2 overflow-auto text-ui-base text-foreground-subtlest",
                // CUA Group already provides a clear parent boundary; another left guide/indent for nested reasoning would duplicate the hierarchy.
                variant === "default" && "ml-2 border-border border-l pl-3.5",
              )}
              data-reasoning-scroll-mask={scrollMaskData}
              onScroll={handleScroll}
              style={scrollMaskStyle}
            >
              {/* Previously, opening the thinking block mounted Radix content on demand and forced forceMount,
                  so the content’s first frame was already open and the height animation could not transition from closed, making it appear to open suddenly.
                  Keep this consistent with tool detailsconsistent: CollapsibleContent handles only Presence/height animation, while heavy content is unmounted separately after a delay;
                  put spacing inside the animated content so removing the parent gap/padding at the end of a closed animation does not cause a final-frame jump.
                  Performance fix: thought content can be very long and stream in incrementally. If expanded content continues through MessageResponse/Streamdown,
                  each chunk reruns Markdown parsing and plugin rendering, and performance worsens as the text grows. Render plain text here and preserve line breaks. */}
              <div
                ref={contentRef}
                className="min-w-0 whitespace-pre-wrap break-words text-foreground-subtlest"
              >
                {children}
              </div>
            </div>
          </div>
        ) : null}
      </CollapsibleContent>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
