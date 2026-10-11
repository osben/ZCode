import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ToolSummaryRow, type ToolSummaryAction } from "@/ToolCallBlocks/ToolSummaryRow.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

const toolLayoutOpenState = new Map<string, boolean>();
// In-memory diagnostic counter: this map only grows per toolId; log it first.
uiMemoryDiagnosticsRegistry.register("toolLayout", () => ({ openState: toolLayoutOpenState.size }));
const TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;
const TOOL_CONTENT_SHELL_CLASSNAME = "text-popover-foreground outline-none";
const TOOL_CONTENT_SPACING_CLASSNAME = "pt-2";

interface ToolLayoutProps {
  toolId: string;
  persistOpenKey?: string;
  icon: ReactNode;
  showIcon?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  autoOpen?: boolean;
  autoCollapseOnComplete?: boolean;
  kindLabel: ReactNode;
  expandedKindLabel?: ReactNode;
  kindDetail?: ReactNode;
  expandedKindDetail?: ReactNode;
  sourceLabel?: ReactNode;
  primaryText: ReactNode;
  prioritizePrimaryText?: boolean;
  expandedPrimaryText?: ReactNode;
  secondaryText?: ReactNode;
  expandedSecondaryText?: ReactNode;
  summaryContentSeparator?: ReactNode;
  animateSummaryContent?: boolean;
  disableSummaryContentAnimation?: boolean;
  summaryContentKey?: string;
  summaryContentRefreshVersion?: string;
  hideSecondaryTextWhenOpen?: boolean;
  diffCount?: ReactNode;
  hideDiffCountWhenOpen?: boolean;
  statusLabel?: ReactNode;
  statusTooltip?: ReactNode;
  /**
   * An indicator before the status word (such as the hollow ring in a compile feedback row) appears and disappears with the word. Keep it outside the tooltip trigger:
   * the dotted underline and hover hint belong to the word; the indicator should not be underlined or become another hover target.
   */
  statusIndicator?: ReactNode;
  showStatusLabel?: boolean;
  showFailureStatus?: boolean;
  isRunning?: boolean;
  title?: string;
  expandedTitle?: string;
  content?: ReactNode;
  renderContent?: () => ReactNode;
  summaryAction?: ToolSummaryAction;
}

