/**
 * Composer chip for a ChatGPT plan model (specs/chatgpt-plan-signin.md "Usage across the app"): the plan and its
 * tightest usage window, with the full usage block on hover. It is the "Using ChatGPT plan" indicator.
 */
import { useEffect, useRef, useState } from "react";
import type { SiwcPlanUsageSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { ChatGptPlanUsageBlock } from "@/settings/model-provider-section/ChatGptPlanUsageBlock.js";
import {
  usageHeadline,
  usagePlanLabel,
  type UsageSeverity,
} from "@/settings/model-provider-section/chatgptPlanUsage.js";

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export const CHATGPT_USAGE_SEVERITY_TEXT: Record<UsageSeverity, string> = {
  normal: "text-foreground-subtle",
  warning: "text-warning",
  critical: "text-destructive",
};

export function ChatGptPlanUsageChip({
  usage,
  nowMs,
}: {
  usage: SiwcPlanUsageSnapshot;
  nowMs: number;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // A modal menu opened while the card is open (the model picker sits next to the chip) blocks the
  // pointerleave that would close it, so any press outside the chip and its card closes it.
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || contentRef.current?.contains(target)))
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, [open]);
  const plan =
    usagePlanLabel(usage.planType) ??
    intl.formatMessage({ id: "chat.toolbar.chatgptUsage.planFallback" });
  const headline = usageHeadline(usage, nowMs);
  const severity: UsageSeverity =
    headline.kind === "limit"
      ? "critical"
      : headline.kind === "window"
        ? headline.severity
        : "normal";
  const detail =
    headline.kind === "limit"
      ? intl.formatMessage({ id: "chat.toolbar.chatgptUsage.limitReached" })
      : headline.kind === "pending"
        ? intl.formatMessage({ id: "chat.toolbar.chatgptUsage.updating" })
        : intl.formatMessage(
            { id: "settings.modelProvider.chatgpt.usage.left" },
            { percent: headline.remaining },
          );
  const text = `${plan} · ${detail}`;
  const severityWord = intl.formatMessage({
    id: `settings.modelProvider.chatgpt.usage.severity.${severity}`,
  });
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        // The open delay can fire after the pointer already moved on (for example straight into the
        // model picker); open only while the chip is still hovered or focused.
        const trigger = triggerRef.current;
        if (next && trigger && !trigger.matches(":hover") && trigger !== document.activeElement)
          return;
        setOpen(next);
      }}
      openDelay={150}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-testid="chatgpt-plan-usage-chip"
          data-severity={severity}
          aria-label={`${text}, ${severityWord}`}
          className={cn(
            "inline-flex h-6 max-w-48 shrink-0 items-center truncate rounded-md px-1.5 text-ui-sm tabular-nums hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary",
            CHATGPT_USAGE_SEVERITY_TEXT[severity],
          )}
        >
          {text}
        </button>
      </HoverCardTrigger>
      <HoverCardContent ref={contentRef} side="top" align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "chat.toolbar.chatgptUsage.title" }, { plan })}
          </div>
          <ChatGptPlanUsageBlock usage={usage} nowMs={nowMs} />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => void platform.openExternal(CHATGPT_USAGE_URL)}
          >
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.manageUsage" })}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
