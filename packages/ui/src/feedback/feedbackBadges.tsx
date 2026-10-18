import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import type { FeedbackTicketStatus } from "@zcode/shared";
import { formatFeedbackStatusLabel, STATUS_META } from "@/feedback/feedbackMeta.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function StatusIndicator({
  status,
  withDot = true,
  children,
  className,
}: {
  status: FeedbackTicketStatus;
  withDot?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const meta = STATUS_META[status];
  const { intl } = useZCodeIntl();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-ui-base font-medium",
        meta.className,
        className,
      )}
    >
      {withDot ? <span className={cn("size-1.5 rounded-full", meta.dot)} /> : null}
      {children ?? formatFeedbackStatusLabel(status, intl.formatMessage)}
    </span>
  );
}

export function FeedbackErrorTip({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span className="break-words leading-relaxed">{message}</span>
    </div>
  );
}