function ToolLayoutComponent({
  toolId,
  persistOpenKey,
  icon,
  showIcon = true,
  canToggle = true,
  forceOpen = false,
  autoOpen = false,
  autoCollapseOnComplete = false,
  kindLabel,
  expandedKindLabel,
  kindDetail,
  expandedKindDetail,
  sourceLabel,
  primaryText,
  prioritizePrimaryText = false,
  expandedPrimaryText,
  secondaryText,
  expandedSecondaryText,
  summaryContentSeparator,
  animateSummaryContent = false,
  disableSummaryContentAnimation = false,
  summaryContentKey,
  summaryContentRefreshVersion,
  hideSecondaryTextWhenOpen = false,
  diffCount,
  hideDiffCountWhenOpen = false,
  statusLabel,
  statusTooltip,
  statusIndicator,
  showStatusLabel = false,
  showFailureStatus = false,
  isRunning = false,
  title,
  expandedTitle,
  content,
  renderContent,
  summaryAction,
}: ToolLayoutProps) {
  const { intl } = useZCodeIntl();
  const resolvedPersistOpenKey = persistOpenKey ?? toolId;
  const [isOpen, setIsOpen] = useState(
    () => toolLayoutOpenState.get(resolvedPersistOpenKey) ?? false,
  );
  const hasSummaryAction = summaryAction !== undefined;
  const isExpanded = !hasSummaryAction && (forceOpen || (canToggle && isOpen));
  const [shouldRenderContent, setShouldRenderContent] = useState(isExpanded);
  const [isFailureTooltipCopied, setIsFailureTooltipCopied] = useState(false);
  const failureTooltipCopyResetRef = useRef<number | null>(null);
  const contentUnmountDelayRef = useRef<number | null>(null);
  const hasAutoOpenedRef = useRef(false);
  const previousIsRunningRef = useRef(isRunning);
  const shouldShowStatusLabel = (showStatusLabel || showFailureStatus) && statusLabel != null;
  const shouldRenderResolvedContent = !hasSummaryAction && (isExpanded || shouldRenderContent);
  const resolvedContent = shouldRenderResolvedContent
    ? (renderContent?.() ?? content ?? null)
    : null;
  const summaryPrimaryText =
    isExpanded && expandedPrimaryText != null ? expandedPrimaryText : primaryText;
  const summaryKindLabel = isExpanded && expandedKindLabel != null ? expandedKindLabel : kindLabel;
  const summaryKindDetail =
    isExpanded && expandedKindDetail !== undefined ? expandedKindDetail : kindDetail;
  const summarySecondaryText =
    isExpanded && expandedSecondaryText !== undefined
      ? expandedSecondaryText
      : isExpanded && hideSecondaryTextWhenOpen
        ? null
        : secondaryText;
  const summaryTitle = isExpanded && expandedTitle !== undefined ? expandedTitle : title;
  const resolvedSummaryContentKey =
    summaryContentKey ?? `${String(summaryTitle ?? "")}:${String(statusLabel ?? "")}`;
  const shouldShowDiffCount = diffCount != null && !(isExpanded && hideDiffCountWhenOpen);
  // Many tool calls update continuously while streaming, so spinning loading icons
  // would consume rendering resources for a long time; use a text shimmer and status label while running, and keep the icon static.
  const summaryIcon = icon;
  // Keep the kind label shimmer while running to show that the tool is still active;
  // outside the running state, retain the faintest text color so the summary stays understated.
  const kindLabelClassName = cn(
    "font-medium whitespace-nowrap shrink-0",
    isRunning ? "animated-gradient-text" : "text-foreground-subtlest",
  );

  useEffect(() => {
    const persistedOpen = toolLayoutOpenState.get(resolvedPersistOpenKey);
    setIsOpen(persistedOpen ?? false);
  }, [resolvedPersistOpenKey]);

  useEffect(() => {
    // Tools such as edit/read should expand by default when completed,
    // but forceOpen locks the card so it cannot be collapsed.
    // Use a one-time autoOpen instead: expand once when the condition is first met, then let the user close it manually.
    if (!autoOpen || hasAutoOpenedRef.current) {
      return;
    }

    toolLayoutOpenState.set(resolvedPersistOpenKey, true);
    setShouldRenderContent(true);
    setIsOpen(true);
    hasAutoOpenedRef.current = true;
  }, [autoOpen, resolvedPersistOpenKey]);

  useEffect(() => {
    const wasRunning = previousIsRunningRef.current;
    previousIsRunningRef.current = isRunning;

    // If a subagent stays expanded after completion, its long list of tool details remains open,
    // quickly lengthening the conversation and conflicting with the interaction of expanding while running and returning to a summary when complete.
    // Collapse once only on the running -> completed transition; the user can still expand it again later.
    if (autoCollapseOnComplete && !isRunning && wasRunning) {
      toolLayoutOpenState.set(resolvedPersistOpenKey, false);
      setIsOpen(false);
    }
  }, [autoCollapseOnComplete, isRunning, resolvedPersistOpenKey]);

  useEffect(() => {
    if (isExpanded) {
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

    // Do not unmount children immediately when collapsing tool details.
    // Radix reads --radix-collapsible-content-height during the closed animation;
    // if child content is removed first, the inner height variable disappears and inherits the outer historical message height,
    // briefly stretching the details area into a huge blank block and making everything below appear to vanish.
    contentUnmountDelayRef.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      contentUnmountDelayRef.current = null;
    }, TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);

    return () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
    };
  }, [isExpanded, shouldRenderContent]);

  useEffect(() => {
    return () => {
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
      }
    };
  }, []);

  const handleCopyFailureTooltip = () => {
    if (typeof statusTooltip !== "string" || statusTooltip.trim().length === 0) {
      return;
    }

    navigator.clipboard.writeText(statusTooltip).then(() => {
      setIsFailureTooltipCopied(true);
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      failureTooltipCopyResetRef.current = window.setTimeout(() => {
        setIsFailureTooltipCopied(false);
        failureTooltipCopyResetRef.current = null;
      }, 1500);
    });
  };

  const statusWordNode =
    shouldShowStatusLabel && statusLabel != null ? (
      statusTooltip ? (
        // Failed cards no longer force their content open; show error details in the status label tooltip instead,
        // keeping edit cards' expansion behavior consistent with success while still exposing the error on hover.
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="whitespace-nowrap underline decoration-dotted underline-offset-2 cursor-help">
                {statusLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-96">
              <div className="flex max-w-96 items-center gap-2">
                <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {statusTooltip}
                </span>
                {typeof statusTooltip === "string" && statusTooltip.trim().length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-md"
                    className="shrink-0"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCopyFailureTooltip();
                    }}
                    title={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                    aria-label={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                  >
                    {isFailureTooltipCopied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                ) : null}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span className="whitespace-nowrap">{statusLabel}</span>
      )
    ) : null;
  const statusNode =
    statusWordNode !== null && statusIndicator != null ? (
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {statusIndicator}
        {statusWordNode}
      </span>
    ) : (
      statusWordNode
    );

  return (
    <Collapsible
      open={!hasSummaryAction && (forceOpen || (canToggle && isOpen))}
      onOpenChange={(open) => {
        if (hasSummaryAction || forceOpen) {
          return;
        }
        toolLayoutOpenState.set(resolvedPersistOpenKey, open);
        if (open) {
          setShouldRenderContent(true);
        }
        setIsOpen(open);
      }}
      className="w-full flex flex-col"
    >
      <ToolSummaryRow
        action={summaryAction}
        animateContent={animateSummaryContent}
        canToggle={canToggle}
        contentKey={resolvedSummaryContentKey}
        contentRefreshVersion={summaryContentRefreshVersion}
        diffCount={shouldShowDiffCount ? diffCount : undefined}
        disableContentAnimation={disableSummaryContentAnimation}
        forceOpen={forceOpen}
        icon={summaryIcon}
        isExpanded={isExpanded}
        kindDetail={summaryKindDetail}
        kindLabel={summaryKindLabel}
        kindLabelClassName={kindLabelClassName}
        primaryText={summaryPrimaryText}
        prioritizePrimaryText={prioritizePrimaryText}
        secondaryText={summarySecondaryText}
        separator={summaryContentSeparator}
        showIcon={showIcon}
        sourceLabel={sourceLabel}
        statusNode={statusNode}
        title={summaryTitle}
        toggleAriaLabel={intl.formatMessage({
          id: isExpanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
        })}
        toolId={toolId}
      />
      {!hasSummaryAction && canToggle ? (
        <CollapsibleContent className={TOOL_CONTENT_SHELL_CLASSNAME}>
          {/* When padding is attached directly to the height-animation node, the body still stops at 8px after its height reaches zero,
              and disappears suddenly only when delayed unmount switches display:none. Moving it inside lets the outer overflow
              clip it continuously to zero with the animation, preserving the original spacing and the 300ms measurement safeguard. */}
          <div className={TOOL_CONTENT_SPACING_CLASSNAME}>{resolvedContent}</div>
        </CollapsibleContent>
      ) : !hasSummaryAction && forceOpen ? (
        <div className={cn(TOOL_CONTENT_SHELL_CLASSNAME, TOOL_CONTENT_SPACING_CLASSNAME)}>
          {resolvedContent}
        </div>
      ) : null}
    </Collapsible>
  );
}

export const ToolLayout = memo(ToolLayoutComponent);
ToolLayout.displayName = "ToolLayout";
